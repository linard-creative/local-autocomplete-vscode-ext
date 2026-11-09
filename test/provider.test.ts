import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ModelService } from '../src/models';
import { LocalInlineCompletionProvider } from '../src/provider';
import { commands, config, SymbolKind, TabInputText, window, workspace } from './vscode';

const log = { debug() {}, info() {}, warn() {} } as unknown as vscode.LogOutputChannel;
const text = 'function add(a: number, b: number) {\n  ';
const docAt = (path: string, body = text) =>
  ({
    languageId: 'typescript',
    fileName: path,
    uri: { scheme: 'file', path, toString: () => `file://${path}` },
    version: 1,
    getText: () => body,
    offsetAt: () => body.length,
    lineAt: (l: unknown) => ({ text: typeof l === 'number' ? body.split('\n')[l] : '  ' }),
  }) as unknown as vscode.TextDocument;
const doc = docAt('/w/a.ts');
const pos = { line: 1, character: 2 } as vscode.Position;
const ctx = {} as vscode.InlineCompletionContext;

function tokenSource() {
  const listeners = new Set<() => void>();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (fn: () => void) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
  };
  return {
    token: token as unknown as vscode.CancellationToken,
    cancel() {
      token.isCancellationRequested = true;
      listeners.forEach((fn) => fn());
    },
  };
}

