// Runs inside the VS Code extension host against a fake Ollama (Node http), so no real Ollama is needed.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const replies: Record<string, unknown> = {
  '/api/version': { version: '0.0.0-fake' },
  '/api/tags': { models: [{ name: 'fake:1b', size: 1 }] },
  '/api/show': { capabilities: ['completion', 'insert'] },
  '/api/generate': { response: 'return a + b;', done: true, done_reason: 'stop' },
};

async function readBody(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}

export async function run(): Promise<void> {
  const generates: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === '/api/generate') generates.push(JSON.parse(body));
    const reply = replies[req.url ?? ''];
    res.writeHead(reply ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply ?? { error: 'not found' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const ext = vscode.extensions.getExtension('linard-creative.local-autocomplete');
    assert.ok(ext, 'extension is installed');
    await ext.activate();

    const registered = await vscode.commands.getCommands(true);
    for (const { command } of ext.packageJSON.contributes.commands as { command: string }[]) {
      assert.ok(registered.includes(command), `${command} is registered`);
    }

    const cfg = vscode.workspace.getConfiguration('localAutocomplete');
    const global = vscode.ConfigurationTarget.Global;
    await cfg.update('endpoint', `http://127.0.0.1:${(server.address() as AddressInfo).port}`, global);
    await cfg.update('model', 'fake:1b', global);
    await cfg.update('debounceMs', 0, global);

    // Recent tabs: types.ts and .env are open in tabs before the file being edited.
    const root = vscode.workspace.workspaceFolders![0].uri;
    const types = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'types.ts'));
    await vscode.window.showTextDocument(types, { preview: false });
    await vscode.window.showTextDocument(vscode.Uri.joinPath(root, '.env'), { preview: false });
    const t0 = Date.now();
    const symbols = await vscode.commands.executeCommand<unknown[]>('vscode.executeDocumentSymbolProvider', types.uri);
    console.log(`document symbols: ${symbols?.length ?? 0} in ${Date.now() - t0} ms`);

    const doc = await vscode.workspace.openTextDocument({
      language: 'typescript',
      content: 'function add(a: number, b: number) {\n  \n}\n',
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(1, 2, 1, 2);

    // Ghost text appears asynchronously; commit (Tab) does nothing until it is shown.
    for (let i = 0; i < 50 && doc.lineAt(1).text === '  '; i++) {
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      await sleep(100);
      await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
    }
    assert.equal(doc.lineAt(1).text, '  return a + b;', 'accepting the suggestion inserts the fake completion');
    assert.ok(generates.length > 0, 'generate was called');
    assert.equal(generates[0].model, 'fake:1b');
    assert.equal(generates[0].suffix, '\n}\n', 'native FIM: the suffix is sent');
    assert.ok(!String(generates[0].prompt).includes(':\\'), 'no absolute path in the prompt');

    // The outline replaces the head once symbols are cached; force fresh requests until it shows up.
    const outline = '// File: types.ts (typescript)\nexport interface User {\n  id: string;\nexport function loadUser(id: string): User {\n';
    for (let i = 0; i < 50 && !generates.some((g) => String(g.prompt).startsWith(outline)); i++) {
      await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      await sleep(100);
    }
    const last = String(generates.at(-1)!.prompt);
    assert.ok(last.startsWith(outline), `recent tab sent as its outline, got: ${last.slice(0, 200)}`);
    assert.ok(!last.includes('readFileSync(id'), 'function bodies are not in the outline');
    assert.ok(generates.every((g) => !String(g.prompt).includes('hunter2')), '.env is never sent');

    // Phase 7: the completion closes the call itself, so it replaces the auto-closed `")` instead of doubling it.
    replies['/api/generate'] = { response: 'x", x)', done: true, done_reason: 'stop' };
    const call = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'console.log("")\n' });
    const callEditor = await vscode.window.showTextDocument(call);
    callEditor.selection = new vscode.Selection(0, 13, 0, 13);
    for (let i = 0; i < 50 && call.lineAt(0).text === 'console.log("")'; i++) {
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      await sleep(100);
      await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
    }
    assert.equal(call.lineAt(0).text, 'console.log("x", x)', 'auto-closed characters are replaced, not doubled');
  } finally {
    server.close();
  }
}
