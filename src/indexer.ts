import { basename, extname } from 'node:path';
import * as vscode from 'vscode';
import { isSecretFile } from './context';
import { settings } from './models';
import { fileHeader, type RecentFile } from './prompt';
import { relPath } from './provider';
import { sliceLines, WorkspaceIndex } from './retrieve';

const MAX_FILES = 5000;
const MAX_BYTES = 256 * 1024;
// Activation must stay fast (spec N4), so indexing waits until VS Code has settled.
const START_DELAY_MS = 3000;
// Between files, so indexing never keeps a core busy.
const PAUSE_MS = 5;
// A checkout or codegen creates files in bursts; one findFiles per folder per burst.
const CREATE_DEBOUNCE_MS = 500;
const BUILT_IN_EXCLUDE = ['node_modules', '.git', 'dist', 'out', 'build', 'target', 'vendor', '.venv', 'coverage'].map((d) => `**/${d}/**`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * Simple `.gitignore` lines as exclude globs: `dir/` → `**\/dir` and `**\/dir/**`, a leading or inner `/` anchors to the root.
 * shortcut: root .gitignore only, no negations; use findFiles2/useIgnoreFiles once it is stable API.
 */
export function gitignoreGlobs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\/+$/, ''))
    // Braces would nest inside the combined {…} exclude and break it.
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!') && !/[{}]/.test(l))
    .flatMap((l) => {
      const g = l.includes('/') ? l.replace(/^\//, '') : `**/${l}`;
      return [g, `${g}/**`];
    });
}

/** Not binary (no NUL in the first 8 KB) and not minified (average line ≤ 200 chars). */
export const isIndexable = (text: string): boolean =>
  !text.slice(0, 8192).includes('\0') && text.length / text.split('\n').length <= 200;

/** Extension → language id from every installed extension's `contributes.languages`, so no document has to be opened. */
function languageMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const ext of vscode.extensions.all) {
    const langs: unknown = ext.packageJSON?.contributes?.languages;
    if (!Array.isArray(langs)) continue;
    for (const lang of langs as { id?: unknown; extensions?: unknown }[]) {
      if (typeof lang.id !== 'string' || !Array.isArray(lang.extensions)) continue;
      for (const e of lang.extensions) if (typeof e === 'string' && !map.has(e.toLowerCase())) map.set(e.toLowerCase(), lang.id);
    }
  }
  return map;
}

/** Languages worth indexing: enabled, and with a line comment (no file header means recentBlock would drop the snippet). */
const indexable = (languageId: string) => !settings().disabledLanguages.includes(languageId) && !!fileHeader({ path: '', languageId });

