# Phase 4 — Reliability and performance (0.4.0)

## Shipped

- Cold-load timeout: a model with no successful request in the last 5 minutes gets `max(requestTimeoutMs, 30s)` (`ModelService.isCold`)
- Offline backoff: after a connection error, completions pause for 10 s; any success, Refresh, Test Connection or endpoint change clears it
- Error mapping per spec §15: timeouts logged at debug, invalid responses at warn, connection/HTTP errors once per state transition
- Debug metrics line per request: `model, prompt_chars, total_ms, load_ms, eval_count, tok_s, done, outcome` (`shown`/`empty`/`stale`), no code or prompt text
- `resolveProfile` / `describeProfile` moved into `prompt.ts`, shared by `models.ts` and the benchmark
- `scripts/bench.ts` (`npm run bench -- <model> …`): 20 prompts from the repo's own `src/`, prints p50/p95, tok/s and the empty count
- `test/provider.test.ts`: 5 concurrency tests on the real provider and `ModelService`, with `vscode` aliased to a small stub (`test/vscode.ts`, `vitest.config.ts`)

## Acceptance (spec §19)

- [x] Concurrency tests pass (debounce collapse, single-flight abort, stale after model switch, offline backoff, cold tracking): 30/30 tests
- [x] HTTP abort stops inference: an aborted 1500-token request ended server-side at 1.51 s instead of 23.6 s; the runner logged `stop: cancel task` (Ollama 0.40.13)
- [x] Bench p50 recorded for 2+ models (user run, 2026-11-01): `qwen2.5-coder:7b` p50 418 ms, p95 2126 ms, 73.8 tok/s, 2/20 empty; `qwen2.5-coder:1.5b` p50 115 ms, p95 682 ms, 209.2 tok/s, 8/20 empty. An earlier 7b-only run gave p50 772 ms and p95 3809 ms, so runs vary.
- [x] Manual: with Ollama stopped, typing in a 2k-line file (`samples/large-file.ts`) shows no lag (confirmed by user: "smooth"); the "no notifications" part was not reported separately

## Decisions / deviations (recorded in spec §11, §12, §15, §16)

- Cold detection is "no success in the last 5 minutes" instead of "model changed in the last 60 s"; it also covers VS Code startup and keep-alive expiry. A long timeout is harmless while typing because each keystroke cancels the previous request.
- No "retry without suffix on 400": unreachable, because `suffix` is only sent when the model reports `insert`.
- The status bar shows no separate "No models" state; Select Model reports it.
- Tests use a small `vscode` stub with the real classes, instead of refactoring the provider into plain functions (spec §16 updated).
- 7b meets the p50 target (418 ≤ 700 ms) but misses p95 (2126 > 1500 ms); the fixtures defeat Ollama's prompt cache, so this is pessimistic. 1.5b meets both targets but returns empty output 4× as often (8/20 vs 2/20). Tuning waits for real-use data from the debug log.
- `.vscode/launch.json` passes `--disable-extensions`: with the user's other extensions loaded, the F5 window's extension host crashed (exit 134) about 1 s after start, before ours activated. Prisma and Prisma Insider are both installed and conflict; they are the likely cause, but this is unconfirmed.
- `samples/large-file.ts` (2,024 lines, excluded from lint and the VSIX) is the fixture for the offline/lag check.
- Ollama's server log (`%LOCALAPPDATA%\Ollama\server.log`) records per-request duration for `/api/generate`; that is how abort-stops-inference was verified.