/** Generate calls stay pending until `respond` is called, and reject like real fetch when aborted. */
let generates: { signal: AbortSignal; prompt: string; respond: (text: string) => void }[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.assign(config, { model: 'm:1b', debounceMs: 0, requestTimeoutMs: 5000 });
  generates = [];
  fetchMock = vi.fn((url: string, init: RequestInit) => {
    if (url.endsWith('/api/show')) return Promise.resolve(Response.json({ capabilities: ['completion', 'insert'] }));
    return new Promise((resolve, reject) => {
      const signal = init.signal!;
      signal.addEventListener('abort', () => reject(signal.reason));
      generates.push({
        signal,
        prompt: JSON.parse(String(init.body)).prompt,
        respond: (t) => resolve(Response.json({ response: t, done: true })),
      });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(config)) delete config[k];
  workspace.textDocuments = [];
  window.tabGroups.all = [];
  Object.assign(workspace, { openTextDocument: () => Promise.reject(new Error('not found')) });
  Object.assign(commands, { executeCommand: () => Promise.resolve(undefined) });
});

const openTabs = (...docs: vscode.TextDocument[]) => (window.tabGroups.all = [{ tabs: docs.map((d) => ({ input: new TabInputText(d.uri) })) }]);

function setup() {
  const models = new ModelService(log, () => {});
  return { models, provider: new LocalInlineCompletionProvider(log, models) };
}

describe('provider concurrency', () => {
  it('debounce collapses superseded calls into one request', async () => {
    config.debounceMs = 30;
    const { provider } = setup();
    const a = tokenSource();
    const b = tokenSource();
    const c = tokenSource();
    const pa = provider.provideInlineCompletionItems(doc, pos, ctx, a.token);
    a.cancel();
    const pb = provider.provideInlineCompletionItems(doc, pos, ctx, b.token);
    b.cancel();
    const pc = provider.provideInlineCompletionItems(doc, pos, ctx, c.token);
    await vi.waitFor(() => expect(generates).toHaveLength(1));
    generates[0].respond('return a + b;');
    expect(await pa).toBeUndefined();
    expect(await pb).toBeUndefined();
    expect((await pc)?.[0].insertText).toBe('return a + b;');
  });

  it('a newer request aborts the in-flight one', async () => {
    const { provider } = setup();
    const p1 = provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token);
    await vi.waitFor(() => expect(generates).toHaveLength(1));
    const p2 = provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token);
    await vi.waitFor(() => expect(generates).toHaveLength(2));
    expect(generates[0].signal.aborted).toBe(true);
    generates[1].respond('x');
    expect(await p1).toBeUndefined();
    expect((await p2)?.[0].insertText).toBe('x');
  });

  it('drops a late response after a model switch', async () => {
    const { provider } = setup();
    const p = provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token);
    await vi.waitFor(() => expect(generates).toHaveLength(1));
    config.model = 'other:7b';
    generates[0].respond('from old model');
    expect(await p).toBeUndefined();
  });

  it('backs off after a connection error instead of retrying on every keystroke', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    const { models, provider } = setup();
    await provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token);
    expect(models.lastError).toBe('connection');
    const calls = fetchMock.mock.calls.length;
    await provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('sends recent tabs that are still open, most recent last, never secrets, closed tabs or the current file', async () => {
    const { provider } = setup();
    const old = docAt('/w/old.ts', 'export const old = 1;\n');
    const restored = docAt('/w/types.ts', 'export type Id = string;\n');
    const closed = docAt('/w/closed.ts', 'closed\n');
    const env = docAt('/w/.env', 'TOKEN=hunter2\n');
    const outside = docAt('/elsewhere/x.ts', 'outside\n');
    // `restored` has a tab but is not loaded yet, as after a restart; `closed` is still loaded but has no tab.
    workspace.textDocuments = [old, closed, env, outside, doc];
    Object.assign(workspace, { openTextDocument: () => Promise.resolve(restored) });
    openTabs(old, restored, env, outside, doc);
    for (const d of [old, restored, closed, env, outside, doc]) provider.noteActive(d);
    config.recentTabsCount = 2;
    const p = provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token);
    await vi.waitFor(() => expect(generates).toHaveLength(1));
    expect(generates[0].prompt).toBe(
      '// File: old.ts (typescript)\nexport const old = 1;\n\n' +
        '// File: types.ts (typescript)\nexport type Id = string;\n\n' +
        '// File: a.ts (typescript)\n' +
        text,
    );
    generates[0].respond('x');
    await p;

    config.recentTabs = false;
    void provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token);
    await vi.waitFor(() => expect(generates).toHaveLength(2));
    expect(generates[1].prompt).toBe('// File: a.ts (typescript)\n' + text);
  });

  it('switches a recent tab from its head to its symbol outline once symbols arrive', async () => {
    const { provider } = setup();
    const types = docAt(
      '/w/types.ts',
      'import { db } from "./db";\nexport interface User {\n  id: string;\n}\nexport function load(id: string): User {\n  const row = db.get(id);\n  return row;\n}\n',
    );
    const sym = (line: number, kind: number, children: unknown[] = []) => ({ kind, selectionRange: { start: { line } }, children });
    const symbols = [sym(1, SymbolKind.Interface, [sym(2, 7)]), sym(4, SymbolKind.Function, [sym(5, SymbolKind.Variable)])];
    Object.assign(commands, { executeCommand: () => Promise.resolve(symbols) });
    workspace.textDocuments = [types, doc];
    openTabs(types, doc);
    provider.noteActive(types);
    provider.noteActive(doc);

    const p = provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token);
    await vi.waitFor(() => expect(generates).toHaveLength(1));
    expect(generates[0].prompt).toContain('const row = db.get(id);'); // head while symbols are pending
    generates[0].respond('x');
    await p;

    void provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token);
    await vi.waitFor(() => expect(generates).toHaveLength(2));
    expect(generates[1].prompt).toBe(
      '// File: types.ts (typescript)\nexport interface User {\n  id: string;\nexport function load(id: string): User {\n\n' +
        '// File: a.ts (typescript)\n' +
        text,
    );
  });

  it('retries a missing model after the backoff and resumes once it is installed', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ error: "model 'm:1b' not found" }, { status: 404 })));
    const { models, provider } = setup();
    await provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token);
    expect(models.missing).toBe('m:1b');
    const calls = fetchMock.mock.calls.length;
    await provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token);
    expect(fetchMock.mock.calls.length).toBe(calls); // backing off

    models.offlineUntil = 0; // backoff over; the user ran `ollama pull`
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(Response.json(url.endsWith('/api/show') ? { capabilities: ['insert'] } : { response: 'x', done: true })),
    );
    expect((await provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token))?.[0].insertText).toBe('x');
    expect(models.missing).toBeUndefined();
  });

  it('never completes in secret files', async () => {
    const { provider } = setup();
    expect(await provider.provideInlineCompletionItems(docAt('/w/.env.local'), pos, ctx, tokenSource().token)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a model as cold until it has answered', async () => {
    const { models, provider } = setup();
    expect(models.isCold('m:1b')).toBe(true);
    const p = provider.provideInlineCompletionItems(doc, pos, ctx, tokenSource().token);
    await vi.waitFor(() => expect(generates).toHaveLength(1));
    generates[0].respond('x');
    await p;
    expect(models.isCold('m:1b')).toBe(false);
  });
});
