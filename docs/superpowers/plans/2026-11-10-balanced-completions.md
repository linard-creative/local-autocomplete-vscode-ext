# Balanced Completions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop showing ghost text that leaves the code with broken brackets or quotes: a duplicated closing `}`/`)`/`]`, or a single-line completion that unbalances a line that was balanced.

**Architecture:** Two more conservative filter rules in `src/filter.ts`, next to `replacesRest` (Phase 7, shipped in 0.7.0). (1) In multi-line mode, cut the completion before the first closing bracket it did not open itself when the code after the cursor supplies that same closer next. (2) In single-line mode, drop the completion when inserting it turns a balanced cursor line into an unbalanced one. The provider uses one new decision function, `fitLine`, in place of its direct `replacesRest` call. No prompt, model or settings changes.

**Tech Stack:** TypeScript, VS Code inline completion API, Vitest (`vscode` aliased to `test/vscode.ts`).

**Spec:** `docs/spec.md` §10 "Output cleanup" (rules 1–7) and §19 row "8. Balanced completions" (planned). Phase 7 (auto-closed suffix plus the 2026-11-10 audit fixes) shipped in 0.7.0 as commit `1164ad7`, so this plan is Phase 8 and ships as 0.8.0. The context has been LF-only since 0.7.0, so the filter only ever sees `\n`.

## Global Constraints

- Zero runtime dependencies. Dev dependencies only.
- `filter.ts` must not import `vscode`.
- Never log source code, prompts, completions or absolute paths. Log metadata only.
- Filter rules stay conservative: when unsure, keep the completion unchanged (rule 1) or show nothing (rule 2). Never rewrite code content or indentation.
- Run `npm run typecheck`, `npm run lint`, `npm test` before calling a task done.
- Check an acceptance box only once verified. Manual items need the user's confirmation.

## Review Focus

1. A closing bracket inside a string in the completion (`log("}")`) must not trigger the cut. Test in Task 1.
2. A completion that closes its own block and then the suffix's (`if (x) {\n  y();\n}\n}` before suffix `}`) keeps its own `}` and loses only the second. Test in Task 1.
3. A closer the completion needs (`a, b);` after `f(`) stays when the suffix's next closer is a different character (`}`). Test in Task 1 (updated existing test).
4. An escaped quote in a single-line completion (`"a\"b"`) counts as balanced and is shown. Test in Task 2.
5. A cursor line that is already unbalanced while the user edits (`if (a && (b|) {`) never gets its completion dropped. Test in Task 2.

---

### Task 0: Commit the Phase 7 working tree — done

- [x] Committed as `1164ad7` on `development` (0.7.0), together with the audit fixes. Typecheck, lint and 51/51 tests passed, plus the integration test.

---

### Task 1: Cut duplicated closing brackets in multi-line mode

Today a FIM model often finishes a block body and adds the `}` that already follows the cursor, giving `}\n}`. §10 rule 3 misses this because its exact-match minimum is 3 chars and the indentation often differs.

**Files:**
- Modify: `src/filter.ts` (new private function, one call inside `cleanCompletion` right after the rule 3 loop)
- Test: `test/pipeline.test.ts` (`describe('cleanCompletion')`)

**Interfaces:**
- Consumes: `isSingleLine(ctx)` from `src/context.ts`
- Produces: nothing exported. `cleanCompletion(raw, ctx, truncated)` keeps its signature.

- [x] **Step 1: Write the failing tests** in `describe('cleanCompletion')`

Change the existing test `'keeps short overlaps (under 3 chars) to avoid cutting valid code'`. The `}` it kept would duplicate the suffix's `}`, while the `)` is still kept:

```ts
it('keeps a needed closer but cuts the one the suffix already has', () => {
  expect(cleanCompletion('a, b);\n}', { prefix: 'f(', suffix: '\n}' })).toBe('a, b);');
});
```

Add:

