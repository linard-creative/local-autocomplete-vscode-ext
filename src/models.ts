import * as vscode from 'vscode';
import { readSettings, type Settings } from './config';
import { getVersion, listModels, OllamaError, showModel, type TagModel } from './ollama';
import { describeProfile, resolveProfile, type ModelProfile } from './prompt';

const OFFLINE_BACKOFF_MS = 10_000;
const COLD_AFTER_MS = 5 * 60_000;

export const settings = (): Settings => readSettings(vscode.workspace.getConfiguration('localAutocomplete'));

const sameModel = (installed: string, configured: string) =>
  installed === configured || installed === `${configured}:latest`;

/** User-facing text for a failed request. Never includes code. */
export function describeError(e: unknown, endpoint: string): string {
  const err = e instanceof OllamaError ? e : undefined;
  if (err?.kind === 'connection') return `Can't reach Ollama at ${endpoint}. Is Ollama running?`;
  if (err?.kind === 'timeout') return `Ollama at ${endpoint} did not respond in time.`;
  return `Ollama request failed: ${err?.message ?? String(e)}`;
}

/** Ollama-side state: model capabilities, reachability, and whether the selected model is installed. */
export class ModelService {
  /** Configured model that Ollama reported as not installed; completions pause until it changes. */
  missing?: string;
  lastError?: 'connection' | 'http';
  /** After a connection error, skip requests until this time instead of failing on every keystroke. */
  offlineUntil = 0;
  private profiles = new Map<string, ModelProfile>();
  private notified = new Set<string>();
  private lastSuccess = new Map<string, number>();

  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly onChange: () => void,
  ) {}

  reset(): void {
    this.profiles.clear();
    this.missing = undefined;
    this.lastError = undefined;
    this.offlineUntil = 0;
    this.onChange();
  }

  /** No recent success: Ollama may have to load the model first (seconds), so the provider allows a longer timeout. */
  isCold(model: string): boolean {
    return Date.now() - (this.lastSuccess.get(model) ?? 0) > COLD_AFTER_MS;
  }

  async profile(s: Settings, signal: AbortSignal): Promise<ModelProfile> {
    let p = this.profiles.get(s.model);
    if (!p) {
      p = resolveProfile(s.model, await showModel(s.endpoint, s.model, signal));
      this.log.info(`${s.model}: ${describeProfile(p)}`);
      this.profiles.set(s.model, p);
    }
    return p;
  }

  /** Records a completion request outcome. Logs and re-renders only on state transitions, so failures don't flood. */
  report(model: string, err?: OllamaError): void {
    const kind = err?.kind;
    if (!err) this.lastSuccess.set(model, Date.now());
    if (kind === 'aborted') return;
    if (kind === 'timeout') return this.log.debug(err!.message);
    if (kind === 'invalid-response') return this.log.warn(err!.message);
    if (kind === 'model-not-found') return this.markMissing(model);
    if (kind === 'connection') this.offlineUntil = Date.now() + OFFLINE_BACKOFF_MS;
    this.setError(kind, err);
  }

  private setError(kind: 'connection' | 'http' | undefined, err?: OllamaError): void {
    if (!kind) this.offlineUntil = 0;
    if (kind === this.lastError) return;
    this.lastError = kind;
    if (err) this.log.warn(`${err.kind}: ${err.message}`);
    else this.log.info('Ollama reachable');
    this.onChange();
  }

  private markMissing(model: string): void {
    if (this.missing === model) return;
    this.missing = model;
    this.log.warn(`Model "${model}" is not installed in Ollama`);
    this.onChange();
    if (this.notified.has(model)) return;
    this.notified.add(model);
    void vscode.window
      .showWarningMessage(`Model "${model}" is not installed in Ollama.`, 'Select Model')
      .then((pick) => pick && vscode.commands.executeCommand('localAutocomplete.selectModel'));
  }

  /** Fetches installed models and updates missing/offline state from the result. */
  async list(s: Settings): Promise<TagModel[]> {
    let models: TagModel[];
    try {
      models = await listModels(s.endpoint, AbortSignal.timeout(s.requestTimeoutMs));
    } catch (e) {
      if (e instanceof OllamaError) this.report(s.model, e);
      throw e;
    }
    this.setError(undefined);
    if (s.model && !models.some((m) => sameModel(m.name, s.model))) this.markMissing(s.model);
    else if (this.missing) {
      this.missing = undefined;
      this.onChange();
    }
    return models;
  }

  async select(): Promise<void> {
    const s = settings();
    let models: TagModel[];
    try {
      models = await this.list(s);
    } catch (e) {
      void vscode.window.showErrorMessage(describeError(e, s.endpoint));
      return;
    }
    if (!models.length) {
      void vscode.window.showInformationMessage('No Ollama models installed. Run e.g. `ollama pull qwen2.5-coder:1.5b`.');
      return;
    }
    const items = models.map((m) => ({
      label: `${sameModel(m.name, s.model) ? '$(check)' : '$(blank)'} ${m.name}`,
      description: [m.details?.parameter_size, m.details?.quantization_level, `${(m.size / 1e9).toFixed(1)} GB`]
        .filter(Boolean)
        .join(' · '),
      name: m.name,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select autocomplete model' });
    if (pick && !sameModel(pick.name, s.model)) {
      await vscode.workspace
        .getConfiguration('localAutocomplete')
        .update('model', pick.name, vscode.ConfigurationTarget.Global);
    }
  }

  async refresh(): Promise<void> {
    this.profiles.clear();
    const s = settings();
    try {
      const models = await this.list(s);
      const note = this.missing ? ` "${s.model}" is not installed.` : '';
      void vscode.window.showInformationMessage(`Found ${models.length} Ollama model(s).${note}`);
    } catch (e) {
      void vscode.window.showErrorMessage(describeError(e, s.endpoint));
    }
  }

  async testConnection(): Promise<void> {
    const s = settings();
    try {
      const models = await this.list(s);
      const version = await getVersion(s.endpoint, AbortSignal.timeout(s.requestTimeoutMs));
      const model = !s.model
        ? 'No model selected.'
        : this.missing
          ? `"${s.model}" is NOT installed.`
          : `"${s.model}" is installed.`;
      void vscode.window.showInformationMessage(
        `Connected to Ollama ${version} at ${s.endpoint}. ${models.length} model(s) installed. ${model}`,
      );
    } catch (e) {
      void vscode.window.showErrorMessage(describeError(e, s.endpoint));
    }
  }
}
