# Workspace context (Phase 9) — design

Status: approved by the user 2026-11-10. Once approved, it is folded into `docs/spec.md` (§2, F2, §10, §11, §13, §14, §16, §19, §22) and planned with `superpowers:writing-plans`.

## Intent

The user wants completions that use what is actually in the codebase: its functions, types, constants and patterns, including files that aren't open. **Precision over volume:** a suggestion should be more related to the project, never noisier. The user also wants it as fast as possible, with performance measured as part of normal development, not checked once.

The model is not trained (the user knows this). Instead, a background job reads the workspace a little at a time and keeps a local index in memory. On each completion, the extension adds the few chunks from other files that are clearly relevant to the code at the cursor, and nothing when none are. Copilot's "neighboring files" context works the same way.

## Goals

1. **Related, not noisy.** A completion can use a function, type or pattern that exists only in a closed file. When nothing in the index is clearly relevant, the prompt gets nothing extra.
2. **Invisible indexing:** no typing lag, no notifications. It starts after activation, works in small steps and pauses while a completion is in flight.
3. **Current:** the index follows saves, creates and deletes.
4. **Measured:** retrieval quality and performance have automated checks that run with `npm test`, plus a deeper benchmark script. A regression fails the tests.

## Non-goals

- Fine-tuning or any change to model weights.
- Embeddings / `/api/embed`. That needs a second model and competes for VRAM with the completion model. It's a later option if the quality numbers below show lexical retrieval falling short (new §22 question).
- Learning from accepted or rejected completions.
- Persisting the index to disk. It is rebuilt in the background on each start.
- Unsaved edits in other open files (the index reads from disk; Phase 6 outlines already cover open tabs).
- UI beyond a tooltip line and one toggle command.

## Anti-goals (failure even if it "works")

- Suggestions get noisier: snippets that are only vaguely similar pull the model off course.
- Any noticeable typing lag or extension-host stall, including on a 10k-file repo.
- A secret file, a file outside the workspace, or a `node_modules` / ignored file reaching a prompt.
- Snippets that change on every keystroke and throw away Ollama's prompt cache (spec §10).
- Source text, paths or snippets in the log.

## Constraints

- Zero runtime dependencies. `fetch` stays in `ollama.ts`. No new network peer and no new Ollama endpoint.
- Chunking, tokenizing, scoring and picking go in a module that does not import `vscode`, so they are unit- and perf-tested in plain Node. Discovery, reading and watching use the VS Code API.
- No synchronous I/O on the extension host (N3). Activation stays under 50 ms with no indexing (N4). Metadata-only logs (N2).

## How it works

### Indexing (background)

- **Start:** a few seconds after activation, only when `workspaceContext` is on and a folder is open.
- **Discovery:** `workspace.findFiles` over all workspace folders, honoring `files.exclude`, plus a built-in exclude for `node_modules`, `.git`, `dist`, `out`, `build`, `target`, `vendor`, `.venv`, `coverage`. `.gitignore`: checked 2026-11-10, `findFiles2` / `useIgnoreFiles` is still a proposed API in 1.101, so each folder's root `.gitignore` is read and its simple lines become exclude globs. Negations (`!`) and nested `.gitignore` files are not supported (a `shortcut:` comment marks it).
- **Skip:** secret files (`isSecretFile`), files over 256 KB, binary files (NUL in the first 8 KB), minified/generated files (very long average line length), and `disabledLanguages`.
- **Language ids without opening documents** (opening would wake language servers): build an extension → languageId map once from `vscode.extensions.all[].packageJSON.contributes.languages`. Unknown extensions are skipped.
- **Pacing:** `workspace.fs.readFile` (async), one file per step, yield between steps. Pause while a completion request is in flight. Each step's synchronous work (chunk + tokenize one file) must stay under a frame budget (see Performance). The cap is 5000 files per workspace, after which the tooltip says the index is partial.
- **Chunks:** fixed line windows (about 20–30 lines, overlapping by half). Each chunk stores relative path, languageId, line range, text, its identifier token set, and the identifiers it **defines**. A simple per-language-agnostic declaration pattern finds those: `function X`, `class X`, `interface X`, `type X`, `enum X`, `def X`, `fn X`, `func X`, `const|let|var X =`, `X(...) {` method heads and similar.
- **Updates:** a `FileSystemWatcher` re-queues changed or created files and drops deleted ones. The toggle and folder changes start or stop the indexer.

### Retrieval (per completion): precision first

- **Query:** identifier tokens from the ~20 lines **before the cursor's line**, plus the identifiers on the cursor line up to the cursor. Only the completed part of the cursor line is unstable, so the result is cached by the query's token set: typing a new character that adds no new identifier changes nothing, and the prompt start stays cached.
- **Definition match (strongest signal):** an identifier used near the cursor that the current file does not define, but a chunk elsewhere does, means that chunk is wanted, e.g. you call `computeInvoiceTotal(` and its definition is in a closed file. These chunks rank first.
- **Similarity (second signal):** Jaccard similarity of token sets, for "code that looks like what you're writing" (similar handlers, tests, repeated patterns). It only counts above a minimum score that is tuned with the quality check below.
- **When in doubt, send nothing.** At most 2 chunks. A chunk is dropped if it's from the current file, from a recent-tab file already in the prompt, or below the threshold. Common tokens (keywords, `this`, `self`, `return`, very short names) are ignored so they can't create false matches.
- **Speed:** an inverted index (token → chunks) so a lookup touches only chunks that share a token, not all 5000 files.