```ts
it('cuts a closing brace the suffix already supplies', () => {
  const ctx = { prefix: 'function f() {\n  ', suffix: '\n}\n' };
  expect(cleanCompletion('return 1;\n}', ctx)).toBe('return 1;');
  expect(cleanCompletion('return 1; }', ctx)).toBe('return 1;');
});

it('keeps blocks the completion opens and closes itself', () => {
  const ctx = { prefix: 'function f() {\n  ', suffix: '\n}' };
  expect(cleanCompletion('if (x) {\n    y();\n  }\n}', ctx)).toBe('if (x) {\n    y();\n  }');
});

it('ignores closers inside strings', () => {
  expect(cleanCompletion('log("}");', { prefix: '{\n  ', suffix: '\n}' })).toBe('log("}");');
});

it('leaves closers alone when the suffix does not start with one', () => {
  expect(cleanCompletion('x();\n}', { prefix: '{\n  ', suffix: '\nfoo();' })).toBe('x();\n}');
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pipeline.test.ts -t cleanCompletion`
Expected: FAIL on the first three new or changed tests (output still ends in `}`). The last two pass already.

- [x] **Step 3: Implement `cutDuplicateCloser(text: string, suffix: string): string` in `src/filter.ts`**

Call it after the rule 3 loop: `if (!isSingleLine(ctx)) text = cutDuplicateCloser(text, ctx.suffix);`. Single-line mode is left to `replacesRest`/`fitLine`.

Algorithm:
- `next` = first character of `suffix.trimStart()`. If it is not one of `)`, `]`, `}`, return `text` unchanged.
- Scan `text` left to right with a stack of openers and a current-quote state:
  - Inside a quote: `\` skips the next char. The same quote char ends the string. A newline ends a `"` or `'` string, but not a `` ` `` one.
  - Outside: `"`, `'` or `` ` `` starts a string. `(`, `[`, `{` push. `)`, `]`, `}` pop if the stack is non-empty. With an empty stack the closer is *unmatched*: if it equals `next`, cut here. Otherwise keep scanning.
- Cut: if the line holding the closer has only whitespace before it, return `text.slice(0, lineStart).trimEnd()`. Otherwise return `text.slice(0, i).trimEnd()`.
- Add `// shortcut: no comment or regex awareness and the scan assumes the completion starts outside a string; upgrade if logs show wrong cuts.` above the function.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites.

- [x] **Step 5: Commit**

```bash
git add src/filter.ts test/pipeline.test.ts
git commit -m "Cut closing brackets the suffix already supplies (multi-line)"
```

---

### Task 2: Drop single-line completions that break a balanced line

A completion such as `"hello` or `a, b))` inserted before an auto-closed `)` leaves the line broken, and Phase 7 only handles the case where replacing the rest fixes it.

**Files:**
- Modify: `src/filter.ts` (new export next to `replacesRest`, reusing the private `balanced`)
- Modify: `src/provider.ts:5, 160-169` (use `fitLine`, log the outcome)
- Test: `test/pipeline.test.ts` (new `describe('fitLine')`)

**Interfaces:**
- Consumes: `replacesRest(before, text, rest)` and private `balanced(line)` in `src/filter.ts`
- Produces: `export function fitLine(before: string, text: string, rest: string): 'insert' | 'replace' | undefined`

- [x] **Step 1: Write the failing tests**

```ts
describe('fitLine', () => {
  it('replaces when replacesRest holds', () => {
    expect(fitLine('console.log("', 'x", x)', '")')).toBe('replace');
  });

  it('drops a completion that unbalances a balanced line', () => {
    expect(fitLine('foo(', 'a, b))', ')')).toBeUndefined();
    expect(fitLine('log(', '"hello', ')')).toBeUndefined();
    expect(fitLine('x = [', '1, 2}', ']')).toBeUndefined();
  });

  it('inserts balanced completions, escaped quotes included', () => {
    expect(fitLine('foo(', 'a, b', ')')).toBe('insert');
    expect(fitLine('x = foo(', '"a\\"b"', ')')).toBe('insert');
  });

  it('never drops on a line that was already unbalanced or has no rest', () => {
    expect(fitLine('if (a && (b', ' || c', ') {')).toBe('insert');
    expect(fitLine('const s = ', '"hello', '')).toBe('insert');
    expect(fitLine('if (x) ', '{', '')).toBe('insert');
  });

  it('leaves multi-line text alone', () => {
    expect(fitLine('foo(', 'a,\n  b', ')')).toBe('insert');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pipeline.test.ts -t fitLine`
