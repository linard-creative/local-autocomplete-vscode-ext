# Phase 6 — Recent tabs context (0.6.0)

## Shipped

- Settings `recentTabs` (boolean, default on) and `recentTabsCount` (default 3, 1–10). A **Toggle Recent Tabs Context** command. The status bar tooltip shows the state.
- `provider.ts`: most-recently-active list of `file` URIs fed by `onDidChangeActiveTextEditor`, saved in `workspaceState` by `extension.ts` so it survives a restart. Per request it takes files still open in a tab (`window.tabGroups`) inside a workspace folder, skipping the current file, `disabledLanguages` and secret files. Restored tabs that aren't loaded yet are opened with `openTextDocument`.
- Outlines: the declaration lines from `vscode.executeDocumentSymbolProvider` (top-level symbols plus members of class-like symbols, no function bodies or imports), cached per document version and computed in the background. The file head is the fallback.
- `prompt.ts`: `recentBlock` puts each tab under its own file header. Budget `maxContextChars / 4`, split evenly, placed before the current file so Ollama's prompt cache can reuse it.
- `context.ts`: `isSecretFile`, a built-in pattern for `.env*`, `.envrc`, `.npmrc`, `.netrc`, SSH private keys, `credentials`, `secrets.*` data files, `*.pem/.key/.p12/.pfx/.tfvars/.tfstate` and more. These files get no completions and are never sent as context.
- Debug line adds `recent_chars`, `prompt_eval`, `prompt_ms`. `npm run bench` runs each model with and without recent tabs.

## Acceptance (spec §19)

- [x] Unit tests cover the secret pattern, budget split, line-boundary cut, prompt order, the toggle, closed and restored tabs, and the head-to-outline switch: 46/46 (3 files)
- [x] Integration test (real VS Code, fake Ollama, temp workspace): the prompt starts with the real TypeScript outline of `types.ts`, with no function bodies, and `.env` never appears in any prompt. The symbol provider answered in 277 ms on a cold TypeScript server.
- [x] Bench p50 recorded with and without recent tabs for `qwen2.5-coder:7b` and `qwen2.5-coder:1.5b` (spec §11, measured with file heads before outlines existed). The extra prompt reading costs 4–51 ms. End-to-end p50 moved +6 ms (1.5b) and +97 / +267 ms (7b, two runs), mostly noise.
- [x] Manual: with a types file open in a recent tab, a completion uses a name that exists only in that file, confirmed by user (2026-11-02): "yes it does"
- [x] Manual: turning `recentTabs` off (command or setting) drops `recent_chars` to 0 in the debug log, confirmed by user (2026-11-02): "okay it works"

## Decisions / deviations (recorded in spec §2, §3, §10, §11, §13, §14, §22)

- "Multi-file context" was dropped from the non-goals. Only open tabs are used, with no workspace scan.
- Outlines instead of similarity-picked snippets: denser in names, and the prompt start stays stable for Ollama's prompt cache.
- Outlines never block a request. The first request after a tab becomes recent sends its head, and later requests send the outline.
- The recent-tab budget is added on top of `maxContextChars`, not taken from it, so the current file keeps its full window.
- Only files inside a workspace folder are sent, so stray files like `~/.ssh/config` never are.
- The secret-file pattern is built in and has no setting, so a workspace cannot turn it off. It also applies to the current file. Before this phase, `.env` files got completions unless their language was disabled.
- Qwen's native repo format (`<|file_sep|>`) was not adopted yet. It's an Open Question (spec §22).
