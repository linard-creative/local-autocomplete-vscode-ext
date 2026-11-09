import * as vscode from 'vscode';
import { endpointProblem } from './config';
import { WorkspaceIndexer } from './indexer';
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
  const indexer = new WorkspaceIndexer(log, () => provider?.busy ?? false, render);
  provider.workspace = indexer;
  // Index only while completions can use it: no reading the workspace while autocomplete is off or has no model.
  const syncIndex = () => {
    const s = settings();
    if (s.enabled && s.model && s.workspaceContext) indexer.start(); // no-op while already running
    else indexer.stop();
  };
  const restartIndex = () => {
    indexer.stop();
    syncIndex();
  };

  function render(): void {
    const s = settings();
    status.tooltip =
      `Autocomplete Model: ${s.model || 'none'} (click to change)\nRecent tabs: ${s.recentTabs ? `on (${s.recentTabsCount})` : 'off'}\n${indexer.status}`;
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
        `Local Autocomplete will send your code, including snippets of other workspace files, to ${new URL(endpoint).host}${plain}. Only use endpoints you control.`,
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
    vscode.commands.registerCommand('localAutocomplete.toggleWorkspaceContext', () =>
      config().update('workspaceContext', !settings().workspaceContext, vscode.ConfigurationTarget.Global),
    ),
    indexer,
    vscode.window.onDidChangeActiveTextEditor(noteActive),
    vscode.workspace.onDidChangeWorkspaceFolders(restartIndex),
    // A new language extension adds file types worth indexing.
    vscode.extensions.onDidChange(restartIndex),
    vscode.workspace.onDidChangeConfiguration((e) => {
      // files.exclude decides what the index may read; files indexed before must go.
      if (e.affectsConfiguration('files.exclude')) restartIndex();
      if (!e.affectsConfiguration('localAutocomplete')) return;
      if (e.affectsConfiguration('localAutocomplete.disabledLanguages')) restartIndex();
      else if (['workspaceContext', 'enabled', 'model'].some((k) => e.affectsConfiguration(`localAutocomplete.${k}`))) syncIndex();
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
  syncIndex();
  checkEndpoint();
}

export function deactivate(): void {
  provider?.abortCurrent();
}
