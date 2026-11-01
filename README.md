# Local Autocomplete

Inline ghost-text code completions from models running in your own [Ollama](https://ollama.com). Your code goes to Ollama only, and there is no telemetry. The extension has zero runtime dependencies.

## Requirements

- VS Code 1.101 or newer
- [Ollama](https://ollama.com) running locally (or on a machine you trust)
- Node.js (current LTS) and npm, to build the extension from source

## Setup

1. Install Ollama and make sure it is running (`ollama serve`, or the desktop app).
2. Pull a code model, for example `ollama pull qwen2.5-coder:1.5b`.
3. Build and install the extension:

   ```sh
   git clone https://github.com/linard-creative/local-autocomplete-vscode-ext.git
   cd local-autocomplete-vscode-ext
   npm install
   npm run install:ext
   ```

   `npm run install:ext` packages `output/local-autocomplete-<version>.vsix` and installs it with the `code` CLI. If `code` isn't on your PATH, run `npm run package`, then in the Extensions view: `...` → **Install from VSIX...**
4. Reload the window, click **Select model** in the status bar and pick the model.
5. Type in a code file. Pause briefly, and a suggestion appears in grey. **Tab** accepts it, **Esc** dismisses it.

The extension never downloads or deletes models. Use the `ollama` CLI for that.

## Recommended models

| Hardware | Model | Notes |
|---|---|---|
| CPU only, or a small GPU | `qwen2.5-coder:1.5b` | Fast (p50 ≈ 115 ms on a GPU), weaker at multi-line, more empty suggestions |
| GPU with 8 GB+ VRAM | `qwen2.5-coder:7b` | Good default (p50 ≈ 420 ms on the same GPU) |
| Alternatives | `deepseek-coder:6.7b`, `codegemma:2b`, `starcoder2:3b` | Supported via built-in FIM templates |

Use base or `-coder` models. Chat or instruct models (e.g. `llama3`) still work through a prefix-only fallback, but they tend to answer in prose instead of continuing the code. Models over 14B are usually too slow for typing-speed completions.

Measure on your own machine with `npm run bench -- <model>` (from a source checkout).

## Commands

All are under **Local Autocomplete** in the Command Palette:

- **Select Autocomplete Model**: opens the model list (also opened by clicking the status bar)
- **Enable / Disable Autocomplete**
- **Refresh Available Models**: re-reads the model list and capabilities
- **Test Ollama Connection**: shows the Ollama version, or why it can't connect
- **Toggle Recent Tabs Context**: turns recent-tab context on or off. The status bar tooltip shows the current state.
- **Open Extension Settings**

## Settings

| Setting | Default | |
|---|---|---|
| `localAutocomplete.enabled` | `true` | Master switch |
| `localAutocomplete.endpoint` | `http://127.0.0.1:11434` | Ollama URL. User settings only (see Privacy). |
| `localAutocomplete.model` | `""` | Set by Select Model. User settings only. |
| `localAutocomplete.debounceMs` | `250` | Pause after typing before a request |
| `localAutocomplete.requestTimeoutMs` | `5000` | Abort after this long. The first request to a model that hasn't answered in 5 minutes gets 30 s for loading. |
| `localAutocomplete.maxTokens` | `128` | Max tokens generated |
| `localAutocomplete.temperature` | `0.2` | |
| `localAutocomplete.maxContextChars` | `6000` | Code around the cursor sent to the model |
| `localAutocomplete.numCtx` | `4096` | Model context window |
| `localAutocomplete.keepAlive` | `30m` | How long Ollama keeps the model loaded after the last request |
| `localAutocomplete.disabledLanguages` | `plaintext`, `markdown`, `scminput` | Language ids with no completions |
| `localAutocomplete.recentTabs` | `true` | Also send an outline (declarations, no function bodies) of your most recently used open files, so suggestions know names from other files |
| `localAutocomplete.recentTabsCount` | `3` | How many recent tabs to include (1–10) |

## Privacy

- The only network peer is the configured endpoint. What is sent: the code around the cursor and its workspace-relative path, never the absolute path. With **Recent Tabs** on, also an outline of your 3 most recently used tabs that are still open inside the workspace: their declaration lines, or the top of the file until the outline is ready.
- `endpoint` and `model` are machine-scoped. A cloned repository's `.vscode/settings.json` cannot redirect your code to another server.
- A non-local endpoint (anything other than `localhost`, `127.x` or `::1`) shows a warning once per session.
- The **Local Autocomplete** output channel logs metadata only (model, timings, sizes), never code, prompts or completions.
- **Secret files:** `.env` and `.env.*`, `.envrc`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, SSH private keys, `credentials` files, `secrets.json`/`.yaml`, `local.settings.json`, and `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.tfvars`, `*.tfstate` never get completions and are never sent as recent-tab context, even to a local Ollama. To exclude other files, add their language id to `disabledLanguages`. Check a file's id via **Change Language Mode** in the status bar.

## Troubleshooting

| Status bar | Meaning | Fix |
|---|---|---|
| `Select model` | No model set | Click it and pick a model. If the list is empty, `ollama pull` one. |
| `Ollama offline` | Can't connect to the endpoint | Start Ollama. The extension retries on its own (at most every 10 s) and recovers without a reload. |
| `<model> not found` | The model was removed | Select another model, or `ollama pull` it again |
| `Ollama error` | Ollama returned an HTTP error | Check Ollama's log (`%LOCALAPPDATA%\Ollama\server.log` on Windows, `~/.ollama/logs/server.log` on macOS) |
| `Invalid endpoint` | `endpoint` isn't an `http(s)://` URL | Fix it in user settings |

No suggestions while the status bar looks fine:

- Suggestions are skipped while the IntelliSense list has a selection and when the cursor is inside a word.
- The language may be listed in `disabledLanguages`.
- The first request after loading a model can take several seconds.
- For details, run **Developer: Set Log Level… → Local Autocomplete → Debug**. The output channel then logs one line per request with `total_ms`, `load_ms` and `outcome` (`shown`, `empty`, `stale`).

## Development

[docs/spec.md](docs/spec.md) describes the architecture, settings and roadmap. [docs/milestones/](docs/milestones/) tracks what each version shipped, and [CHANGELOG.md](CHANGELOG.md) lists the changes.

| Command | |
|---|---|
| `npm run build` / `npm run watch` | Bundle with esbuild into `dist/extension.js` |
| `npm run typecheck` | `tsc` (esbuild does not type-check) |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (Vitest), no Ollama needed |
| `npm run test:integration` | Downloads VS Code into `.vscode-test/` once, then runs against a fake Ollama |
| `npm run package` | Writes `output/local-autocomplete-<version>.vsix` |
| `npm run install:ext` / `npm run uninstall:ext` | Install/update or remove the packaged extension |
| `npm run bench -- <model>` | Latency benchmark against your Ollama |

Press F5 in VS Code to start an Extension Development Host. Run typecheck, lint and tests before opening a pull request.

## License

[MIT](LICENSE)
