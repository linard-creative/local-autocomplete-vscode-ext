import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { Settings } from './config';
import { buildContext, isSecretFile } from './context';
import { cleanCompletion, fitLine } from './filter';
import { settings, type ModelService } from './models';
import { generate, OllamaError } from './ollama';
import { buildRequest, recentBlock, type RecentFile } from './prompt';

// Covers Ollama loading the model into memory, which can take several seconds.
const COLD_TIMEOUT_MS = 30_000;

// Relative path only: absolute paths leak usernames and folder layout into the prompt.
const relPath = (uri: vscode.Uri) =>
  vscode.workspace.getWorkspaceFolder(uri) ? vscode.workspace.asRelativePath(uri, false) : basename(uri.path);

/**
 * Line of each top-level symbol and of each member of a class-like one, in file order.
 * shortcut: only the first line of a multi-line signature, upgrade if outlines look truncated in practice.
 */
function outlineText(doc: vscode.TextDocument, symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): string {
  // Members of these belong in the outline; a function's children are its locals.
  const containers = [vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct, vscode.SymbolKind.Enum,
    vscode.SymbolKind.Module, vscode.SymbolKind.Namespace];
  const lines = new Set<number>();
  const walk = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[], top: boolean) => {
    for (const sym of list) {
      if (!('selectionRange' in sym)) {
        lines.add(sym.location.range.start.line); // flat SymbolInformation from older providers
        continue;
      }
      lines.add(sym.selectionRange.start.line);
      if (top && containers.includes(sym.kind)) walk(sym.children, false);
    }
  };
  walk(symbols, true);
  return [...lines].sort((a, b) => a - b).map((l) => doc.lineAt(l).text.trimEnd()).join('\n') + '\n';
}

// Full text, LF only like the current file's context (recentBlock cuts it to a head).
const head = (doc: vscode.TextDocument) => doc.getText().replace(/\r\n/g, '\n');

