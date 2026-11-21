# Declaration Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the cursor sits on the name of a new declaration (`const u|`, `function get|`, `type |`), the ghost text is only the rest of that name.

**Architecture:** `context.ts` detects a declaration-name position from the cursor line. `prompt.ts` caps that request at 16 tokens with a `\n` stop. `filter.ts` keeps only the leading identifier of the cleaned completion. `provider.ts` wires the three together; context sources are unchanged.

**Tech Stack:** TypeScript (strict), VS Code inline completion API, Vitest, `@vscode/test-electron` integration suite with a fake Ollama.

**Spec:** `docs/superpowers/specs/2026-11-21-declaration-names-design.md` (read with `docs/spec.md` §9, §10, §19).

## Global Constraints

- Zero runtime dependencies. `fetch` only in `src/ollama.ts`.
- `context.ts`, `prompt.ts`, `filter.ts` must not import `vscode`.
- Never log source code, prompts, completions or paths. The debug line gets `mode=name|code` only.
- No new setting or command. At most one request in flight (N1).
- Run `npm run typecheck`, `npm run lint`, `npm test` before calling any task done.
- Commits: ask the user before the first commit of the session.

## Review Focus

1. A keyword in a comment or string (`// we use const u`) → no name mode. Pinned in Task 2 (`declName` is anchored to the line start).
2. Destructuring (`const { |`, `const [a, |`) → no name mode. Pinned in Task 2.
3. With a partial name typed, the model returns a non-name (` = 1;`) → nothing shown, never a stray space. Pinned in Task 2.
4. A user `maxTokens` below 16 → the lower value wins. Pinned in Task 2.
5. Auto-closed or existing text after the name (`function get|()`, `const u| = 1`) → the name is a plain insert, the rest stays. Pinned in Task 3.

---

### Task 1: Check whether the word list hides ghost text at a declaration name

The design's open risk. VS Code's word-based suggestions may open with a selection at `const u`, and the provider returns early on `selectedCompletionInfo`. This task pins today's behavior in the integration suite before any feature code.

**Files:**
- Modify: `test/integration/suite.ts` (new block after the Phase 9 block, before `finally`)

**Interfaces:**
- Produces: a `// Phase 10` block that later tasks extend; its result decides whether Task 4 runs.

- [ ] **Step 1: Add the check**

In a new untitled TypeScript doc with content `const userName = 1;\n`, put the cursor at (1, 0), then `await vscode.commands.executeCommand('type', { text: 'const u' })` so quick suggestions fire as they would for a user. Set `replies['/api/generate'] = { response: 'serName2 = 2;', done: true, done_reason: 'stop' }`. Record `const before = generates.length`, then loop up to 30 times: `inlineSuggest.trigger`, `sleep(100)`, stop once `generates.length > before`. Assert `generates.length > before` with message `'a declaration name still sends a request while the word list is open'`.

- [ ] **Step 2: Run it**

Run: `npm run test:integration`
Expected, either:
- PASS → the word list does not block the request. Skip Task 4.
- FAIL on that message → the risk is real. Task 4 is required. Keep the assertion; it will pass after Task 4.

Record which one happened in `docs/milestones/phase-10.md` (Task 5).

- [ ] **Step 3: Commit**

```bash
git add test/integration/suite.ts
git commit -m "Integration check: request at a declaration name"
```

---

### Task 2: Pure functions: detect, cap, cut

**Files:**
- Modify: `src/context.ts`, `src/prompt.ts` (`buildRequest`, ~line 161), `src/filter.ts`
- Test: `test/pipeline.test.ts`

**Interfaces:**
- Produces:
  - `context.ts`: `export function declName(before: string): string | undefined`. `before` is the cursor line's text up to the cursor. Returns the partial name (`''` right after the keyword) or `undefined`.
  - `prompt.ts`: `export const NAME_TOKENS = 16;` and `buildRequest(ctx, file, profile, s, recent = '', name = false)`.
  - `filter.ts`: `export function nameOnly(text: string, partial: string): string | undefined`.

- [ ] **Step 1: Write the failing tests** in `test/pipeline.test.ts`: the first three in a new `describe('declaration names', …)`, the fourth inside the existing `describe('buildRequest', …)` (it has `s` = default settings and `file`):

