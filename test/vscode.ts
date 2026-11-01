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

export const workspace = {
  getConfiguration: () => ({ get: (key: string) => config[key] }),
  getWorkspaceFolder: () => undefined,
  asRelativePath: (uri: unknown) => String(uri),
};

export const window = { showWarningMessage: () => Promise.resolve(undefined) };