/** Background workspace index (spec §10, Phase 9): reads one file per step, pauses while a completion is in flight. */
export class WorkspaceIndexer implements vscode.Disposable {
  private index = new WorkspaceIndex();
  /** Relative path → URI of every listed file (indexed or skipped), to read snippet text back and to spot new files. */
  private uris = new Map<string, vscode.Uri>();
  private queue: vscode.Uri[] = [];
  /** Bumped by stop(), so a running loop notices and exits. */
  private run = 0;
  /** The run whose drain loop is active, 0 for none. Per run, so a loop of a stopped run can't block the next one. */
  private draining = 0;
  private state: 'off' | 'starting' | 'indexing' | 'ready' = 'off';
  private total = 0;
  private done = 0;
  private limited = false;
  private timer?: ReturnType<typeof setTimeout>;
  private createTimer?: ReturnType<typeof setTimeout>;
  private created = new Map<string, vscode.WorkspaceFolder>();
  private watcher?: vscode.FileSystemWatcher;
  private excludes = new Map<string, string>();
  private languages?: Map<string, string>;
  /** Only code files are listed, so the file cap is spent on code. */
  private include = '';
  private last?: { key: string; result: { files: RecentFile[]; kinds: string } };

  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly isBusy: () => boolean,
    private readonly onProgress: () => void,
  ) {}

  get status(): string {
    if (this.state === 'off') return 'Workspace: off';
    if (this.state === 'starting') return 'Workspace: starting';
    if (this.state === 'indexing') return `Workspace: indexing ${this.done}/${this.total} files`;
    return `Workspace: ${this.index.size} files indexed${this.limited ? ' (limit reached)' : ''}`;
  }

  start(): void {
    if (this.state !== 'off' || !vscode.workspace.workspaceFolders?.length) return;
    this.state = 'starting';
    const run = ++this.run;
    this.timer = setTimeout(() => void this.build(run).catch(this.failed('build')), START_DELAY_MS);
    this.onProgress();
  }

  stop(): void {
    this.run++;
    clearTimeout(this.timer);
    clearTimeout(this.createTimer);
    this.created.clear();
    this.watcher?.dispose();
    this.watcher = undefined;
    this.index = new WorkspaceIndex();
    this.uris.clear();
    this.queue = [];
    this.last = undefined;
    this.state = 'off';
    this.total = this.done = 0;
    this.limited = false;
    this.onProgress();
  }

  dispose(): void {
    this.stop();
  }

  /** Snippet text for the current picks. Picks are deterministic, so unchanged picks return the same object without reading. */
  async snippets(prefix: string, window: string, exclude: ReadonlySet<string>): Promise<{ files: RecentFile[]; kinds: string }> {
    const hits = this.index.pick(prefix, window, exclude);
    const key = JSON.stringify(hits);
    if (this.last?.key === key) return this.last.result;
    const files: RecentFile[] = [];
    for (const h of hits) {
      const uri = this.uris.get(h.path);
      if (!uri) continue;
      try {
        files.push({ path: h.path, languageId: h.languageId, text: sliceLines(decode(await vscode.workspace.fs.readFile(uri)), h.start, h.end) });
      } catch {
        // Deleted since indexing; the watcher drops it.
      }
    }
    const result = { files, kinds: hits.map((h) => h.kind).join(',') };
    this.last = { key, result };
    return result;
  }

  // No details: file system errors carry absolute paths, which are never logged.
  private failed = (what: string) => () => this.log.warn(`workspace index: ${what} failed`);

  private async build(run: number): Promise<void> {
    // Fresh each run, so a language extension installed since the last start is picked up.
    this.languages = languageMap();
    // shortcut: extensions with glob characters are left out of the include; none of the common languages have any.
    const exts = [...this.languages].filter(([e, id]) => indexable(id) && !/[{},*?[\]]/.test(e)).map(([e]) => e);
    this.include = `**/*{${[...new Set(exts)].sort().join(',')}}`;
    this.watch();
    let left = MAX_FILES;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const exclude = await this.excludeFor(folder);
      if (run !== this.run) return;
      if (!exts.length) break;
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, this.include), exclude, left);
      const hidden = await this.hiddenBySibling(folder, exclude);
      if (run !== this.run) return;
      for (const uri of found) if (!hidden.has(relPath(uri))) this.enqueue(uri);
      left -= found.length;
      if (left <= 0) {
        this.limited = true;
        break;
      }
    }
    this.total = this.queue.length;
    this.state = 'indexing';
    this.onProgress();
    await this.drain(run);
  }

  /**
   * One exclude glob per folder: built-in dirs, `files.exclude` and the root `.gitignore`.
   * A custom exclude replaces `files.exclude` in findFiles, which is why its keys are merged in.
   */
  private async excludeFor(folder: vscode.WorkspaceFolder): Promise<string> {
    const filesExclude = vscode.workspace.getConfiguration('files', folder.uri).get<Record<string, unknown>>('exclude') ?? {};
    let gitignore = '';
    try {
      gitignore = decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.gitignore')));
    } catch {
      // No .gitignore.
    }
    // shortcut: keys with braces would nest inside the {…} group and break it, so they are skipped; post-filter if users need them.
    const fromSettings = Object.keys(filesExclude).filter((k) => filesExclude[k] === true && !/[{}]/.test(k));
    const glob = `{${[...BUILT_IN_EXCLUDE, ...fromSettings, ...gitignoreGlobs(gitignore)].join(',')}}`;
    this.excludes.set(folder.uri.toString(), glob);
    return glob;
  }

  /**
   * `files.exclude` entries like `"**\/*.js": { "when": "$(basename).ts" }` hide a file only while its sibling exists
   * (compiled output next to its source). findFiles can't express that, so those files are listed and dropped here.
   */
  private async hiddenBySibling(folder: vscode.WorkspaceFolder, exclude: string): Promise<Set<string>> {
    const hidden = new Set<string>();
    const filesExclude = vscode.workspace.getConfiguration('files', folder.uri).get<Record<string, unknown>>('exclude') ?? {};
    for (const [glob, value] of Object.entries(filesExclude)) {
      const when = (value as { when?: unknown } | null)?.when;
      if (typeof when !== 'string' || !when.includes('$(basename)')) continue;
      for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), exclude, MAX_FILES)) {
        const sibling = when.replace('$(basename)', basename(uri.path).replace(/\.[^.]*$/, ''));
        try {
          await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, '..', sibling));
          hidden.add(relPath(uri));
        } catch {
          // No sibling: the file is not hidden.
        }
      }
    }
    return hidden;
  }

  private async drain(run: number): Promise<void> {
    if (this.draining === run) return;
    this.draining = run;
    const started = Date.now();
    let skipped = 0;
    let longest = 0;
    try {
      while (this.queue.length) {
        while (this.isBusy() && run === this.run) await sleep(50);
        if (run !== this.run) return;
        const uri = this.queue.shift()!;
        const path = relPath(uri);
        const file = await this.read(uri);
        if (run !== this.run) return;
        if (!this.uris.has(path)) {
          // Deleted while it was being read.
        } else if (file) {
          const t = performance.now();
          this.index.set(path, file.languageId, file.text);
          longest = Math.max(longest, performance.now() - t);
        } else {
          this.index.delete(path); // rewritten into something unindexable: its old definitions must go
          skipped++;
        }
        this.last = undefined; // a re-indexed file may change a cached snippet
        if (this.state === 'indexing' && ++this.done % 100 === 0) this.onProgress();
        await sleep(PAUSE_MS);
      }
    } finally {
      if (this.draining === run) this.draining = 0;
    }
    if (this.state === 'indexing') {
      this.state = 'ready';
      this.log.info(`workspace index: files=${this.index.size} skipped=${skipped} ms=${Date.now() - started} longest_step_ms=${longest.toFixed(1)}`);
    }
    this.onProgress();
  }

  /** Text and language of a file worth indexing, or undefined. */
  private async read(uri: vscode.Uri): Promise<{ languageId: string; text: string } | undefined> {
    if (isSecretFile(uri.fsPath)) return;
    const languageId = this.languages?.get(extname(uri.path).toLowerCase());
    if (!languageId || !indexable(languageId)) return;
    try {
      if ((await vscode.workspace.fs.stat(uri)).size > MAX_BYTES) return;
      const text = decode(await vscode.workspace.fs.readFile(uri));
      return isIndexable(text) ? { languageId, text } : undefined;
    } catch {
      return; // gone or unreadable
    }
  }

  private watch(): void {
    if (this.watcher) return;
    const w = (this.watcher = vscode.workspace.createFileSystemWatcher('**/*'));
    // A root .gitignore decides what may be read, so any change to it starts over.
    const ignoreChanged = (uri: vscode.Uri) => {
      if (vscode.workspace.asRelativePath(uri, false) !== '.gitignore') return false;
      this.stop();
      this.start();
      return true;
    };
    w.onDidChange((uri) => {
      if (!ignoreChanged(uri) && this.uris.has(relPath(uri))) this.enqueue(uri);
    });
    w.onDidCreate((uri) => {
      if (!ignoreChanged(uri)) this.noteCreated(uri);
    });
    w.onDidDelete((uri) => {
      if (!ignoreChanged(uri)) this.forget(relPath(uri));
    });
  }

  /** The watcher reports a deleted or renamed folder only once, so everything under it goes too. */
  private forget(rel: string): void {
    for (const path of [...this.uris.keys()]) {
      if (path !== rel && !path.startsWith(`${rel}/`)) continue;
      this.index.delete(path);
      this.uris.delete(path);
    }
    this.last = undefined;
  }

  /** Creates are batched: one findFiles per folder lists new files, including those inside a renamed folder. */
  private noteCreated(uri: vscode.Uri): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    this.created.set(folder.uri.toString(), folder);
    clearTimeout(this.createTimer);
    const run = this.run;
    this.createTimer = setTimeout(() => void this.rescan(run).catch(this.failed('rescan')), CREATE_DEBOUNCE_MS);
  }

  private async rescan(run: number): Promise<void> {
    const folders = [...this.created.values()];
    this.created.clear();
    for (const folder of folders) {
      const exclude = this.excludes.get(folder.uri.toString());
      if (!exclude || !this.include) continue;
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, this.include), exclude, MAX_FILES);
      const hidden = await this.hiddenBySibling(folder, exclude);
      if (run !== this.run) return;
      for (const uri of found) {
        const path = relPath(uri);
        if (!this.uris.has(path) && !hidden.has(path) && this.uris.size < MAX_FILES) this.enqueue(uri);
      }
    }
  }

  private enqueue(uri: vscode.Uri): void {
    this.uris.set(relPath(uri), uri);
    this.queue.push(uri);
    if (this.state === 'indexing') this.total++;
    else if (this.state === 'ready') void this.drain(this.run).catch(this.failed('update'));
  }
}
