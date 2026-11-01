// Launches a downloaded VS Code (cached in .vscode-test/) with the extension and runs suite.ts inside it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

// Set in terminals inside VS Code; it makes Code.exe run as plain Node and reject the launch args.
delete process.env.ELECTRON_RUN_AS_NODE;

// Workspace for the recent-tabs check: a file with symbols and a secret file that must never reach the prompt.
const workspace = mkdtempSync(join(tmpdir(), 'la-ws-'));
writeFileSync(
  join(workspace, 'types.ts'),
  "import { readFileSync } from 'node:fs';\nexport interface User {\n  id: string;\n}\nexport function loadUser(id: string): User {\n  const raw = readFileSync(id, 'utf8');\n  return JSON.parse(raw);\n}\n",
);
writeFileSync(join(workspace, '.env'), 'TOKEN=hunter2\n');

runTests({
  extensionDevelopmentPath: resolve(__dirname, '../..'),
  extensionTestsPath: join(__dirname, 'suite.js'),
  // Fresh profile per run so settings from a previous run can't leak in.
  launchArgs: [workspace, '--disable-extensions', '--user-data-dir', mkdtempSync(join(tmpdir(), 'la-test-'))],
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
