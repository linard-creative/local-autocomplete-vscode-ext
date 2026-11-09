# Phase 9 — Workspace context (0.9.0)

Design: [2026-11-10-workspace-context-design.md](../superpowers/specs/2026-11-10-workspace-context-design.md). Plan: [2026-11-10-workspace-context.md](../superpowers/plans/2026-11-10-workspace-context.md).

## Shipped

- `retrieve.ts` (no `vscode`): tokens, definitions, a token → chunk inverted index with no file text kept, and `pick`, which returns up to 2 snippets (definitions first, then similar code) or nothing.
- `indexer.ts`: starts 3 s after activation and reads one file per step with a 5 ms pause, pausing while a completion is in flight.
  - Excludes `node_modules` and the other built-in dirs, `files.exclude` and the root `.gitignore`. Skips secret, binary, minified, over-256 KB, header-less and disabled-language files. Caps at 5000 files.
  - A file watcher keeps it current.
  - Snippet text is read from disk only when the picks change.
- `provider.ts`: snippets go between the recent tabs and the current file. The debug line adds `workspace_chars`, `workspace_ms` and `workspace_hits`.
- `extension.ts`: `workspaceContext` setting, **Toggle Workspace Context** command, tooltip progress, restart on setting or folder changes. The endpoint warning mentions workspace files.
- Tests:
  - `test/retrieve.test.ts` and `test/indexer.test.ts`
  - `test/workspace-perf.test.ts`: budgets on a seeded 5000-file synthetic workspace
  - an integration check in real VS Code
- Scripts: `npm run bench:context`, and a workspace variant in `npm run bench`.

## Acceptance (spec §19)

- [x] Unit tests: chunking, tokenizing, definition detection, definition match above similarity, exclusions (current file, recent tabs, deleted and rewritten files), unrelated code returns nothing, CRLF line numbers, typing inside a name keeps the picks, stale-entry compaction. Indexer lifecycle: stop/start while busy, a rewritten unindexable file, folder delete, batched creates and renamed folders, `.gitignore` restart, code-only listing, multi-root paths, `files.exclude` `when` conditions, language map refresh. 96/96 across 6 files.
- [x] `test/workspace-perf.test.ts` passes: retrieval p95 ~0.1 ms (≤ 5), 256 KB step 7.5–12.2 ms (≤ 16), heap ~31 MB (≤ 70), repeated query identical.
- [x] Integration (real VS Code, fake Ollama): the closed `invoice.ts` definition reached the prompt 1.3 s after the check started. `node_modules/`, `.gitignore`d `generated/` and `.env` content never appeared. Earlier recent-tab and Phase 7 checks still pass.
- [ ] `bench:context` recorded in spec §11 with noise below hits. Recorded, but only partly met: hit 5, noise 3, silent 19 on 27 fixtures, then hit 5, noise 5, silent 20 on 30 fixtures once `indexer.ts` joined `src/`. The new noise is the definitions of called functions and test files that resemble their source, so it isn't junk, but the box stays open for the user to judge.
- [x] `bench` recorded for 2 models across off / recent / recent + workspace (spec §11). Workspace snippets add 57 prompt tokens on average. p50 7b 598 / 865 / 615 ms and 1.5b 214 / 195 / 198 ms, within run-to-run noise.
- [x] Manual: a completion uses a name that exists only in a closed file.
- [x] Manual: a 2k+ file repo shows no typing lag while indexing.
- [x] Manual: toggling off drops `workspace_chars` to 0 in the debug log.

The three manual checks were confirmed by the user on 2026-11-10.

## Decisions / deviations (recorded in spec §10, §11)

- The index keeps no file text, only token postings and line ranges. Snippets are read from disk when the picks change. This keeps memory at ~31 MB for 5000 files.
- Definition snippets start at the definition line. Similar-code chunks are fixed 20-line windows.
- Precision rules added after `bench:context` measured noise 14 > hits 13. Definitions are looked up only for free (not after `.`), specific (PascalCase / camelCase / snake_case) names that the current window doesn't declare. Only top-level `const`/`let`/`var` count as definitions. Similarity needs at least 3 shared tokens.
- `MIN_SIM` is 0.2, not the 0.1 the plan's tuning rule would pick: 0.1 sends noise on 10 of 27 requests instead of 3.
- `.gitignore`: `findFiles2`/`useIgnoreFiles` is proposed-only in VS Code 1.101, so the root `.gitignore`'s simple lines are converted to globs. Nested `.gitignore` files and negations are not supported (`shortcut:` in `indexer.ts`).
- Second fix pass (the reviewer's minors, at the user's request):
  - A name the current file or a recent tab defines is never looked up in another file.
  - Multi-root paths carry the folder name, so same-named files in two folders don't collide.
  - `files.exclude` `when` conditions are honored.
  - `.gitignore` lines with braces are skipped instead of breaking the exclude.
  - The index runs only while autocomplete is on and a model is set.
  - The language map is rebuilt on each start and on extension changes.
- `sliceLines` lives in `retrieve.ts` so the bench scripts can use it without `vscode`.