```ts
it('detects a declaration name with its partial', () => {
  for (const kw of ['const', 'let', 'var', 'val', 'function', 'class', 'interface', 'type', 'enum', 'struct', 'trait', 'def', 'fn', 'func'])
    expect(declName(`${kw} us`)).toBe('us');
  expect(declName('const ')).toBe('');
  expect(declName('  export default async function get')).toBe('get');
  expect(declName('pub fn ma')).toBe('ma');
  expect(declName('let mut co')).toBe('co');
  expect(declName('export const $el')).toBe('$el');
});

it('ignores non-declarations, comments, strings and destructuring', () => {
  for (const line of ['let x = u', 'return u', 'constant', 'const', '// we use const u', 'x = "type U', 'const { a', 'const [a, ', 'const 1'])
    expect(declName(line)).toBeUndefined();
});

it('keeps only the name the model wrote', () => {
  expect(nameOnly('serName = 1;', 'u')).toBe('serName');
  expect(nameOnly(' userName = 1;', '')).toBe('userName');
  expect(nameOnly(' = 1;', 'u')).toBeUndefined();
  expect(nameOnly('{ a, b }', '')).toBeUndefined();
});

it('caps a name request at 16 tokens with a newline stop, and never raises maxTokens', () => {
  const ctx = { prefix: 'const u', suffix: '\n' };
  const native = buildRequest(ctx, file, { insert: true }, s, '', true);
  expect(native.options.num_predict).toBe(16);
  expect(native.options.stop).toEqual(['\n']);
  expect(buildRequest(ctx, file, { insert: true }, { ...s, maxTokens: 8 }, '', true).options.num_predict).toBe(8);
  expect(buildRequest(ctx, file, { insert: true }, s).options.num_predict).toBe(s.maxTokens);
});
```


- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/pipeline.test.ts`
Expected: FAIL, `declName` / `nameOnly` not exported.

- [ ] **Step 3: Implement `declName` in `src/context.ts`**

Anchored at the line start so comments and strings don't match:

```ts
const DECL = /^\s*(?:(?:export|default|declare|async|pub|abstract|static|public|private|protected)\s+)*(?:const|let|var|val|function\*?|class|interface|type|enum|struct|trait|def|fn|func)\s+(?:mut\s+)?([A-Za-z_$][\w$]*|)$/;
```

Return `DECL.exec(before)?.[1]`. One-line comment: the keyword list mirrors `DEF` in `retrieve.ts`.

- [ ] **Step 4: Implement the cap in `buildRequest`**

With `name`: `lineStop` is `['\n']` and `num_predict` is `Math.min(s.maxTokens, NAME_TOKENS)`. All three branches (native, template, prefix-only) already use `lineStop` and `options`, so nothing else changes.

- [ ] **Step 5: Implement `nameOnly` in `src/filter.ts`**

Trim the start only when `partial === ''`, take `/^[\w$]*/`, return `undefined` when empty.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/context.ts src/prompt.ts src/filter.ts test/pipeline.test.ts
git commit -m "Detect declaration names, cap and cut name completions"
```

---

### Task 3: Wire name mode into the provider

**Files:**
- Modify: `src/provider.ts` (`provideInlineCompletionItems`)
- Test: `test/provider.test.ts`, `test/integration/suite.ts` (extend the Phase 10 block)

**Interfaces:**
- Consumes: `declName`, `buildRequest(..., name)`, `nameOnly` from Task 2.

- [ ] **Step 1: Write the failing provider tests** in `describe('provider concurrency', …)`:

