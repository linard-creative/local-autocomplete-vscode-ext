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

export const Uri = {
  parse: (s: string) => {
    const path = s.replace(/^file:\/\//, '');
    return { scheme: s.split(':')[0], path, fsPath: path, toString: () => s };
  },
};

// Files under /w/ count as inside the workspace.
export const workspace = {
  getConfiguration: () => ({ get: (key: string) => config[key] }),
  textDocuments: [] as unknown[],
  openTextDocument: (() => Promise.reject(new Error('not found'))) as (uri: unknown) => Promise<unknown>,
  getWorkspaceFolder: (uri: { path: string }) => (uri.path.startsWith('/w/') ? {} : undefined),
  asRelativePath: (uri: { path: string }) => uri.path.slice(3),
};

export const window = {
  showWarningMessage: () => Promise.resolve(undefined),
  tabGroups: { all: [] as { tabs: { input: unknown }[] }[] },
};

export const commands = { executeCommand: (() => Promise.resolve(undefined)) as (...args: unknown[]) => Promise<unknown> };
