import { basename } from 'node:path';
import * as vscode from 'vscode';
import { buildContext } from './context';
import { cleanCompletion } from './filter';
import { settings, type ModelService } from './models';
import { generate, OllamaError } from './ollama';
import { buildRequest } from './prompt';

// Covers Ollama loading the model into memory, which can take several seconds.
const COLD_TIMEOUT_MS = 30_000;

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

  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly models: ModelService,
  ) {}

  /** Aborts the in-flight request, e.g. after a model switch. */
  abortCurrent(): void {
    this.current?.abort();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const s = settings();
    if (!s.enabled || !s.model || s.model === this.models.missing) return;
    if (s.disabledLanguages.includes(document.languageId)) return;
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
      // Relative path only: absolute paths leak usernames and folder layout into the prompt.
      const path = vscode.workspace.getWorkspaceFolder(document.uri)
        ? vscode.workspace.asRelativePath(document.uri, false)
        : basename(document.uri.path);
      const body = buildRequest(ctx, { path, languageId: document.languageId }, profile, s);

      const started = Date.now();
      const res = await generate(s.endpoint, body, signal);
      this.models.report(s.model);
      // Stale: user kept typing, or switched models while this was generating.
      const stale = token.isCancellationRequested || settings().model !== s.model;
      const text = stale ? undefined : cleanCompletion(res.response, ctx, res.done_reason === 'length');

      // Metadata only (spec §14): never the prompt or completion text.
      const ms = (ns?: number) => (ns === undefined ? '?' : Math.round(ns / 1e6));
      const tokS = res.eval_count && res.eval_duration ? (res.eval_count / (res.eval_duration / 1e9)).toFixed(1) : '?';
      this.log.debug(
        `model=${s.model} prompt_chars=${body.prompt.length} total_ms=${Date.now() - started} load_ms=${ms(res.load_duration)} eval_count=${res.eval_count ?? '?'} tok_s=${tokS} done=${res.done_reason ?? '?'} outcome=${stale ? 'stale' : text ? 'shown' : 'empty'}`,
      );
      return text ? [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))] : undefined;
    } catch (e) {
      this.models.report(s.model, e instanceof OllamaError ? e : new OllamaError('invalid-response', String(e)));
      return;
    } finally {
      sub.dispose();
      if (this.current === controller) this.current = undefined;
    }
  }
}
