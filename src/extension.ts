import * as vscode from 'vscode';
import { endpointProblem } from './config';
import { ModelService, settings } from './models';
import { LocalInlineCompletionProvider } from './provider';

const config = () => vscode.workspace.getConfiguration('localAutocomplete');
const setEnabled = (on: boolean) => config().update('enabled', on, vscode.ConfigurationTarget.Global);

let provider: LocalInlineCompletionProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Local Autocomplete', { log: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'localAutocomplete.selectModel';
  status.show();

  const models = new ModelService(log, render);
  provider = new LocalInlineCompletionProvider(log, models);
  // Restored so recent tabs work right after a restart; stays in VS Code's local storage for this workspace.
  provider.recent = context.workspaceState.get<string[]>('recentTabs', []);
  const noteActive = (editor?: vscode.TextEditor) => {
    if (!editor || !provider) return;
    provider.noteActive(editor.document);
    void context.workspaceState.update('recentTabs', provider.recent);
  };
  noteActive(vscode.window.activeTextEditor);

  function render(): void {
    const s = settings();
    status.tooltip = `Autocomplete Model: ${s.model || 'none'} (click to change)\nRecent tabs: ${s.recentTabs ? `on (${s.recentTabsCount})` : 'off'}`;
    if (endpointProblem(s.endpoint) === 'invalid') status.text = '$(error) Invalid endpoint';
    else if (!s.enabled) status.text = '$(circle-slash) Autocomplete off';
    else if (!s.model) status.text = '$(sparkle) Select model';
    else if (models.missing === s.model) status.text = `$(warning) ${s.model} not found`;
    else if (models.lastError === 'connection') status.text = '$(warning) Ollama offline';
    else if (models.lastError === 'http') status.text = '$(warning) Ollama error';
    else status.text = `$(sparkle) ${s.model}`;
  }

  const warned = new Set<string>();
  function checkEndpoint(): void {
    const { endpoint } = settings();
    const problem = endpointProblem(endpoint);
    if (!problem || warned.has(endpoint)) return;
    warned.add(endpoint);
    if (problem === 'invalid') {
      void vscode.window
        .showErrorMessage(`Invalid Ollama endpoint "${endpoint}". Use a URL like http://127.0.0.1:11434.`, 'Open Settings')
        .then((pick) => pick && vscode.commands.executeCommand('localAutocomplete.openSettings'));
      return;
    }
    const plain = endpoint.startsWith('http:') ? ' over unencrypted HTTP' : '';
    void vscode.window
      .showWarningMessage(
        `Local Autocomplete will send your code to ${new URL(endpoint).host}${plain}. Only use endpoints you control.`,
        'Keep',
        'Reset to localhost',
      )
      .then((pick) => {
        if (pick === 'Reset to localhost') void config().update('endpoint', undefined, vscode.ConfigurationTarget.Global);
      });
  }

  context.subscriptions.push(
    log,
    status,
    vscode.languages.registerInlineCompletionItemProvider(
      [{ scheme: 'file' }, { scheme: 'untitled' }, { scheme: 'vscode-notebook-cell' }],
      provider,
    ),
    vscode.commands.registerCommand('localAutocomplete.enable', () => setEnabled(true)),
    vscode.commands.registerCommand('localAutocomplete.disable', () => setEnabled(false)),
    vscode.commands.registerCommand('localAutocomplete.selectModel', () => models.select()),
    vscode.commands.registerCommand('localAutocomplete.refreshModels', () => models.refresh()),
    vscode.commands.registerCommand('localAutocomplete.testConnection', () => models.testConnection()),
    vscode.commands.registerCommand('localAutocomplete.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:linard-creative.local-autocomplete'),
    ),
    vscode.commands.registerCommand('localAutocomplete.toggleRecentTabs', () =>
      config().update('recentTabs', !settings().recentTabs, vscode.ConfigurationTarget.Global),
    ),
    vscode.window.onDidChangeActiveTextEditor(noteActive),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('localAutocomplete')) return;
      if (e.affectsConfiguration('localAutocomplete.endpoint')) {
        models.reset();
        checkEndpoint();
      }
      if (['model', 'endpoint', 'enabled'].some((k) => e.affectsConfiguration(`localAutocomplete.${k}`))) {
        provider?.abortCurrent();
        models.offlineUntil = 0; // a new model or endpoint gets tried right away
        void vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
      }
      render();
    }),
  );

  render();
  checkEndpoint();
}

export function deactivate(): void {
  provider?.abortCurrent();
}
