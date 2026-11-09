# Local Autocomplete (VS Code extension)

Inline ghost-text completions from local Ollama models. `docs/spec.md` is the source of truth for the architecture, settings, and phased roadmap; `docs/spec-prompt.md` is the original request it was written from.

## Commands

- `npm run build` (esbuild → `dist/extension.js`), `npm run watch`
- `npm run typecheck` (esbuild does not type-check)
- `npm run lint`, `npm test` (Vitest, no Ollama needed; `vscode` is aliased to the stub `test/vscode.ts`)
- `npm run bench -- <model>` (optional latency benchmark, needs a running Ollama)
- `npm run package` → `output/local-autocomplete-<version>.vsix`; `npm run install:ext` packages and installs or updates it (`--force`), `npm run uninstall:ext` removes it
- Debug: F5 → "Run Extension"

Run typecheck, lint and test before calling a change done.

## Rules

- Zero runtime dependencies. Dev dependencies only.
- `src/ollama.ts` is the only module that may call `fetch` (eslint-enforced). Never call `/api/pull`, `/api/delete` or any non-Ollama host.
- Never log source code, prompts, completions or absolute paths. Log metadata only.
- `context.ts`, `prompt.ts`, `filter.ts`, `ollama.ts`, `config.ts` must not import `vscode` so they stay unit-testable.
- Implement the roadmap phase by phase (spec §19). Update the spec when a decision changes.
- When a phase is done, add `docs/milestones/phase-N.md` and update its index row. Check an acceptance box only once it is verified; manual items need the user's confirmation.

## Coding style

Before writing or changing any code, invoke the `ponytail` skill (Skill tool) and follow it.

@.claude/skills/ponytail/SKILL.md
