# Phase 7 — Auto-closed suffix (0.7.0)

## Shipped

- `filter.ts`: `replacesRest` (spec §10 rule 7). When a single-line completion already contains the rest of the cursor line in order (e.g. the editor's auto-closed `")`), and only replacing it balances the line's brackets and quotes, `provider.ts` sets the item range to the end of the trimmed line. The completion replaces the auto-closed characters instead of doubling them: `console.log("userDetailsData", userDetailsData)")` and `if(!userDetailsData) return null;)` are fixed.
- Fixes from the 2026-11-10 audit:
  - `context.ts`: CRLF becomes LF in the prefix and suffix, and `provider.ts` does the same for recent-tab heads. Suffix-overlap trimming (§10 rule 3) never matched in CRLF files, so closing braces were doubled there.
  - `context.ts`: the import block keeps an import on line 50 of a long file. Before, it dropped the whole block.
  - `ollama.ts`: only a 404 that mentions a model counts as "model not found". A bare `404 page not found` (an endpoint ending in `/api`) is an `http` error.
  - `models.ts`: a missing model is probed again after the 10 s backoff, and the first success clears the state, so `ollama pull` brings completions back with no command. A model or endpoint change ends the backoff (`extension.ts`).
  - `provider.ts`: a recent-tab outline is skipped when the file changed while its symbols were computed, instead of throwing an unhandled error.
  - Removed the dead `samples` entries from `.gitignore` and `eslint.config.mjs`.

## Acceptance (spec §19)

- [x] Unit tests: both screenshot cases and Python `print('|')` replace the rest of the line, while `a(b)` before `)`, `userDetailsData` before `")`, multi-line output and an empty rest stay plain inserts. Also tests for CRLF trimming, the line-50 import, the `404 page not found` mapping, and missing-model recovery: 51/51 (3 files).
- [x] Integration test (real VS Code 1.144, fake Ollama): accepting `x", x)` inside `console.log("|")` gives `console.log("x", x)`. VS Code shows and applies a suggestion that replaces existing characters.
- [x] Manual: the screenshot case in TypeScript and Python shows the right ghost text with a real model, and Tab gives a line with no doubled closers. Confirmed by the user on 0.8.0 (2026-11-10): "looks fine for me"

## Decisions / deviations (recorded in spec §8, §10, §19)

- Replacing is decided by line balance, not by a fixed list of closer characters. The rest of the line must appear in the completion in order, so a replace never deletes typed text. A line that is already unbalanced (e.g. `don't` in a comment) falls back to the plain insert.
- The 3-char minimum of §10 rule 3 stays. Short auto-closed suffixes are handled by the replace range instead of by trimming.
- A missing model no longer blocks requests until a setting changes (spec §8 step 3). It shares the offline backoff.
