# Changelog

## 0.9.0

- **Workspace context:** suggestions can use code from files that aren't open, including the definition of a function or type you call from another file.
  - A background index of the workspace adds at most 2 snippets per suggestion: the definition of a name used near the cursor first, then similar code. When nothing clearly matches, it adds nothing.
  - Controlled by the new `workspaceContext` setting (on by default) and the **Toggle Workspace Context** command. The status bar tooltip shows indexing progress.
- **Workspace context stays out of your way:**
  - Indexing starts a few seconds after VS Code starts and reads one file at a time. It pauses while a suggestion is being generated, so typing never slows down.
  - It runs only while autocomplete is on and a model is selected.
  - The index lives in memory only (about 30 MB for 5000 files) and is rebuilt on each start.
- **What workspace context never reads:**
  - secret files
  - files over 256 KB, binary and minified files
  - `node_modules`, `.git`, `dist`, `out`, `build`, `target`, `vendor`, `.venv` and `coverage`
  - anything in `files.exclude` (including `when` conditions such as compiled `.js` next to its `.ts`) or in the root `.gitignore`
  - languages in `disabledLanguages`

  At most 5000 code files are indexed.
- **Workspace context keeps up with your changes:**
  - Edited, created, deleted and renamed files and folders are picked up without a reload, and so are changes to `.gitignore`, `files.exclude`, `disabledLanguages`, workspace folders and installed language extensions.
  - A checkout that creates hundreds of files triggers one scan, not one per file.
- **Fewer misleading snippets:**
  - Only definitions of specific names (`computeInvoiceTotal`, `UserProfile`, `parse_config`) are looked up. Plain words, local variables and property names are not.
  - A name defined in more than 3 files, or already defined in the current file or a recent tab, is skipped.
- **Multi-root workspaces:** file paths sent to the model include the folder name when several folders are open, so files with the same path in two folders no longer collide. Single-folder paths are unchanged.
- **Endpoint warning:** the warning for a non-local endpoint now says that snippets of other workspace files may be sent too.
- **New icon** for the extension and the README header.
- **For developers:**
  - The debug metrics line adds `workspace_chars`, `workspace_ms` and `workspace_hits`.
  - New `npm run bench:context` measures index speed, memory and retrieval quality (hit / noise / silent). `npm run bench` gets a workspace variant.
  - `npm test` now enforces performance budgets: retrieval p95 ≤ 5 ms on 5000 files, at most 16 ms per indexed file, and a memory ceiling.

## 0.8.0

- A multi-line suggestion no longer repeats a closing bracket that already follows the cursor (no more `}` twice at the end of a block)
- Single-line suggestions that would break the brackets or quotes of a balanced line (e.g. `a, b))` or `"hello` inside `foo()`) are no longer shown

## 0.7.0

- Suggestions no longer leave auto-closed characters behind: typing `console.log("` or `if(` and accepting gives `console.log("a", a)` and `if(!a) return null;` instead of an extra `")` or `)` at the end of the line
- Files with Windows line endings (CRLF) no longer get doubled closing braces, and the model now sees LF line endings
- A model that was missing comes back by itself within 10 s of `ollama pull`. An endpoint with a wrong path (e.g. ending in `/api`) now shows an Ollama error instead of "model not installed".
- Imports on line 50 of a long file are kept in the context, and a rare unhandled error in recent-tab outlines is gone

## 0.6.0

- Recent tabs context: an outline (declaration lines from VS Code's symbol provider) of your 3 most recently used open tabs is sent along with the current file (`recentTabs`, `recentTabsCount`, **Toggle Recent Tabs Context** command). The list survives a restart, and closed tabs are never sent.
- Secret files (`.env*`, keys, credentials, `*.tfvars`, …) never get completions and are never sent as context
- Debug metrics line adds `recent_chars`, `prompt_eval` and `prompt_ms`; `npm run bench` runs each model with and without recent tabs

## 0.5.0

- README (setup, recommended models, privacy, troubleshooting) and this changelog
- Mocked-API tests for the Ollama client, and integration tests in a real VS Code against a fake Ollama (`npm run test:integration`)

## 0.4.0

- Longer timeout for cold models, 10 s offline backoff, error handling per state transition
- Debug metrics line per request (timings and sizes only), `npm run bench`

## 0.3.0

- Built-in FIM templates (Qwen, CodeGemma, DeepSeek, StarCoder, CodeLlama) for models without native insert
- Single- and multi-line modes, output cleanup (fences, repeats, suffix overlap, prose, truncation), import-block context

## 0.2.0

- Model picker and status bar, six commands, missing-model and non-local-endpoint warnings, abort on model switch

## 0.1.0

- First version: ghost-text completions from an Ollama model set in settings
