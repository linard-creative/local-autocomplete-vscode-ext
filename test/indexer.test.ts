import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { gitignoreGlobs, isIndexable, WorkspaceIndexer } from '../src/indexer';
import { config, extensions, type RelativePattern, Uri, workspace } from './vscode';

describe('indexer helpers', () => {
  it('gitignoreGlobs turns simple lines into excludes and skips the rest', () => {
    // Braces would nest inside the combined {…} exclude and break it.
    expect(gitignoreGlobs('# c\n\nnode_modules/\n/dist\n*.log\nsrc/gen\n!keep.log\r\n*.{tmp,bak}\n')).toEqual([
      '**/node_modules',
      '**/node_modules/**',
      'dist',
      'dist/**',
      '**/*.log',
      '**/*.log/**',
      'src/gen',
      'src/gen/**',
    ]);
  });

  it('isIndexable rejects binaries and minified files', () => {
    expect(isIndexable('const a = 1;\n')).toBe(true);
    expect(isIndexable('a\0b')).toBe(false);
    expect(isIndexable('x'.repeat(5000))).toBe(false); // average line length > 200
  });
});

describe('WorkspaceIndexer lifecycle', () => {
  const INVOICE = 'export function computeInvoiceTotal(items: number[]): number {\n  return 0;\n}\n';
  const log = { info() {}, warn() {}, debug() {} } as unknown as vscode.LogOutputChannel;
  const uri = (path: string) => Uri.parse(`file://${path}`);
  /** Fake disk: absolute path → text. findFiles lists its .ts files and ignores the exclude glob. */
  const disk = new Map<string, string>();
  const watcher: Partial<Record<'change' | 'create' | 'delete', (u: unknown) => void>> = {};
  let finds: RelativePattern[];
  let busy: boolean;
  const stored = { ...workspace };

  beforeEach(() => {
    vi.useFakeTimers();
    disk.clear();
    finds = [];
    busy = false;
    extensions.all = [{ packageJSON: { contributes: { languages: [{ id: 'typescript', extensions: ['.ts'] }] } } }];
    const read = (u: { path: string }) => {
      const text = disk.get(u.path);
      if (text === undefined) throw new Error('not found');
      return text;
    };
    Object.assign(workspace, {
      workspaceFolders: [{ uri: uri('/w'), name: 'w', index: 0 }],
      // Lists the folder's files whose extension appears in the pattern (`**/*{.ts}`, `**/*.js`); ignores the exclude.
      findFiles: async (p: RelativePattern) => {
        finds.push(p);
        const base = (p.base as { uri: { path: string } }).uri.path;
        const exts = [...p.pattern.matchAll(/\.(\w+)/g)].map((m) => m[0]);
        return [...disk.keys()].filter((k) => k.startsWith(`${base}/`) && exts.some((e) => k.endsWith(e))).map(uri);
      },
      fs: {
        stat: async (u: { path: string }) => ({ size: read(u).length }),
        readFile: async (u: { path: string }) => new TextEncoder().encode(read(u)),
      },
      createFileSystemWatcher: () => ({
        onDidChange: (f: (u: unknown) => void) => (watcher.change = f),
        onDidCreate: (f: (u: unknown) => void) => (watcher.create = f),
        onDidDelete: (f: (u: unknown) => void) => (watcher.delete = f),
        dispose() {},
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.assign(workspace, stored);
    delete config.exclude;
  });

  const languages = (...langs: [string, string][]) =>
    (extensions.all = [{ packageJSON: { contributes: { languages: langs.map(([id, ext]) => ({ id, extensions: [ext] })) } } }]);

  const indexer = () => new WorkspaceIndexer(log, () => busy, () => {});
  const invoicePaths = async (ix: WorkspaceIndexer) =>
    (await ix.snippets('const t = computeInvoiceTotal(cart);\n', '', new Set())).files.map((f) => f.path);

  it('indexes the workspace after the start delay and serves a closed file’s definition', async () => {
    disk.set('/w/src/invoice.ts', INVOICE);
    const ix = indexer();
    ix.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(ix.status).toBe('Workspace: 1 files indexed');
    expect(await invoicePaths(ix)).toEqual(['src/invoice.ts']);
  });

  it('lists only files of known code languages, so the file cap is spent on code', async () => {
    const ix = indexer();
    ix.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(finds[0].pattern).toBe('**/*{.ts}');
  });

  it('stop and start while a completion is in flight does not leave the index stuck', async () => {
    disk.set('/w/src/invoice.ts', INVOICE);
    const ix = indexer();
    busy = true;
    ix.start();
    await vi.advanceTimersByTimeAsync(3100);
    expect(ix.status).toBe('Workspace: indexing 0/1 files');
    ix.stop();
    ix.start();
    await vi.advanceTimersByTimeAsync(3100); // the new run reaches its drain while the old loop still waits
    busy = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ix.status).toBe('Workspace: 1 files indexed');
  });

  it('a file rewritten into something unindexable stops serving its old definition', async () => {
    disk.set('/w/src/invoice.ts', INVOICE);
    const ix = indexer();
    ix.start();
    await vi.advanceTimersByTimeAsync(4000);
    disk.set('/w/src/invoice.ts', 'x'.repeat(5000)); // now minified
    watcher.change!(uri('/w/src/invoice.ts'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await invoicePaths(ix)).toEqual([]);
  });

  it('deleting a folder drops every file under it', async () => {
    disk.set('/w/legacy/invoice.ts', INVOICE);
    const ix = indexer();
    ix.start();
    await vi.advanceTimersByTimeAsync(4000);
    disk.delete('/w/legacy/invoice.ts');
    watcher.delete!(uri('/w/legacy'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await invoicePaths(ix)).toEqual([]);
    expect(ix.status).toBe('Workspace: 0 files indexed');
  });

  it('a burst of creates costs one findFiles per folder, and a renamed folder is picked up', async () => {
    disk.set('/w/old/invoice.ts', INVOICE);
    const ix = indexer();
    ix.start();
    await vi.advanceTimersByTimeAsync(4000);
    const before = finds.length;
    disk.delete('/w/old/invoice.ts');
    disk.set('/w/new/invoice.ts', INVOICE);
    for (let i = 0; i < 50; i++) disk.set(`/w/new/f${i}.ts`, `export const value${i} = ${i};\n`);
    watcher.delete!(uri('/w/old'));
    watcher.create!(uri('/w/new')); // a rename reports only the folder
    for (let i = 0; i < 50; i++) watcher.create!(uri(`/w/new/f${i}.ts`));
    await vi.advanceTimersByTimeAsync(2000);
    expect(finds.length - before).toBe(1);
    expect(await invoicePaths(ix)).toEqual(['new/invoice.ts']);
  });

  it('files with the same path in two workspace folders are both indexed', async () => {
    workspace.workspaceFolders = [
      { uri: uri('/a'), name: 'a' },
      { uri: uri('/b'), name: 'b' },
    ];
    disk.set('/a/src/invoice.ts', INVOICE);
    disk.set('/b/src/invoice.ts', 'export const other = 1;\n');
    const ix = indexer();
    ix.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(ix.status).toBe('Workspace: 2 files indexed');
    expect(await invoicePaths(ix)).toEqual(['a/src/invoice.ts']);
  });

  it('honors files.exclude `when` conditions: compiled .js next to its .ts is skipped', async () => {
    languages(['typescript', '.ts'], ['javascript', '.js']);
    config.exclude = { '**/*.js': { when: '$(basename).ts' } };
    disk.set('/w/src/invoice.ts', INVOICE);
    disk.set('/w/src/invoice.js', 'function computeInvoiceTotal(items) { return 0; }\n');
    disk.set('/w/src/lone.js', 'export function loneHelper() {}\n');
    const ix = indexer();
    ix.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(ix.status).toBe('Workspace: 2 files indexed');
  });

  it('picks up a newly installed language on the next start', async () => {
    disk.set('/w/src/tool.py', 'def compute_invoice_total(items):\n    return 0\n');
    const ix = indexer();
    ix.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(ix.status).toBe('Workspace: 0 files indexed');
    languages(['typescript', '.ts'], ['python', '.py']);
    ix.stop();
    ix.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(ix.status).toBe('Workspace: 1 files indexed');
  });

  it('a root .gitignore change restarts the index', async () => {
    disk.set('/w/src/invoice.ts', INVOICE);
    const ix = indexer();
    ix.start();
    await vi.advanceTimersByTimeAsync(4000);
    watcher.change!(uri('/w/.gitignore'));
    expect(ix.status).toBe('Workspace: starting');
    await vi.advanceTimersByTimeAsync(4000);
    expect(ix.status).toBe('Workspace: 1 files indexed');
  });
});

describe('relPath', () => {
  it('prefixes the folder name only in a multi-root workspace', async () => {
    const { relPath } = await import('../src/provider');
    const stored = workspace.workspaceFolders;
    const u = (p: string) => Uri.parse(`file://${p}`) as unknown as vscode.Uri;
    workspace.workspaceFolders = [{ uri: Uri.parse('file:///ws'), name: 'ws' }];
    expect(relPath(u('/ws/src/a.ts'))).toBe('src/a.ts');
    workspace.workspaceFolders = [
      { uri: Uri.parse('file:///ws'), name: 'ws' },
      { uri: Uri.parse('file:///other'), name: 'other' },
    ];
    expect(relPath(u('/ws/src/a.ts'))).toBe('ws/src/a.ts');
    workspace.workspaceFolders = stored;
  });
});
