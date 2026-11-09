# Phase 8 — Balanced completions (0.8.0)

Plan: [2026-11-10-balanced-completions.md](../superpowers/plans/2026-11-10-balanced-completions.md).

## Shipped

- `filter.ts`: `cutDuplicateCloser` (spec §10 rule 8). In multi-line mode, when the code after the cursor starts with `)`, `]` or `}`, the completion is cut before the first matching closer it did not open itself. A closer alone on its line goes with its line. Strings are skipped.
- `filter.ts`: `fitLine` (spec §10 rule 9) wraps `replacesRest`. It returns `'replace'`, `'insert'` or `undefined`, and `undefined` means the completion would unbalance a balanced cursor line. `provider.ts` uses it for the item range and shows nothing on `undefined`.
- Debug line: `outcome=unbalanced` for completions dropped by rule 9.

## Acceptance (spec §19)

- [x] Unit tests: closers inside strings, blocks the completion closes itself, a needed `)` kept before a suffix `}`, escaped quotes, already-unbalanced lines, empty rest and multi-line text are left alone: 60/60 (3 files).
- [x] Integration test (real VS Code, fake Ollama) still passes, including the Phase 7 replace case.
- [x] Manual: in TypeScript, a function body typed before an auto-closed `}` has no doubled `}`. In `foo(|)`, no ghost text leaves an extra `)` or an open quote. Confirmed by the user (2026-11-10): "looks fine for me"

## Decisions / deviations (recorded in spec §10)

- Phase 8, not part of Phase 7: Phase 7 had already shipped in 0.7.0 when this plan was picked up.
- The plan's opener stack is a depth counter: the scan never checks closer types when it pops, so a counter does the same job.
- Rule 8 runs only in multi-line mode, and rule 9 only when there is code after the cursor. Single-line completions before an empty rest are never dropped, so a block opener like `{` still shows.
- Rule 9 drops instead of repairing. Rewriting the completion would break the "never rewrite code content" rule of §10.
