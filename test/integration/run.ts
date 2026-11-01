// Launches a downloaded VS Code (cached in .vscode-test/) with the extension and runs suite.ts inside it.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

// Set in terminals inside VS Code; it makes Code.exe run as plain Node and reject the launch args.
delete process.env.ELECTRON_RUN_AS_NODE;

runTests({
  extensionDevelopmentPath: resolve(__dirname, '../..'),
  extensionTestsPath: join(__dirname, 'suite.js'),
  // Fresh profile per run so settings from a previous run can't leak in.
  launchArgs: ['--disable-extensions', '--user-data-dir', mkdtempSync(join(tmpdir(), 'la-test-'))],
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
