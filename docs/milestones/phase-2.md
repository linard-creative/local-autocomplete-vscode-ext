# Phase 2 — Model management (0.2.0)

## Shipped

- `models.ts` (`ModelService`): quick pick from a fresh `/api/tags` (size, params, quantization; `<name>` matches `<name>:latest`), per-model capability profile cache cleared by Refresh and endpoint change
- Status bar: model, `Select model`, `not found`, `Ollama offline`, `Ollama error`, `Autocomplete off`, `Invalid endpoint`; click opens the picker
- Commands: enable, disable, selectModel, refreshModels, testConnection, openSettings
- Single-flight abort in `provider.ts`: a newer request aborts the previous one
- Model switch: writes the `machine`-scoped setting to user settings, aborts the in-flight request, hides ghost text, and the provider drops a late response from the old model
- Missing model (absent from `/api/tags` or 404 from generate): one warning per model per session with "Select Model", requests pause until the setting changes
- Non-local endpoint: one warning per endpoint per session ("Keep" / "Reset to localhost"); invalid endpoint: error with "Open Settings" (`endpointProblem` in `config.ts`, used by `extension.ts`)

## Acceptance (spec §19)

- [ ] Manual: switching models from the status bar takes effect on the next suggestion without a reload — skipped by user 2026-11-01, untested
- [ ] Manual: the setting persists across restart — skipped by user 2026-11-01, untested
- [ ] Manual: a removed model shows one notification — skipped by user 2026-11-01, untested

## Decisions / deviations (recorded in spec §8 and §19)

- Single-flight abort done here instead of Phase 4: abort-on-switch needs it.
- No tags cache: the picker fetches `/api/tags` on each open (user action only).
- No generation counter: the provider compares the model it started with against the current setting.
- No "loaded" marker from `/api/ps` in the picker.
