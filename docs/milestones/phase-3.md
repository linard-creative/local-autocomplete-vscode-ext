# Phase 3 — Completion quality (0.3.0)

## Shipped

- `prompt.ts`: built-in raw FIM templates (Qwen/CodeGemma, DeepSeek, StarCoder, CodeLlama) matched by model name or `/api/show` family, used only when the model lacks the `insert` capability; prefix-only remains the last fallback
- `models.ts`: profile resolution `insert` → template → prefix-only, logged once per model at info level
- Single- vs multi-line mode (`isSingleLine` in `context.ts`): code after the cursor on the same line adds a `\n` stop and caps output at 1 line; otherwise 15 lines
- `filter.ts`, full spec §10 rules: fences, repeated cursor line, suffix overlap (≥ 3 chars, exact), leading prose line, truncated last line, line cap
- `context.ts`: the import block is prepended when the prefix window doesn't reach the top of the file
- `provider.ts`: skip while IntelliSense has a selection (`selectedCompletionInfo`) and when the cursor is inside an identifier; `done_reason` added to the debug log line

## Acceptance (spec §19)

- [x] Filter unit tests cover every rule, including untouched valid code (`test/pipeline.test.ts`, 25 tests)
- [x] Mid-line completions don't duplicate the suffix: live check with `qwen2.5-coder:7b`, where `Math.max(|));` returned `v, min));` and was cleaned to `v, min`
- [x] Manual in VS Code: mid-line and multi-line suggestions look right while typing (confirmed by user)

## Decisions / deviations (recorded in spec §8 and §10)

- Import block = file head through the last import line (keeps multi-line imports whole), skipped if it exceeds 25% of the budget; the 20-line cap was dropped.
- The prose-line rule applies to all models, not only prefix-only ones.
- Built-in FIM templates are unverified for models other than Qwen (it uses native `insert`); spec §8 schedules manual validation in Phase 5.
- Suffix overlaps under 3 chars (a lone `)` or `}`) are not trimmed, to avoid cutting valid code.
- `tsconfig` lib raised to ES2023 for `Array.prototype.findLastIndex` (Node 22 supports it).
