# Workspace Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completions that use what is in the whole codebase, including closed files, without getting noisier or slower: a background lexical index of the workspace, and at most 2 clearly relevant snippets per completion.

**Architecture:** `src/retrieve.ts` (no `vscode`) holds the index: per-file chunk records, a token → chunk inverted index, and a definition map, all keyed by workspace-relative path. It never stores file text. `src/indexer.ts` discovers files, reads them in small paced async steps, keeps the index current with a file watcher, and turns picks into snippet text by reading only the 1–2 winning files. `provider.ts` puts the snippets between the recent tabs and the current file, using the existing `recentBlock`. `buildRequest` is unchanged.

**Tech Stack:** TypeScript, VS Code API 1.101, Vitest (`vscode` aliased to `test/vscode.ts`), esbuild scripts.

**Spec:** `docs/spec.md` §10 (Workspace index, Workspace retrieval), §13, §14, §16, §19 row 9, and the design `docs/superpowers/specs/2026-11-10-workspace-context-design.md`. Phase 8 shipped as 0.8.0, so this ships as **0.9.0**.

**Deviations from the design, decided here (record them in spec §10 in Task 6):**
- The index keeps no file text, only token postings and line ranges. Snippet text is read from disk when the picks change. This keeps memory to postings (tens of MB at 5000 files), not every file's text.
- A definition snippet starts at the definition line (20 lines from there). Similarity chunks are fixed, non-overlapping 20-line windows.
- "Cached per query token set" becomes "cached per pick result". Picks are deterministic, so the same picks give byte-identical snippets and no extra disk reads. The query drops the partial identifier at the cursor, so typing inside a name never changes the picks.

## Global Constraints

- Zero runtime dependencies. Dev dependencies only.
- `src/ollama.ts` is the only module that calls `fetch`. No new Ollama endpoint, and no other host.
- `retrieve.ts`, `context.ts`, `prompt.ts`, `filter.ts`, `ollama.ts` and `config.ts` must not import `vscode`.
- Never log source code, prompts, completions, snippets or absolute paths. Metadata only.
- No synchronous file I/O in the extension (N3). No indexing during activation (N4): the indexer starts 3 s after activation.
- Never index or send: `isSecretFile` paths, files outside a workspace folder, excluded or ignored files, files over 256 KB, binaries, minified files, `disabledLanguages`.
- Caps: 5000 files, 2 snippets, snippet budget `Math.floor(maxContextChars / 4)` on top of the existing budgets.
- Run `npm run typecheck`, `npm run lint` and `npm test` before calling a task done. Check an acceptance box only once verified. Manual items need the user's confirmation.

## Review Focus

1. A name defined in many files (`render`, `init`, `handle`) must not pull in a random definition: a name defined in more than 3 files is ambiguous and ignored. Test in Task 1.
2. Typing inside an identifier (`comp` → `compu` → `compute`) must return identical picks, or the prompt cache is lost on every keystroke. Test in Task 1.
3. A deleted or rewritten file must never yield its old chunks or definitions. Test in Task 1.
4. CRLF files: line numbers in picks must match the LF-split text the indexer slices. Test in Task 1 (`set` normalizes) and Task 3 (`sliceLines` normalizes).
5. A minified bundle or a binary that slipped past the excludes must not be indexed. Test in Task 3 (`isIndexable`).

---

### Task 1: `retrieve.ts`, the index and picking

**Files:**
- Create: `src/retrieve.ts`
- Test: `test/retrieve.test.ts`

