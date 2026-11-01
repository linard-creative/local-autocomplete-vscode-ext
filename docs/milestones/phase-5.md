# Phase 5 — Testing and packaging (0.5.0)

## Shipped

- `test/ollama.test.ts`: 9 mocked-`fetch` tests for `ollama.ts`: request body shape (POST JSON for generate/show, GET for tags/version), connection refused, timeout, abort reaches `fetch`, 404 "model not found" vs other 404, 5xx with truncated body, bad JSON and missing fields
- `test/integration/` (`npm run test:integration`): `run.ts` launches a downloaded VS Code with a fresh profile; `suite.ts` runs in the extension host with a fake Ollama (Node `http`, random port). It checks activation, all six commands registered, and that triggering and accepting a suggestion inserts the fake completion. The generate body carries the suffix and no absolute path.
- `README.md` (setup, recommended models, commands, settings, privacy incl. secret files, troubleshooting), `CHANGELOG.md`; both ship in the `.vsix`
- `local-autocomplete-0.5.0.vsix` (6 files, 11 KB)

## Acceptance (spec §19)

- [x] `npm test` passes with no Ollama needed: 39/39 (3 files)
- [x] Integration tests pass with no Ollama: exit 0. A deliberately broken assertion made it fail (exit 1, actual text shown), so the suite really runs.
- [x] The `.vsix` installs into an empty profile (`--user-data-dir` + `--extensions-dir`): `local.local-autocomplete@0.5.0` listed
- [x] Manual: the `.vsix` works in a clean VS Code profile (spec §20 workflow 1: Select model → suggestion), confirmed by user (2026-11-01): "Done testing and it works"
- [x] Manual: the checklist in spec §16 passes on 3+ models, covered by the same confirmation; the user did not say which models were tested

## Decisions / deviations (recorded in spec §1, §16, §17, §18)

- Only `@vscode/test-electron`, no `@vscode/test-cli`/Mocha: one suite with a `run()` export and `node:assert` needs no framework.
- The integration test drives the real UI path (`editor.action.inlineSuggest.trigger` / `commit`, polled for up to 5 s) instead of exporting the provider from `activate`, so no test-only API was added.
- `run.ts` deletes `ELECTRON_RUN_AS_NODE`: terminals inside VS Code set it, and `Code.exe` then rejects `--user-data-dir` ("bad option", exit 9).
- No "400 insert" test: that path is unreachable (Phase 4 decision, spec §15).
- `npm audit`: 11 moderate findings, all in dev dependencies (`minimatch` ReDoS, GHSA-g3hv-75wg-m249). `npm audit --omit=dev` finds 0, because there are no runtime dependencies. Left as is: the only fix offered is `--force`.