Expected: FAIL with "fitLine is not a function" (or a missing export error).

- [x] **Step 3: Implement `fitLine` in `src/filter.ts`**

Order: `replacesRest(...)` → `'replace'`. Else, if `rest` is non-empty, `text` has no `\n`, `balanced(before + rest)` and `!balanced(before + text + rest)` → `undefined`. Else `'insert'`. Requiring a non-empty `rest` keeps a block opener such as `{` at the end of an empty line from being dropped. Doc comment: one line saying what each return value means.

- [x] **Step 4: Wire it into `provider.ts`**

Compute the fit before the debug log so the log reports what happened. Replace the `replacesRest` import with `fitLine`. After `text`:
- `const fit = text ? fitLine(line.slice(0, position.character), text, rest) : undefined;` (with `line` and `rest` computed as today)
- In the debug line, `outcome=` becomes `stale` / `empty` (no text) / `unbalanced` (text but `fit` undefined) / `shown`.
- Return `undefined` unless `fit`. The range end is `position.translate(0, rest.length)` for `'replace'`, else `position`.

- [x] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass, including the existing `provider.test.ts` suite unchanged.

- [x] **Step 6: Commit**

```bash
git add src/filter.ts src/provider.ts test/pipeline.test.ts
git commit -m "Drop single-line completions that unbalance the line"
```

---

### Task 3: Spec, changelog, version, milestone

**Files:**
- Modify: `docs/spec.md` §10 (add rules 8 and 9 after rule 7) and §19 Phase 8 row (already added as planned)
- Modify: `docs/milestones/README.md` (Phase 8 row and section, already added as planned)
- Modify: `CHANGELOG.md` (new `## 0.8.0`), `package.json` + `package-lock.json` (`npm version 0.8.0 --no-git-tag-version`)
- Create: `docs/milestones/phase-8.md`

- [x] **Step 1: Spec §10.** Rule 8: in multi-line mode, cut before the first closing bracket the completion did not open when the suffix's first non-whitespace char is that same closer (strings skipped, no comment awareness). Rule 9: in single-line mode, show nothing when inserting the completion turns a balanced cursor line into an unbalanced one (`fitLine`). Debug `outcome=unbalanced`.

- [x] **Step 2: Spec §19.** Tag the Phase 8 row **[Done in 0.8.0]** and adjust its deliverables if the implementation deviated.

- [x] **Step 3: CHANGELOG `## 0.8.0`.** Two bullets: cuts a duplicated closing bracket, hides single-line suggestions that would break brackets or quotes. Bump the version to `0.8.0`.

- [x] **Step 4: Verify and package**

Run: `npm run typecheck && npm run lint && npm test && npm run test:integration && npm run install:ext`
Expected: all pass, and `output/local-autocomplete-0.8.0.vsix` is installed.

- [x] **Step 5: Milestone.** Add `docs/milestones/phase-8.md` (shipped, acceptance, decisions). Set the README row to "Done (manual check pending)" and link it. Check acceptance boxes only once verified.

- [x] **Step 6: Commit**

```bash
git add docs/spec.md docs/milestones/README.md docs/milestones/phase-8.md CHANGELOG.md package.json package-lock.json
git commit -m "Phase 8: balanced completions (0.8.0)"
```

- [ ] **Step 7: Manual check (user).** Run the §19 manual items with `Local Autocomplete` debug logging on, and watch for `outcome=unbalanced` counts. Once the user confirms, check the manual box in `phase-8.md` and set the README row to Done. The Phase 7 manual check (Python `print('|')` with a real model) can be done in the same pass.
