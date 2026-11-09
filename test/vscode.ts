import { posix } from 'node:path';

// Minimal runtime stand-in for the `vscode` module (aliased in vitest.config.ts); only what provider/models touch.
export const config: Record<string, unknown> = {};

export class Range {
  constructor(
    readonly start: unknown,
    readonly end: unknown,
  ) {}
}

export class InlineCompletionItem {
  constructor(
    readonly insertText: string,
    readonly range?: Range,
  ) {}
}

export const SymbolKind = { Module: 1, Namespace: 2, Class: 4, Method: 5, Enum: 9, Interface: 10, Function: 11, Variable: 12, Struct: 22 };

export class TabInputText {
  constructor(readonly uri: unknown) {}
}

export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string,
  ) {}
}

type StubUri = { scheme: string; path: string; fsPath: string; toString: () => string };

export const Uri = {
  parse: (s: string): StubUri => {
    const path = s.replace(/^file:\/\//, '');
    return { scheme: s.split(':')[0], path, fsPath: path, toString: () => s };
  },
  joinPath: (base: StubUri, ...parts: string[]) => Uri.parse(`file://${posix.normalize([base.path, ...parts].join('/'))}`),
};

type Folder = { uri: StubUri; name: string };
const folderOf = (uri: { path: string }) => workspace.workspaceFolders?.find((f) => uri.path.startsWith(`${f.uri.path}/`));

// Without workspaceFolders, files under /w/ count as inside the workspace. Indexer tests set folders, findFiles, fs and the watcher.
export const workspace = {
  getConfiguration: () => ({ get: (key: string) => config[key] }),
  textDocuments: [] as unknown[],
  openTextDocument: (() => Promise.reject(new Error('not found'))) as (uri: unknown) => Promise<unknown>,
  getWorkspaceFolder: (uri: { path: string }) => (workspace.workspaceFolders ? folderOf(uri) : uri.path.startsWith('/w/') ? {} : undefined),
  // Like VS Code: `true` always prefixes the folder name; the default does so only with more than one folder.
  asRelativePath: (uri: { path: string }, includeFolder?: boolean) => {
    const f = folderOf(uri);
    if (!f) return uri.path.slice(3);
    const rel = uri.path.slice(f.uri.path.length + 1);
    return (includeFolder ?? workspace.workspaceFolders!.length > 1) ? `${f.name}/${rel}` : rel;
  },
  workspaceFolders: undefined as Folder[] | undefined,
  findFiles: (() => Promise.resolve([])) as (...args: unknown[]) => Promise<unknown[]>,
  fs: {} as Record<string, (uri: StubUri) => Promise<unknown>>,
  createFileSystemWatcher: (() => ({})) as () => unknown,
};

export const extensions = { all: [] as unknown[] };

export const window = {
  showWarningMessage: () => Promise.resolve(undefined),
  tabGroups: { all: [] as { tabs: { input: unknown }[] }[] },
};

export const commands = { executeCommand: (() => Promise.resolve(undefined)) as (...args: unknown[]) => Promise<unknown> };