### Prompt

- Snippets go under their own `fileHeader`, the same format as recent tabs (`recentBlock` can likely be reused).
- Order: `[recent-tab outlines] [workspace snippets] [current-file header + prefix]`, most stable first.
- Budget: up to `maxContextChars / 4` (1500 chars by default) on top of the existing budgets. It's a ceiling, not a target: most requests use less or none.

### Settings, commands, status, logs

- `localAutocomplete.workspaceContext` (boolean, default `true`, `window` scope), and a **Toggle Workspace Context** command.
- Tooltip: `Workspace: indexing 340/1200 files`, `Workspace: 1200 files indexed`, or `Workspace: off`.
- Debug line adds `workspace_chars`, `workspace_ms` (retrieval time), and `workspace_hits` (`def`/`sim` per chunk, e.g. `def,sim`). Indexing logs one summary per run: files, chunks, skipped, duration, longest step.

### Privacy (spec §14 changes)

- Files that aren't open can now be sent, but only from inside a workspace folder, never secret files, and only to the single configured endpoint.
- The non-local endpoint warning also says that workspace files may be sent.
- The index is in memory only. It is never written to disk or logged.

## Performance and quality checks (part of development)

Two layers, so regressions are caught while coding and the deeper numbers are one command away.

**1. In `npm test` (Vitest, no Ollama, runs in CI):** `test/workspace-perf.test.ts` builds an index from a deterministic synthetic workspace (5000 files of generated TypeScript/Python-like code, seeded so it's identical every run) and asserts:

| Check | Budget |
|---|---|
| Retrieval, p95 over 500 queries | ≤ 5 ms (the §11 "extension overhead" budget) |
| Longest single indexing step (one 256 KB file) | ≤ 16 ms (one frame: indexing can't cause visible lag) |
| Index memory for 5000 files (heap delta) | recorded; ceiling set from the first measurement with 2× headroom |
| Same query twice / typing within an identifier | identical result (cache stability) |

The budgets are generous on purpose, so slow CI machines don't flake. They catch real regressions (e.g. an accidental full scan instead of the inverted index), not small noise.

**2. `npm run bench:context` (script, no Ollama, not in CI):** prints detailed numbers on this repo and on the synthetic workspace: index build time, files/s, retrieval p50/p95, memory, and **retrieval quality**:

- For each fixture (cursor 30/60/90% through each `src/` file, like `npm run bench`), the current file is excluded and retrieval runs as usual.
- **Hit:** a picked chunk defines an identifier that appears in the file's real next 10 lines but not in the prefix (the model would have needed it).
- **Noise:** a picked chunk that doesn't.
- **Silent:** nothing picked.
- Report hit / noise / silent counts. This is the number used to tune the threshold, and the evidence for the "not noisy" goal. Target: noise below hits.

**3. Existing `npm run bench -- <model>` (needs Ollama):** adds a third variant, with workspace context, so end-to-end p50/p95, `prompt_ms` and the empty count are compared off / recent tabs / recent tabs + workspace.

## Acceptance (Phase 9)

- Unit tests: chunking, tokenizing, definition detection, definition match ranks above similarity, exclusions (current file, recent-tab files, secret paths), unrelated code returns nothing, budget cut at line boundaries.
- `test/workspace-perf.test.ts` passes within its budgets.
- Integration test (real VS Code, fake Ollama, temp workspace): a **closed** file defines `computeInvoiceTotal`; calling it in another file puts its definition in the prompt; `.env` and `node_modules/` files never appear.
- `bench:context` recorded in spec §11: noise below hits on this repo.
- `bench` recorded for 2 models across the three variants.
- Manual: a completion uses a name that exists only in a closed file; a large repo (2k+ files) shows no typing lag while indexing; toggling off drops `workspace_chars` to 0.

## Left to the builder

Chunk size and overlap, tokenizer details, the exact declaration patterns and common-token list, the score threshold (tuned with `bench:context`), pacing details, module names, and how `.gitignore` is honored.

## Calls made in this design (not yet confirmed by the user)

1. Lexical retrieval (definition match + similarity) instead of embeddings. Embeddings stay a later option if `bench:context` shows too much noise or too few hits.
2. The index is in memory only and rebuilt on each start.
3. `workspaceContext` defaults to **on**.
4. At most 2 snippets, a ceiling of `maxContextChars / 4`, and nothing when nothing is clearly relevant.
5. Caps of 5000 files and 256 KB per file.
6. Perf budgets: retrieval p95 ≤ 5 ms and longest indexing step ≤ 16 ms, enforced in `npm test`.
