# Phase 11 — Member types (0.10.0)

Numbered 11 because Phase 10 (declaration names) was claimed in parallel.

## Shipped

- `provider.ts`: at `obj.|` or `obj.na|`, `vscode.executeTypeDefinitionProvider` finds obj's type. The outline of that symbol (its line plus its members' lines) goes right before the current file. Same file rules as recent tabs. The lookup starts with the request and gets 300 ms; a late answer is cached for the next request. Debug field `type_chars`.
- Tests: three unit tests in `test/provider.test.ts`, one integration check in `test/integration/suite.ts`.

## Acceptance (spec §19)

- [x] Unit tests: outline before the current file, lookup at the receiver; secret, out-of-workspace and no-member-access send nothing; a hung language server doesn't block. 15/15 in `test/provider.test.ts`, 100/100 overall.
- [x] Integration (real VS Code, fake Ollama): `a.|` in `pay.ts` sent `account.ts`'s `Account` outline 197 ms after the check started.
- [ ] Manual: after `obj.`, a completion uses a member that exists only in obj's type, in a file that isn't open.

## Decisions / deviations (recorded in spec §10)

- No setting or toggle: it only adds context when the language server answers, inside the existing budget rules.
- Workspace files only, like recent tabs, so library `.d.ts` files outside the workspace (e.g. TypeScript's own `lib.*.d.ts`) are not sent. `node_modules` inside the workspace is allowed, since that is where invented library members come from.
- shortcut: identifier receivers only (`a.b.`, not `f().` or `a[0].`).
