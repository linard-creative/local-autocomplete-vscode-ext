# Phase 10 — Declaration names (unreleased)

Design: [2026-11-21-declaration-names-design.md](../superpowers/specs/2026-11-21-declaration-names-design.md). Plan: [2026-11-21-declaration-names.md](../superpowers/plans/2026-11-21-declaration-names.md).

## Shipped

- `context.ts`: `declName(before)` finds a declaration name at the cursor (keyword, optional modifiers, optional partial identifier), anchored at the line start.
- `prompt.ts`: `NAME_TOKENS = 16`; `buildRequest(..., name)` caps `num_predict` (never above `maxTokens`) and adds a `\n` stop.
- `filter.ts`: `nameOnly(text, partial)` keeps the leading identifier.
- `provider.ts`: name mode wired in after the mid-word skip; debug field `mode=name|code`. A typed name the model treats as complete keeps its one-line continuation (`function getUser` → `(id: string) {`), unless cut at the token limit.
- Tests: four in `test/pipeline.test.ts`, three in `test/provider.test.ts`, one integration check in `test/integration/suite.ts`.

## Acceptance (spec §19)

- [x] Unit tests: `declName` on each keyword, modifiers, empty and partial names, non-matches (comments, strings, destructuring, expressions); `nameOnly`; the 16-token cap and `\n` stop; text after the name stays (`function get|()`); the continuation after a complete name; normal completions unchanged. 108/108 overall.
- [x] Integration (real VS Code 1.147, fake Ollama): typing `const u` beside `userName` sends a request, and accepting (`inlineSuggest.commit`) gives `const userName2` with `num_predict` 16. The test does not prove the word list was open.
- [x] Manual (TypeScript and Python): `const |` and `function get|` show a name only, and it fits nearby code.
- [x] Manual: with the word list open at `const u` (it offers `userName`), the name ghost text still shows, and Tab's behaviour is noted.
- [x] Manual: `let x = |` behaves as before. Confirmed by the user 2026-11-21.

## Decisions / deviations (recorded in spec §10)

- The open risk was the word list hiding the name. The integration check could not show the list was open; the user's manual check (2026-11-21) found it works, so the "extend the selected word" fallback (plan Task 4) was not needed.
- Final review: a complete typed name (`function getUser`) showed nothing, a regression against the plain continuation. It now keeps the one-line continuation unless truncated; this widens the design's "nothing after the name" rule.
- `declName` is anchored at the line start, so `for (const x|` gets no name mode; comments and strings never do.
- Numbered 10 with phase 11 (member types) built in parallel; neither is released, so no version bump yet.
