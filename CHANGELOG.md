# Changelog

## 0.7.0

- Suggestions no longer leave auto-closed characters behind: typing `console.log("` or `if(` and accepting gives `console.log("a", a)` and `if(!a) return null;` instead of an extra `")` or `)` at the end of the line
- Files with Windows line endings (CRLF) no longer get doubled closing braces, and the model now sees LF line endings
- A model that was missing comes back by itself within 10 s of `ollama pull`. An endpoint with a wrong path (e.g. ending in `/api`) now shows an Ollama error instead of "model not installed".
- Imports on line 50 of a long file are kept in the context, and a rare unhandled error in recent-tab outlines is gone

## 0.6.0

- Recent tabs context: an outline (declaration lines from VS Code's symbol provider) of your 3 most recently used open tabs is sent along with the current file (`recentTabs`, `recentTabsCount`, **Toggle Recent Tabs Context** command). The list survives a restart, and closed tabs are never sent.
- Secret files (`.env*`, keys, credentials, `*.tfvars`, …) never get completions and are never sent as context
- Debug metrics line adds `recent_chars`, `prompt_eval` and `prompt_ms`; `npm run bench` runs each model with and without recent tabs

## 0.5.0

- README (setup, recommended models, privacy, troubleshooting) and this changelog
- Mocked-API tests for the Ollama client, and integration tests in a real VS Code against a fake Ollama (`npm run test:integration`)

## 0.4.0

- Longer timeout for cold models, 10 s offline backoff, error handling per state transition
- Debug metrics line per request (timings and sizes only), `npm run bench`

## 0.3.0

- Built-in FIM templates (Qwen, CodeGemma, DeepSeek, StarCoder, CodeLlama) for models without native insert
- Single- and multi-line modes, output cleanup (fences, repeats, suffix overlap, prose, truncation), import-block context

## 0.2.0

- Model picker and status bar, six commands, missing-model and non-local-endpoint warnings, abort on model switch

## 0.1.0

- First version: ghost-text completions from an Ollama model set in settings