**Interfaces:**
- Produces:
  - `tokens(text: string): Set<string>`: identifiers matching `/[A-Za-z_$][\w$]*/g`, length ≥ 3, not in `COMMON`. Case-sensitive.
  - `definitions(text: string): Map<string, number>`: defined name → 0-based line of its first definition, names in `COMMON` dropped.
  - `interface Hit { path: string; languageId: string; start: number; end: number; kind: 'def' | 'sim' }` (lines, `end` exclusive)
  - `class WorkspaceIndex { set(path: string, languageId: string, text: string): void; delete(path: string): void; get size(): number; pick(prefix: string, window: string, exclude: ReadonlySet<string>): Hit[] }`
  - Constants (exported for the perf test and bench): `CHUNK_LINES = 20`, `QUERY_LINES = 21`, `MAX_HITS = 2`, `MAX_DEF_FILES = 3`, `MIN_SIM = 0.2` (tuned in Task 2), `FREQUENT = 2000`.

- [ ] **Step 1: Write the failing tests** in `test/retrieve.test.ts`

```ts
const invoice = 'import { Item } from "./item";\n\nexport function computeInvoiceTotal(items: Item[]): number {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n';

it('tokens drops keywords, short names and common words', () => {
  expect([...tokens('const total = items.map((x) => this.price); return total;')].sort()).toEqual(['items', 'map', 'price', 'total']);
});
it('definitions finds declarations across languages with their line', () => {
  const d = definitions('export function foo() {}\nclass Bar {}\ndef baz(x):\nconst qux = 1;\nfunc (r *T) Quux() {}\nlet n: number = 2;\n  method(a, b) {\nif (x) {\n');
  expect(Object.fromEntries(d)).toEqual({ foo: 0, Bar: 1, baz: 2, qux: 3, Quux: 4, n: 5, method: 6 });
});
it('a call to a name defined in another file picks that definition first', () => {
  const ix = new WorkspaceIndex();
  ix.set('src/invoice.ts', 'typescript', invoice);
  ix.set('src/other.ts', 'typescript', 'export function unrelated() {}\n');
  expect(ix.pick('const t = computeInvoiceTotal(cart.items);\n', '', new Set())[0])
    .toEqual({ path: 'src/invoice.ts', languageId: 'typescript', start: 2, end: 22, kind: 'def' });
});
it('a name the current window already defines is not looked up', () => {
  const ix = new WorkspaceIndex();
  ix.set('src/invoice.ts', 'typescript', invoice);
  expect(ix.pick('computeInvoiceTotal(x);\n', 'function computeInvoiceTotal() {}', new Set())).toEqual([]);
});
it('a name defined in more than 3 files is ambiguous and ignored', () => {
  const ix = new WorkspaceIndex();
  for (const f of ['a', 'b', 'c', 'd']) ix.set(`src/${f}.ts`, 'typescript', 'export function render() {}\n');
  expect(ix.pick('render();\n', '', new Set())).toEqual([]);
});
it('excluded paths, deleted files and rewritten files never come back', () => {
  const ix = new WorkspaceIndex();
  ix.set('src/invoice.ts', 'typescript', invoice);
  expect(ix.pick('computeInvoiceTotal(x);\n', '', new Set(['src/invoice.ts']))).toEqual([]);
  ix.set('src/invoice.ts', 'typescript', 'export const nothing = 1;\n');
  expect(ix.pick('computeInvoiceTotal(x);\n', '', new Set())).toEqual([]);
  ix.set('src/b.ts', 'typescript', invoice);
  ix.delete('src/b.ts');
  expect(ix.pick('computeInvoiceTotal(x);\n', '', new Set())).toEqual([]);
  expect(ix.size).toBe(1);
});
it('similar code is picked only above the threshold, at most one hit per file and 2 overall', () => {
  // three files sharing most tokens with the query, one unrelated
  ...
  expect(hits.map((h) => h.kind)).toEqual(['sim', 'sim']);
  expect(new Set(hits.map((h) => h.path)).size).toBe(2);
  expect(ix.pick('totally unrelated words here\n', '', new Set())).toEqual([]);
});
it('typing inside an identifier keeps the picks identical', () => {
  const ix = new WorkspaceIndex();
  ix.set('src/invoice.ts', 'typescript', invoice);
  const p = (tail: string) => ix.pick(`const t = computeInvoiceTotal(cart);\n${tail}`, '', new Set());
  expect(p('comp')).toEqual(p('compu'));
  expect(p('compu')).toEqual(p(''));
});
it('CRLF text gives the same line numbers as LF', () => {
  const a = new WorkspaceIndex(), b = new WorkspaceIndex();
  a.set('x.ts', 'typescript', invoice);
  b.set('x.ts', 'typescript', invoice.replace(/\n/g, '\r\n'));
  expect(b.pick('computeInvoiceTotal(1);\n', '', new Set())).toEqual(a.pick('computeInvoiceTotal(1);\n', '', new Set()));
});
```

