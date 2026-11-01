import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ModelService } from '../src/models';
import { LocalInlineCompletionProvider } from '../src/provider';
import { config } from './vscode';

const log = { debug() {}, info() {}, warn() {} } as unknown as vscode.LogOutputChannel;
const text = 'function add(a: number, b: number) {\n  ';
const doc = {
  languageId: 'typescript',
  uri: { path: '/w/a.ts' },
  getText: () => text,
  offsetAt: () => text.length,
  lineAt: () => ({ text: '  ' }),
} as unknown as vscode.TextDocument;
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
let generates: { signal: AbortSignal; respond: (text: string) => void }[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.assign(config, { model: 'm:1b', debounceMs: 0, requestTimeoutMs: 5000 });
  generates = [];
  fetchMock = vi.fn((url: string, init: RequestInit) => {
    if (url.endsWith('/api/show')) return Promise.resolve(Response.json({ capabilities: ['completion', 'insert'] }));
    return new Promise((resolve, reject) => {
      const signal = init.signal!;
      signal.addEventListener('abort', () => reject(signal.reason));
      generates.push({ signal, respond: (t) => resolve(Response.json({ response: t, done: true })) });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(config)) delete config[k];
});

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
