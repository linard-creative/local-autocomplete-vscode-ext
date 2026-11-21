# Declaration names (Phase 10) — design

Status: approved by the user 2026-11-21. It is folded into `docs/spec.md` (§9, §10, §19) and planned with `superpowers:writing-plans`.

## Intent

When the user starts a declaration (`const |`, `function |`, `type |`, `interface |`, `def |` and so on), the extension suggests a **name** for it as ghost text, drawing on the current file and the files opened before. Tab accepts it. Today the model sees the same context there, but writes a whole statement, often several lines, instead of a name.

## Goals

1. On a declaration name, the ghost text is just the name (the rest of the identifier being typed, or a whole name after `const `). Nothing after it.
2. The name fits the project: same context as every other completion (current file, recent-tab outlines, workspace snippets). No new context source.
3. As fast as today or faster: a name needs only a few tokens.

## Non-goals

- A dropdown list of several names (approach B, below).
- Names picked from existing files without the model (a new declaration mostly needs a new name).
- Renaming or suggesting names for existing declarations, parameters, or destructuring patterns.
- A new setting or command. It follows `enabled` like everything else.

## Anti-goals

- A name that duplicates one already declared in the same scope, shown as if fine. (Accepted risk, the model decides; not filtered.)
- Ghost text that appears where it did not before and gets in the way of normal completions, e.g. on `let x = u|` (an expression, not a declaration).
- Any extra latency or a second request in flight (N1).

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | Ghost-text name: detect a declaration-name position, cap the output to a few tokens, cut it at the end of the identifier. | Small, reuses the whole pipeline, same or lower latency. One suggestion at a time. |
| B | 3–5 names in the IntelliSense list via a `CompletionItemProvider`. | Alternatives side by side, but FIM models don't take "give me five names" instructions, so it needs several generations in a row (3–5× latency) and breaks single-flight (N1). |
| C | Names from current/recent files without the model. | Fast, but a new declaration needs a new name, so existing names are mostly duplicates. Dropped. |

The user picked A on 2026-11-21.

## Design

- **Detection (`context.ts`, no `vscode`):** `declName(before)` matches the line text before the cursor against a keyword followed by whitespace and an optional partial identifier at the end: `const let var val function class interface type enum struct trait def fn func`, optionally after `export`, `async`, `pub`, `mut`. Returns the partial name (possibly empty) or `undefined`. Nothing after the cursor may be a word character (the existing mid-word skip already ensures this). My call: the keyword list mirrors the definition regex in `retrieve.ts`.
- **Request (`prompt.ts`):** in name mode, `num_predict` is capped at 16 tokens (my call; long enough for `computeInvoiceTotalWithTax`) and `\n` is added to the stops, as in single-line mode.
- **Cut (`filter.ts`):** after `cleanCompletion`, keep only the leading identifier characters (`[\w$]*`). After `const ` with an empty partial, leading spaces are dropped first. An empty result shows nothing. The item is a plain insert at the cursor.
- **Provider:** computes name mode once, passes it through, adds `mode=name|code` to the debug line. Context, recent tabs and workspace retrieval are unchanged. Retrieval already drops the partial identifier from its query, so typing the name doesn't change the snippets.
- **"Previous files"** keeps today's meaning (my call): open recent tabs (outlines) plus closed workspace files through the index. Closed-but-recent files are not added as a new source.

## Open risk, checked first

TypeScript offers no completions at a declaration name (checked with its language service: `const u`, `function g`, `interface U`, `type U` return none). But VS Code's word-based list may still pop up with a selection. The provider skips while `selectedCompletionInfo` is set, which would hide the name. The first plan step checks this in real VS Code. If it hides the name, the fix is to follow VS Code's contract in name mode: request anyway and show the name only when it starts with the selected word, over the selection's range.

## Acceptance (for spec §19)

- Unit tests: `declName` on each keyword, with `export`/`async`, empty and partial names, and non-matches (`let x = u`, `return u`, `constant`). The cut: `serName = 1;` → `serName`, a leading space after `const `, an empty result.
- Unit test: name mode sets `num_predict` ≤ 16 and a `\n` stop.
- Manual (TypeScript and Python): `const |` and `function get|` show a name only. Tab gives a name that fits nearby code. `let x = |` behaves as before.

## Left to the builder

The exact regex, where the 16-token cap lives (constant in `prompt.ts`), test file layout, and the milestone file `docs/milestones/phase-10.md` with the 0.10.0 bump.