- `'suggests only a name at a declaration'`: doc body `'const userName = 1;\nconst u'`, position `{ line: 1, character: 7 }`. The doc's `lineAt` must return the cursor line for a `Position` (build the doc inline, or make `docAt`'s `lineAt` use `l.line` for positions; existing tests use line 1 = `'  '` either way). Respond `'serName2 = 2;'`. Expect `insertText` `'serName2'` and the request body's `options.num_predict` `16` (read it from `fetchMock.mock.calls`).
- `'keeps the rest of the line after a name'`: body `'function get()'`, position `{ line: 0, character: 12 }`, respond `'User'`. Expect `insertText` `'User'` and an empty range (start equals end).
- `'leaves normal completions alone'`: the existing `text` fixture still sends `num_predict` equal to the configured `maxTokens` default.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/provider.test.ts`
Expected: FAIL, `insertText` is `'serName2 = 2;'`.

- [ ] **Step 3: Implement in `src/provider.ts`**

After the mid-word skip: `const name = declName(document.lineAt(position).text.slice(0, position.character));`. Pass `name !== undefined` as `buildRequest`'s 6th argument. After `cleanCompletion`, when `name !== undefined && text`, set `text = nameOnly(text, name)`. Add `mode=${name === undefined ? 'code' : 'name'}` to the debug line, before `outcome=`.

- [ ] **Step 4: Run the unit tests**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Extend the integration check**

In the Phase 10 block, after the request assertion: loop up to 50 times `inlineSuggest.trigger`, `sleep(100)`, `inlineSuggest.commit` until line 1 changes. Assert line 1 is `'const userName2'` (`'only the name is inserted'`) and the last generate's `options.num_predict` is `16`. If Task 1 failed, this also fails until Task 4.

- [ ] **Step 6: Run it**

Run: `npm run test:integration`
Expected: PASS if Task 1 passed; otherwise FAIL on the Task 1 assertion (go to Task 4).

- [ ] **Step 7: Commit**

```bash
git add src/provider.ts test/provider.test.ts test/integration/suite.ts
git commit -m "Ghost text suggests only the name at a declaration"
```

---

### Task 4 (only if Task 1 failed): Work with the word list's selection

VS Code shows an inline item while the suggest widget has a selection only if the item's range equals `selectedCompletionInfo.range` and its text starts with `selectedCompletionInfo.text`.

**Files:**
- Modify: `src/provider.ts`
- Test: `test/provider.test.ts`

- [ ] **Step 1: Write the failing tests**

- `'extends the selected word at a declaration name'`: body `'const userName = 1;\nconst u'`, position (1, 7), context `{ selectedCompletionInfo: { range: <(1,6)-(1,7)>, text: 'userName' } }`, respond `'serName2 = 2;'`. Expect `insertText` `'userName2'` and the item range equal to the selection range.
- `'shows nothing when the name does not extend the selected word'`: same, respond `'sers'`. Expect `undefined`.
- `'still skips a selection outside a declaration name'`: the `text` fixture with a `selectedCompletionInfo` sends no request.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/provider.test.ts`
Expected: FAIL, no request sent at the declaration.

- [ ] **Step 3: Implement**

Move the `declName` call above the `selectedCompletionInfo` skip, and skip only when `name === undefined`. When a selection exists and the cut name is set: the full text is the typed partial plus the name (`line.slice(sel.range.start.character, position.character) + text`). Return it over `sel.range` only if it starts with `sel.text`, else return nothing.

- [ ] **Step 4: Run all tests**

Run: `npm test && npm run test:integration`
Expected: PASS, including the Phase 10 integration block.

- [ ] **Step 5: Commit**

```bash
git add src/provider.ts test/provider.test.ts
git commit -m "Declaration names extend the word list's selection"
```

---

### Task 5: Spec, milestone, version

**Files:**
- Modify: `docs/spec.md` (§10 new bullet after "Single- vs multi-line"; §19 new row 10; §21/§22 only if Task 4 ran: question 4 is partly answered), `docs/milestones/README.md` (index row + phase section), `CHANGELOG.md` (rename `Unreleased` to `0.10.0`, add the feature first), `package.json` + `package-lock.json` (`0.10.0`)
- Create: `docs/milestones/phase-10.md`

- [ ] **Step 1: Write the docs**

§10 bullet: a declaration name is detected by `declName`; such a request uses at most `NAME_TOKENS` (16) and a `\n` stop; the result is cut to the leading identifier; context is unchanged. §19 row "10. Declaration names" with the design's acceptance list. `phase-10.md` follows `phase-9.md`'s layout: Shipped, Acceptance (unit and integration boxes checked once they pass; manual boxes unchecked), Decisions (the Task 1 outcome, the anchored regex, the 16-token cap).

- [ ] **Step 2: Bump the version**

Run: `npm version 0.10.0 --no-git-tag-version`
Expected: `v0.10.0`, `package.json` and `package-lock.json` updated.

- [ ] **Step 3: Full check**

Run: `npm run typecheck && npm run lint && npm test && npm run test:integration`
Expected: all pass, no lint warnings.

- [ ] **Step 4: Hand the manual checks to the user**

Run `npm run install:ext`. Ask the user to check in TypeScript and Python: `const |` and `function get|` show only a name; Tab gives a name that fits nearby code; `let x = |` behaves as before. Check those boxes in `phase-10.md` only after they confirm.

- [ ] **Step 5: Commit**

```bash
git add docs CHANGELOG.md package.json package-lock.json
git commit -m "Phase 10: declaration names (0.10.0)"
```
