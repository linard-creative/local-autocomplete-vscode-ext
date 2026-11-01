# Phase 1 — Basic autocomplete (0.1.0)

## Shipped

- Scaffold: esbuild, tsconfig, eslint (fetch restricted to `ollama.ts`), Vitest
- `config.ts`: settings read, clamped, defaulted
- `ollama.ts`: `generate`, `showModel`
- `context.ts`: prefix/suffix cut at line boundaries, unused prefix budget given to the suffix
- `prompt.ts`: native `suffix` when the model supports insert, raw prefix-only fallback
- `filter.ts`: strips code fences, drops empty output
- `provider.ts`: debounce and cancellation-token abort; model taken from settings

## Acceptance (spec §19)

- [x] Unit tests for context and filter pass (`test/pipeline.test.ts`)
- [x] Manual: with `model` set and Ollama running, ghost text appears in a `.ts` file and Tab accepts it (confirmed by user with `qwen2.5-coder:7b`)

## Decisions / deviations

- Minimum VS Code raised from 1.90 to 1.101 (Node 22 extension host): current Vitest needs `@types/node` 22+ (spec §1).
- The original `SPEC.md` request was renamed to `spec-prompt.md`; on Windows it would have been overwritten by `spec.md`.
