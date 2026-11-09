# Milestones

One file per finished roadmap phase (spec §19). Add a file when a phase ships and bump the minor version (spec §18). Spec §19 stays the source of truth; this page tracks progress.

| Phase | Status | Version | File |
|---|---|---|---|
| 1. Basic autocomplete | Done | 0.1.0 | [phase-1.md](phase-1.md) |
| 2. Model management | Done (manual checks skipped) | 0.2.0 | [phase-2.md](phase-2.md) |
| 3. Completion quality | Done | 0.3.0 | [phase-3.md](phase-3.md) |
| 4. Reliability and performance | Done | 0.4.0 | [phase-4.md](phase-4.md) |
| 5. Testing and packaging | Done | 0.5.0 | [phase-5.md](phase-5.md) |
| 6. Recent tabs context | Done | 0.6.0 | [phase-6.md](phase-6.md) |
| 7. Auto-closed suffix | Done (manual check pending) | 0.7.0 | [phase-7.md](phase-7.md) |

## Phases

### 1. Basic autocomplete — done

Scaffold; `config.ts`, `ollama.ts` (`generate`, `showModel`), `context.ts`, `prompt.ts` (native suffix + prefix-only), minimal `filter.ts` (fences, empty), `provider.ts` with debounce + token abort; model from settings.

### 2. Model management — done

`models.ts` (quick pick, capability cache, offline/missing state), status bar, all six commands, missing-model handling, non-local endpoint warning, single-flight abort (pulled forward from Phase 4).

### 3. Completion quality — done

Raw FIM template table, single/multi-line mode, full filter rules, import-block context, mid-word skip, `selectedCompletionInfo` skip.

### 4. Reliability and performance — done

Timeout + cold-load allowance, offline backoff, error mapping per §15, debug metrics line, `scripts/bench.ts`, concurrency tests.

### 5. Testing and packaging — done

Mocked-API tests, integration tests with a fake server, README (setup, recommended models, privacy, troubleshooting), CHANGELOG, `.vsix`.

### 6. Recent tabs context — done

`recentTabs` / `recentTabsCount`, most-recently-active tracking, file heads of recent tabs before the current file, built-in secret-file exclusion, prompt-eval metrics, bench variant.

### 7. Auto-closed suffix — done

When the completion already contains the rest of the line (e.g. auto-closed `")` or `)`) and only replacing it balances the line, replace it instead of inserting before it. Fixes `console.log("userDetailsData", userDetailsData)")` and `if(!userDetailsData) return null;)`. Plus the 2026-11-10 audit fixes: CRLF context, line-50 imports, missing-model recovery, the `404 page not found` mapping, and the outline race.

Each phase file contains: what shipped, acceptance status (spec §19), and any decisions or deviations from the spec.