The implementer fills the `...` in the similarity test with three ~20-line files whose tokens overlap the query by more than `MIN_SIM`, plus one unrelated file.

- [ ] **Step 2: Run `npx vitest run test/retrieve.test.ts`.** Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/retrieve.ts`**

- `COMMON`: keywords and builtins of JS/TS, Python, Go, Rust, Java, C#, C/C++, plus `this`, `self`, `true`, `false`, `null`, `undefined`, `None`, `True`, `False`, `string`, `number`, `boolean`, `void`, `any`, `int`, `str`, `const`, `return`, `function`, `export`, `import`, `from`. It must contain every word the `tokens` test drops.
- `definitions`: one pass per line with a few regexes. `(function\*?|class|interface|type|enum|struct|trait|def|fn|func|module|namespace)\s+(?:\([^)]*\)\s*)?NAME`; `(const|let|var|val)\s+NAME\s*[=:]`; a line-start method head `^\s*(export\s+)?((public|private|protected|static|async|readonly)\s+)*NAME\s*\([^)]*\)\s*(:[^{]*)?\{`; a Python/Ruby top-level assignment `^NAME\s*=[^=]`. Keep the first line per name. `COMMON` filters `if`/`for`/`while`.
- Storage (no text kept):
  - `files: Map<path, { id: number; languageId: string }>`. Every `set` assigns a new id, so old postings and definitions go stale automatically.
  - Chunks in parallel arrays: `chunkFile: number[]` (file id), `chunkStart: number[]`, `chunkSize: number[]` (token count).
  - `postings: Map<string, number[]>` (token → chunk ids). `defs: Map<string, { id: number; line: number }[]>`.
  - Liveness: an entry counts only if `files.get(path)?.id` equals its id. Keep `paths: string[]` by id for the reverse lookup.
  - `// shortcut: stale postings are skipped, not removed; add compaction if long sessions show memory growth.`
- `set` normalizes CRLF to LF, splits into `CHUNK_LINES` windows, and records tokens, postings and definitions.
- `pick(prefix, window, exclude)`:
  1. Query text = the last `QUERY_LINES` lines of `prefix`, with a trailing partial identifier (`/[\w$]+$/`) removed. `q = tokens(query)`. `wanted` = tokens of the query in order of last occurrence (nearest the cursor first), minus `definitions(window)` keys.
  2. Def hits: for each wanted name, take its live definitions outside `exclude`. Skip the name if they span more than `MAX_DEF_FILES` files. Otherwise take the first one (lowest path, then line) as `{ start: line, end: line + CHUNK_LINES, kind: 'def' }`. One hit per file. Stop at `MAX_HITS`.
  3. Sim hits for the remaining slots: count intersections per live chunk via `postings` for each token in `q`, skipping tokens with more than `FREQUENT` postings (they still count in `|q|`). Jaccard = `inter / (|q| + chunkSize − inter)`. Keep chunks ≥ `MIN_SIM` from files not in `exclude` and not already hit. Sort by score desc, then path, then start. One per file.

- [ ] **Step 4: Run `npx vitest run test/retrieve.test.ts`.** Expected: PASS. Then `npm run typecheck && npm run lint`.

---

### Task 2: Performance test, synthetic workspace, `bench:context`

**Files:**
- Create: `test/synthetic.ts`, `test/workspace-perf.test.ts`, `scripts/bench-context.ts`
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Consumes: `WorkspaceIndex`, `tokens`, `MIN_SIM` from Task 1.
- Produces: `syntheticFiles(count: number, seed: number): { path: string; languageId: string; text: string }[]` and `bigFile(bytes: number, seed: number): string` in `test/synthetic.ts`. Seeded PRNG (mulberry32), no `Math.random`. Files are ~150 lines, alternating `.ts` and `.py`, with functions and classes named from a shared ~2000-word vocabulary so definitions and cross-file calls exist. `bench:context` script: `"bench:context": "esbuild scripts/bench-context.ts --bundle --platform=node --format=esm --outfile=dist/bench-context.mjs --log-level=warning && node dist/bench-context.mjs"`.

- [ ] **Step 1: Write `test/workspace-perf.test.ts`**

```ts
const files = syntheticFiles(5000, 1);
const ix = new WorkspaceIndex();
const before = process.memoryUsage().heapUsed;
for (const f of files) ix.set(f.path, f.languageId, f.text);
const heapMb = (process.memoryUsage().heapUsed - before) / 2 ** 20;

it('retrieval p95 ≤ 5 ms over 500 queries on 5000 files', () => {
  const times = queries(500).map((q) => { const t = performance.now(); ix.pick(q, q, new Set()); return performance.now() - t; }).sort((a, b) => a - b);
  expect(times[Math.ceil(0.95 * times.length) - 1]).toBeLessThanOrEqual(5);
});
it('the longest indexing step (one 256 KB file) ≤ 16 ms', () => {
  const big = bigFile(256 * 1024, 2);
  const t = performance.now(); new WorkspaceIndex().set('big.ts', 'typescript', big);
  expect(performance.now() - t).toBeLessThanOrEqual(16);
});
it('index memory stays under the ceiling', () => expect(heapMb).toBeLessThanOrEqual(HEAP_CEILING_MB));
it('the same query gives identical picks', () => expect(ix.pick(q0, q0, new Set())).toEqual(ix.pick(q0, q0, new Set())));
```

`queries(n)` takes the 21 lines before seeded random offsets in random synthetic files. Warm up with 20 untimed queries first.

- [ ] **Step 2: Run `npx vitest run test/workspace-perf.test.ts` with `HEAP_CEILING_MB = Infinity` and log `heapMb`.** Then set `HEAP_CEILING_MB` to 2× the measured value, rounded up to 10 MB, with a one-line comment giving the measured value and date. If the p95 or step budget fails, fix `retrieve.ts` (budgets are fixed, the code adapts). Expected: PASS.

- [ ] **Step 3: Write `scripts/bench-context.ts`.** It prints:
  - Synthetic 5000 files: build ms, files/s, heap MB, retrieval p50/p95.
  - Quality on this repo: index every file under `src/` and `test/` except the fixture's own. For each `src/` file at cursor 30/60/90% (same offsets as `scripts/bench.ts`), run `pick(prefix, prefix + suffix, new Set([path]))` with `buildContext(text, offset, 6000)`.
    - **hit:** a picked snippet's tokens include a token of the real next 10 lines that is not in the prefix.
    - **noise:** something was picked but no hit.
    - **silent:** nothing picked.
  - It prints counts plus def/sim totals. Metadata only, no snippet text.

- [ ] **Step 4: Run `npm run bench:context`.** Tune `MIN_SIM` (try 0.1, 0.15, 0.2, 0.3) and pick the value with noise < hits and the most hits. Rerun Task 1 and Task 2 tests. Keep the printed output for Task 6.

---

### Task 3: `indexer.ts`, background discovery, reading and watching

**Files:**
- Create: `src/indexer.ts`
- Modify: `src/config.ts` (`workspaceContext: c.get<unknown>('workspaceContext') !== false`), `src/provider.ts` (`export` the existing `relPath`), `package.json` (setting `localAutocomplete.workspaceContext`: boolean, default `true`, description "Index the workspace in the background and send the most relevant snippets of other files as context. Secret, ignored and excluded files are never read.")
- Test: `test/indexer.test.ts`

**Interfaces:**
- Consumes: `WorkspaceIndex`, `Hit` (Task 1), `isSecretFile` (`context.ts`), `RecentFile` (`prompt.ts`), `relPath` and `settings()`.
- Produces:
  - `gitignoreGlobs(text: string): string[]`
  - `isIndexable(text: string): boolean`
  - `sliceLines(text: string, start: number, end: number): string`
  - `class WorkspaceIndexer implements vscode.Disposable { constructor(log: vscode.LogOutputChannel, isBusy: () => boolean, onProgress: () => void); start(): void; stop(): void; readonly status: string; snippets(prefix: string, window: string, exclude: ReadonlySet<string>): Promise<{ files: RecentFile[]; kinds: string }>; dispose(): void }`

- [ ] **Step 1: Write the failing tests** in `test/indexer.test.ts`

```ts
it('gitignoreGlobs turns simple lines into excludes and skips the rest', () => {
  expect(gitignoreGlobs('# c\n\nnode_modules/\n/dist\n*.log\nsrc/gen\n!keep.log\n')).toEqual(
    ['**/node_modules', '**/node_modules/**', 'dist', 'dist/**', '**/*.log', '**/*.log/**', 'src/gen', 'src/gen/**']);
});
it('isIndexable rejects binaries and minified files', () => {
  expect(isIndexable('const a = 1;\n')).toBe(true);
  expect(isIndexable('a\0b')).toBe(false);
  expect(isIndexable('x'.repeat(5000))).toBe(false); // average line length > 200
});
it('sliceLines cuts LF or CRLF text to the same lines', () => {
  expect(sliceLines('a\r\nb\r\nc\r\n', 1, 3)).toBe('b\nc');
  expect(sliceLines('a\nb\nc\n', 1, 3)).toBe('b\nc');
});
```

- [ ] **Step 2: Run `npx vitest run test/indexer.test.ts`.** Expected: FAIL.

- [ ] **Step 3: Implement `src/indexer.ts`**

- **`gitignoreGlobs`:** skip blank lines, `#` lines and `!` lines. Strip a trailing `/`. A pattern with a leading `/`, or a `/` in the middle, is anchored (leading `/` stripped); otherwise prefix `**/`. Emit `g` and `g/**`. Add `// shortcut: root .gitignore only, no negations; use findFiles2/useIgnoreFiles once it is stable API.`
- **`isIndexable`:** no `\0` in the first 8192 chars, and `text.length / lineCount ≤ 200`.
- **`start()`:** no-op if running or there are no workspace folders. After a 3 s `setTimeout`, it:
  1. builds the extension → languageId map once from `vscode.extensions.all[].packageJSON.contributes.languages[]` (`extensions`, lowercased);
  2. per folder, builds one exclude glob `{…}` from the built-in list (`**/node_modules/**`, `**/.git/**`, `**/dist/**`, `**/out/**`, `**/build/**`, `**/target/**`, `**/vendor/**`, `**/.venv/**`, `**/coverage/**`), the `true` keys of `files.exclude`, and `gitignoreGlobs` of the folder's root `.gitignore` (read with `workspace.fs.readFile`, missing file is fine). A custom exclude replaces `files.exclude`, which is why its keys are merged in;
  3. runs `findFiles(new RelativePattern(folder, '**/*'), exclude, remaining)` until 5000 files in total, then processes the queue.
- **Per file:**
  - wait while `isBusy()` (poll every 50 ms);
  - skip `isSecretFile(uri.fsPath)`, unknown extensions and `settings().disabledLanguages`;
  - `workspace.fs.stat` and skip files over 256 KB;
  - read, decode with `TextDecoder`, skip unless `isIndexable`;
  - `index.set(relPath(uri), languageId, text)`;
  - track the longest synchronous `set` in ms;
  - `await` a 5 ms `setTimeout` between files, so indexing never pegs a core;
  - call `onProgress` every 100 files and at the end.
- **When done:** log once at info level: `workspace index: files=N chunks=M skipped=K ms=T longest_step_ms=L`.
- **Watcher:** a `FileSystemWatcher('**/*')`.
  - Change: re-queue the URI if its path is already in the index.
  - Create: re-queue it only if `findFiles(new RelativePattern(folder, relative path), exclude, 1)` returns it, which reuses the same exclude.
  - Delete: `index.delete`.
- **`stop()`:** cancels the run, disposes the watcher, clears the index and queue.
- **`status`:**
  - `Workspace: off`
  - `Workspace: indexing D/N files`
  - `Workspace: N files indexed`
  - `Workspace: N files indexed (limit reached)`
- **`snippets`:**
  - `hits = index.pick(...)`; if `JSON.stringify(hits)` equals the last key, return the last result unchanged.
  - Otherwise, for each hit, find the file's URI in a `path → Uri` map kept during indexing, read it, and build `{ path, languageId, text: sliceLines(...) }`.
  - Skip hits whose read fails.
  - `kinds` = `hits.map((h) => h.kind).join(',')`.

- [ ] **Step 4: Run `npx vitest run test/indexer.test.ts`, then `npm run typecheck && npm run lint && npm test`.** Expected: PASS.

---

### Task 4: Wire into the provider and extension

**Files:**
- Modify: `src/provider.ts`, `src/extension.ts`, `package.json` (command `localAutocomplete.toggleWorkspaceContext`, title "Toggle Workspace Context")
- Test: `test/provider.test.ts`

**Interfaces:**
- Consumes: `WorkspaceIndexer.snippets`, `status`, `start`, `stop` (Task 3), `recentBlock` (`prompt.ts`).
- Produces:
  - `LocalInlineCompletionProvider.workspace?: Pick<WorkspaceIndexer, 'snippets'>` (set by `extension.ts`, like `recent`)
  - `get busy(): boolean` (true while `current` is set)

- [ ] **Step 1: Write the failing tests** in `describe('workspace context')` of `test/provider.test.ts`

```ts
const fakeWs = (calls: ReadonlySet<string>[] = []) => ({
  snippets: async (_p: string, _w: string, exclude: ReadonlySet<string>) => {
    calls.push(exclude);
    return { files: [{ path: 'lib/invoice.ts', languageId: 'typescript', text: 'export function computeInvoiceTotal() {}' }], kinds: 'def' };
  },
});
it('puts snippets after recent tabs and before the current file', async () => { /* open a recent tab /w/b.ts, set provider.workspace = fakeWs(); prompt order: '// File: b.ts' < '// File: lib/invoice.ts' < '// File: a.ts' */ });
it('excludes the current file and recent-tab files', async () => { /* calls[0] equals new Set(['a.ts', 'b.ts']) */ });
it('sends no snippets when workspaceContext is off', async () => { /* config.workspaceContext = false → prompt has no 'lib/invoice.ts' and snippets was never called */ });
it('is busy only while a request is in flight', async () => { /* busy false → true after debounce → false after respond */ });
```

- [ ] **Step 2: Run `npx vitest run test/provider.test.ts`.** Expected: the new tests FAIL.

- [ ] **Step 3: Implement**
- **`provider.ts`:**
  - Keep the recent files array, not just the block.
  - `exclude = new Set([relPath(document.uri), ...recentFiles.map((f) => f.path)])`.
  - When `s.workspaceContext && this.workspace`, time `snippets(ctx.prefix, ctx.prefix + ctx.suffix, exclude)`. Then `wsBlock = recentBlock(files, Math.floor(s.maxContextChars / 4))`.
  - Pass `recent + wsBlock` as `buildRequest`'s `recent` argument.
  - Add `workspace_chars=${wsBlock.length} workspace_ms=${…} workspace_hits=${kinds || '-'}` to the debug line.
- **`extension.ts`:**
  - Create `WorkspaceIndexer(log, () => provider?.busy ?? false, render)` and assign `provider.workspace`.
  - Call `start()` when `settings().workspaceContext`.
  - Push it to `subscriptions`.
  - Restart (`stop()` then `start()` when on) on changes to `localAutocomplete.workspaceContext`, `localAutocomplete.disabledLanguages` or `onDidChangeWorkspaceFolders`.
  - Add `\n${indexer.status}` to the tooltip.
  - Register `toggleWorkspaceContext` the same way as `toggleRecentTabs`.
  - Endpoint warning: "…will send your code, including snippets of other workspace files, to <host>…".

- [ ] **Step 4: Run `npm run typecheck && npm run lint && npm test`.** Expected: PASS.

---

### Task 5: Integration test, a closed file reaches the prompt and ignored files never do

**Files:**
- Modify: `test/integration/run.ts`, `test/integration/suite.ts`

- [ ] **Step 1: Extend the temp workspace in `run.ts`**
  - `invoice.ts`: `export function computeInvoiceTotal(items: { price: number }[]): number {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n`. It is never opened.
  - `node_modules/pkg/index.ts`: contains `NODE_MODULES_MARKER` and a `computeInvoiceTotal` definition.
  - `.gitignore`: `generated/`
  - `generated/gen.ts`: contains `GITIGNORED_MARKER`.

- [ ] **Step 2: Append to `suite.ts`**
  - Open an untitled TypeScript document with `const t = computeInvoiceTotal(cart);\n` and the cursor on line 1.
  - Loop (hide, trigger, sleep 100 ms, up to 150 times, since indexing starts 3 s after activation) until a prompt contains `// File: invoice.ts (typescript)\nexport function computeInvoiceTotal`.
  - Assert it does.
  - Assert no prompt ever contains `NODE_MODULES_MARKER`, `GITIGNORED_MARKER` or `hunter2`.
  - Log how many ms the index took to appear.

- [ ] **Step 3: Run `npm run test:integration`.** Expected: PASS, including the earlier recent-tabs and Phase 7 checks.

---

### Task 6: Bench variant, docs, release prep

**Files:**
- Modify: `scripts/bench.ts`, `docs/spec.md` (§10 deviations above, §11 results), `README.md`, `CHANGELOG.md` (`## 0.9.0`), `package.json` (`"version": "0.9.0"`), `docs/milestones/README.md`
- Create: `docs/milestones/phase-9.md`

- [ ] **Step 1: `scripts/bench.ts`**
  - Build one `WorkspaceIndex` over the `sources`.
  - Add a third variant per model: recent tabs + workspace, where the workspace block is `recentBlock(hits → sliceLines(source text), 1500)` with the fixture's own path and its 3 recent files excluded.
  - Label the line `context off | recent | recent+workspace`.
- [ ] **Step 2: Docs**
  - Spec §10: the three deviations at the top of this plan.
  - Spec §11: a "Workspace context" table with the `bench:context` output and, once run with Ollama, the `bench` output.
  - README: a "Workspace context" section (what is read, what never is, the toggle).
  - CHANGELOG 0.9.0.
  - `phase-9.md` with the acceptance list from spec §19 row 9, with unverified items left unchecked.
  - Milestone index row: Done, 0.9.0.
- [ ] **Step 3: Verify.** Run `npm run typecheck && npm run lint && npm test && npm run test:integration && npm run build`. Expected: all PASS.
- [ ] **Step 4: Hand the manual checks to the user** (spec §19 row 9 manual items, plus `npm run bench -- qwen2.5-coder:7b qwen2.5-coder:1.5b`). Ask before committing. With the user's OK, commit as `Phase 9: workspace context (0.9.0)`.