function delay(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  if (token.isCancellationRequested) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(true);
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export class LocalInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private current?: AbortController;
  /** File URIs in the order they were last active, most recent first. Persisted per workspace by extension.ts. */
  recent: string[] = [];
  private outlines = new Map<string, { version: number; text?: string }>();

  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly models: ModelService,
  ) {}

  /** Aborts the in-flight request, e.g. after a model switch. */
  abortCurrent(): void {
    this.current?.abort();
  }

  noteActive(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file') return;
    const key = document.uri.toString();
    // 10 is the recentTabsCount maximum, plus the current file.
    this.recent = [key, ...this.recent.filter((k) => k !== key)].slice(0, 11);
    for (const k of this.outlines.keys()) if (!this.recent.includes(k)) this.outlines.delete(k);
  }

  /** Recently active files still open in a tab, minus the current one, files outside the workspace, secrets and disabled languages. */
  private async recentFiles(current: vscode.TextDocument, s: Settings): Promise<RecentFile[]> {
    const tabs = new Set(
      vscode.window.tabGroups.all.flatMap((g) =>
        g.tabs.map((t) => (t.input instanceof vscode.TabInputText ? t.input.uri.toString() : '')),
      ),
    );
    const loaded = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
    const files: RecentFile[] = [];
    for (const key of this.recent) {
      if (files.length === s.recentTabsCount) break;
      const uri = vscode.Uri.parse(key);
      if (key === current.uri.toString() || !tabs.has(key) || !vscode.workspace.getWorkspaceFolder(uri) || isSecretFile(uri.fsPath))
        continue;
      // Tabs restored after a restart aren't loaded until shown; opening reads the file without showing it.
      const doc = loaded.get(key) ?? (await vscode.workspace.openTextDocument(uri).then((d) => d, () => undefined));
      if (!doc || s.disabledLanguages.includes(doc.languageId)) continue;
      files.push({ path: relPath(uri), languageId: doc.languageId, text: this.outline(doc) });
    }
    return files.reverse(); // most recent last, nearest the cursor
  }

  /**
   * Declaration lines from the language's symbol provider, cached per document version so the prompt start stays stable.
   * Never waits for it: returns the full text (cut to a head by recentBlock) until the symbols arrive, or if there are none.
   */
  private outline(doc: vscode.TextDocument): string {
    const key = doc.uri.toString();
    const hit = this.outlines.get(key);
    if (hit?.version === doc.version) return hit.text ?? head(doc);
    const entry: { version: number; text?: string } = { version: doc.version };
    this.outlines.set(key, entry);
    void vscode.commands
      .executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', doc.uri)
      .then(
        // The file may have changed while symbols were computed; its lines may no longer exist.
        (symbols) => (entry.text = doc.version === entry.version && symbols?.length ? outlineText(doc, symbols) : undefined),
        () => undefined,
      );
    return head(doc);
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const s = settings();
    if (!s.enabled || !s.model) return;
    if (s.disabledLanguages.includes(document.languageId) || isSecretFile(document.fileName)) return;
    // IntelliSense has a selection: stay out of the language server's way.
    if (context.selectedCompletionInfo) return;
    // Cursor inside an identifier: completions there are almost always wrong.
    if (/^\w/.test(document.lineAt(position).text.slice(position.character))) return;
    if (Date.now() < this.models.offlineUntil) return;
    if (!(await delay(s.debounceMs, token))) return;

    // Single-flight: a newer request always supersedes the previous one.
    this.current?.abort();
    const controller = (this.current = new AbortController());
    const sub = token.onCancellationRequested(() => controller.abort());
    const timeout = this.models.isCold(s.model) ? Math.max(s.requestTimeoutMs, COLD_TIMEOUT_MS) : s.requestTimeoutMs;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
    try {
      const profile = await this.models.profile(s, signal);
      const ctx = buildContext(document.getText(), document.offsetAt(position), s.maxContextChars);
      // Recent tabs get a quarter of the current file's budget on top of it.
      const recent = s.recentTabs ? recentBlock(await this.recentFiles(document, s), Math.floor(s.maxContextChars / 4)) : '';
      const body = buildRequest(ctx, { path: relPath(document.uri), languageId: document.languageId }, profile, s, recent);

      const started = Date.now();
      const res = await generate(s.endpoint, body, signal);
      this.models.report(s.model);
      // Stale: user kept typing, or switched models while this was generating.
      const stale = token.isCancellationRequested || settings().model !== s.model;
      const text = stale ? undefined : cleanCompletion(res.response, ctx, res.done_reason === 'length');
      const line = document.lineAt(position).text;
      const rest = line.slice(position.character).trimEnd();
      const fit = text ? fitLine(line.slice(0, position.character), text, rest) : undefined;

      // Metadata only (spec §14): never the prompt or completion text.
      const ms = (ns?: number) => (ns === undefined ? '?' : Math.round(ns / 1e6));
      const tokS = res.eval_count && res.eval_duration ? (res.eval_count / (res.eval_duration / 1e9)).toFixed(1) : '?';
      this.log.debug(
        `model=${s.model} prompt_chars=${body.prompt.length} recent_chars=${recent.length} total_ms=${Date.now() - started} load_ms=${ms(res.load_duration)} prompt_eval=${res.prompt_eval_count ?? '?'} prompt_ms=${ms(res.prompt_eval_duration)} eval_count=${res.eval_count ?? '?'} tok_s=${tokS} done=${res.done_reason ?? '?'} outcome=${stale ? 'stale' : !text ? 'empty' : !fit ? 'unbalanced' : 'shown'}`,
      );
      if (!text || !fit) return;
      const end = fit === 'replace' ? position.translate(0, rest.length) : position;
      return [new vscode.InlineCompletionItem(text, new vscode.Range(position, end))];
    } catch (e) {
      this.models.report(s.model, e instanceof OllamaError ? e : new OllamaError('invalid-response', String(e)));
      return;
    } finally {
      sub.dispose();
      if (this.current === controller) this.current = undefined;
    }
  }
}
