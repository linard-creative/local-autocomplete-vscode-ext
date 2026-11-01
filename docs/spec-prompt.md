# Task: Create a Technical Specification (`spec.md`) for a Local AI Code Autocomplete VS Code Extension

Act as a senior software architect specializing in VS Code extension development, TypeScript, local LLM inference, and developer tooling.

Your task is to analyze the requirements below and create a comprehensive, implementation-ready `spec.md` for a VS Code extension that provides GitHub Copilot-style inline code autocomplete powered entirely by locally installed Ollama models.

The extension is intended for personal use. It should prioritize speed, minimal resource consumption, privacy, maintainability, and a seamless coding experience.

Do not implement the extension yet. First, produce the technical specification in `spec.md`.

## 1. Project Overview

Build a VS Code extension that provides AI-powered code completion directly inside the editor.

The extension should behave similarly to GitHub Copilot's inline autocomplete feature:

- Predict the next lines of code while the user types.
- Display suggestions as inline ghost text.
- Allow the user to accept suggestions using the standard VS Code completion interaction.
- Support multiple programming languages.
- Use Ollama as the local LLM inference provider.
- Allow the user to switch between different Ollama models installed on their machine.
- Never require a cloud AI API, external AI account, or paid subscription.

The extension must work locally without requiring a dedicated backend server.

## 2. Core Technology Stack

Use the following technologies unless the specification identifies a compelling technical reason to choose an alternative:

- Language: TypeScript.
- Platform: Visual Studio Code Extension API.
- Runtime: Node.js runtime provided by VS Code's extension host.
- LLM provider: Ollama.
- HTTP client: Native `fetch()`.
- Build tooling: esbuild.
- Package manager: npm.
- Extension packaging: `@vscode/vsce`.
- Testing: Vitest or another suitable TypeScript testing framework.
- Linting: ESLint with TypeScript support.

Use stable, officially supported VS Code APIs wherever possible.

Avoid unnecessary dependencies and external infrastructure.

## 3. Inline Code Autocomplete

The extension's primary feature is inline code completion.

### Requirements

- Register an inline completion provider using the VS Code Extension API.
- Display generated suggestions as ghost text.
- Support accepting suggestions through standard VS Code interactions.
- Use the current cursor position to determine the completion context.
- Consider code before and after the cursor.
- Support completing expressions, statements, function bodies, imports, and multi-line code.
- Avoid repeating code that already exists.
- Avoid returning explanations, Markdown fences, or unrelated content.
- Return no suggestion when the model cannot produce a useful completion.
- Respect the editor's cancellation token.
- Handle document changes and cursor movements without displaying stale results.
- Avoid interfering with VS Code's built-in IntelliSense, language servers, and other completion providers.

### Context construction

The specification must define how the extension prepares model input.

Consider:

- The current document's text before the cursor.
- The current document's text after the cursor.
- The current programming language.
- The file path and extension.
- Nearby imports, declarations, and type definitions.
- A configurable maximum context size.

The extension must avoid sending the entire workspace to the model for every completion.

Define a context strategy that balances completion quality, privacy, and latency.

### Fill-in-the-Middle support

Investigate support for Fill-in-the-Middle (FIM) completion.

The implementation should:

- Detect whether the selected model supports a suitable FIM format, where feasible.
- Support model-specific prompt templates.
- Use the prefix and suffix around the cursor to generate missing code.
- Provide a generic fallback for models without a known FIM template.
- Avoid assuming every Ollama model supports FIM.

The specification must distinguish model capabilities from extension capabilities.

## 4. Ollama Integration

Ollama is the local inference provider.

The extension must communicate directly with the Ollama HTTP API.

### Configuration

Define configurable settings for:

- Ollama base URL, defaulting to `http://127.0.0.1:11434`.
- Selected model.
- Request timeout.
- Maximum completion tokens.
- Temperature.
- Context size.
- Model keep-alive duration.
- Completion debounce interval.
- Whether inline autocomplete is enabled.

Use VS Code's configuration system so users can modify settings through the Settings UI or `settings.json`.

### Connection handling

The extension must:

- Check whether Ollama is reachable.
- Retrieve available models through Ollama's model-listing API.
- Handle unavailable Ollama instances.
- Handle missing or unloaded models appropriately.
- Provide useful error messages without flooding the user with notifications.
- Distinguish connection errors, timeouts, missing models, and inference failures.
- Avoid unnecessary health checks and repeated requests.
- Support refreshing the installed-model list.

Consult the current official Ollama API documentation when designing request and response types.

Do not invent API endpoints or assume unsupported parameters exist.

## 5. Dynamic Model Switching

This is a core requirement, not an optional enhancement.

The user may have multiple models installed in Ollama, for example:

- Qwen Coder.
- DeepSeek Coder.
- Code-oriented Gemma models.
- Other compatible local models.

The extension must allow switching between installed models without modifying source code or restarting VS Code.

### Model selection requirements

Design a model-selection experience using the VS Code API.

Consider providing:

1. A model selector in the VS Code Command Palette.
2. A quick-pick interface listing installed Ollama models.
3. A status bar item showing the currently selected model.
4. A command to refresh the installed-model list.
5. Automatic persistence of the selected model using VS Code configuration.
6. A graceful response when the selected model has been removed from Ollama.
7. A way to switch models while the editor remains open.

The model selector should display available model identifiers and useful metadata when available.

For example:

`Autocomplete Model: qwen2.5-coder:7b`

### Switching behavior

When the user switches models:

- Update the selected model immediately.
- Use the new model for subsequent completion requests.
- Cancel or disregard outdated requests from the previous model.
- Do not display stale suggestions.
- Avoid forcing the user to reload the extension.
- Do not automatically download models.
- Do not automatically switch to another model without informing the user.

The extension must not assume that changing the selected model requires unloading the previous model manually. Explain how Ollama manages model residency and how keep-alive settings affect resource consumption.

### Model capabilities

Different models may have different capabilities.

Define an extensible approach for handling:

- FIM support.
- Recommended context sizes.
- Model-specific prompt formats.
- Output-length limits.
- Other relevant completion parameters.

Do not hardcode a list of models as the authoritative source of installed models.

Discover installed models dynamically through Ollama, and use explicit capability profiles or configurable overrides when automatic capability detection is not possible.

## 6. Performance and Responsiveness

Autocomplete must be responsive enough for everyday development.

The specification must define measurable performance goals and explain how they will be evaluated.

Consider:

- Debouncing typing events.
- Avoiding duplicate requests.
- Cancelling superseded requests.
- Limiting prompt size.
- Keeping frequently used models warm.
- Preventing concurrent inference requests from overwhelming the local machine.
- Avoiding blocking operations on the extension host.
- Limiting the number of generated tokens.
- Avoiding repeated model discovery during ordinary typing.

Establish reasonable initial latency targets for:

- Time from a completion request to the first usable suggestion.
- Time to a complete suggestion.
- Behavior on slow CPUs and GPUs.

Treat performance numbers as targets to validate through benchmarking, not guaranteed results.

The specification should explain the trade-offs between model size, inference speed, completion quality, and hardware availability.

## 7. Request Cancellation and Race Conditions

Autocomplete requests can become outdated while the model is generating a response.

Define a robust strategy for handling:

- Cursor movement.
- Continued typing.
- Document changes.
- Editor closure.
- Model switching.
- Extension deactivation.
- Network timeouts.
- Ollama inference that continues after the client stops waiting.

Use VS Code cancellation tokens and appropriate HTTP cancellation mechanisms.

Explain the distinction between cancelling the HTTP request and guaranteeing that Ollama stops its underlying inference.

Prevent stale suggestions from being shown after the user has moved to another location or changed the selected model.

## 8. Privacy and Local-First Design

The extension must be local-first.

Requirements:

- Do not use cloud AI APIs.
- Do not transmit source code to external services.
- Do not include analytics, telemetry, tracking, or crash-reporting services.
- Do not introduce accounts, authentication, or subscription features.
- Communicate only with the configured Ollama endpoint for inference and model discovery.
- Default to localhost.
- Warn users when they configure a non-local Ollama endpoint.
- Avoid logging source code or full prompts.
- Document the privacy implications of remote Ollama endpoints.

Treat the workspace contents as sensitive.

The specification should describe how to prevent accidental disclosure of source code through logging, diagnostics, or configuration.

## 9. Completion Quality

Define a completion pipeline that includes:

1. Collecting editor context.
2. Selecting an appropriate prompt template.
3. Calling the configured Ollama model.
4. Parsing the response.
5. Removing unwanted formatting when appropriate.
6. Detecting empty or obviously invalid output.
7. Avoiding duplicate text.
8. Returning the inline suggestion.

Do not require every suggestion to compile or pass linting, because autocomplete is predictive.

Prefer minimal, contextually appropriate completions over large, unrelated code blocks.

Define how the extension should handle models that:

- Return Markdown fences.
- Repeat the existing prefix.
- Repeat the existing suffix.
- Generate explanations instead of code.
- Produce excessive output.
- Return incomplete multi-line suggestions.

Do not use aggressive cleanup rules that might corrupt valid code, such as blindly removing punctuation or indentation.

## 10. Extension Commands

Define the following commands:

- Enable Autocomplete.
- Disable Autocomplete.
- Select Autocomplete Model.
- Refresh Available Models.
- Test Ollama Connection.
- Open Extension Settings.

The commands should be accessible through the VS Code Command Palette.

The extension should expose useful state through a status bar item, including:

- Whether autocomplete is enabled.
- The currently selected model.
- Whether Ollama is unavailable, when useful.

Avoid overly intrusive notifications.

## 11. Extension Settings and Defaults

Define the extension's configuration schema, including setting identifiers, types, defaults, descriptions, and validation rules.

Propose sensible initial defaults.

Include settings for:

- Ollama endpoint.
- Selected model.
- Enable/disable autocomplete.
- Request timeout.
- Debounce interval.
- Maximum output tokens.
- Temperature.
- Context window.
- Keep-alive duration.
- Supported languages or language exclusions.

Do not introduce unnecessary configuration options that complicate the initial release.

The selected model must be configurable and persistent across VS Code sessions.

Explain the precedence between user settings and workspace settings, especially for security-sensitive endpoint configuration.

## 12. Suggested Project Structure

Recommend a maintainable TypeScript architecture.

Consider this structure:

src/
├── extension.ts
├── providers/
│ └── inlineCompletionProvider.ts
├── services/
│ ├── ollamaClient.ts
│ └── modelService.ts
├── prompts/
│ ├── completionPrompt.ts
│ └── templates/
├── commands/
│ ├── selectModel.ts
│ ├── refreshModels.ts
│ └── testConnection.ts
├── configuration/
│ └── settings.ts
├── utils/
│ ├── cancellation.ts
│ ├── completionFilter.ts
│ └── contextBuilder.ts
└── types/
└── ollama.ts

The final specification may improve this structure if a different organization is more appropriate.

Explain the responsibilities of each module and the dependencies between them.

Avoid premature abstractions and unnecessary design patterns.

## 13. Error Handling

Define expected behavior for:

- Ollama not installed.
- Ollama not running.
- Invalid endpoint.
- No installed models.
- Selected model removed.
- Model download or availability issues.
- Request timeout.
- HTTP errors.
- Invalid responses.
- Cancellation.
- Unsupported language.
- Empty completion.

Normal typing must remain uninterrupted when autocomplete fails.

Errors should be logged safely and displayed to the user only when appropriate.

## 14. Testing Strategy

Define a practical testing strategy.

Include:

- Unit tests for context construction.
- Unit tests for prompt generation.
- Unit tests for completion filtering.
- Unit tests for configuration handling.
- Unit tests for model selection.
- Mocked Ollama API tests.
- Request cancellation tests.
- Tests for model switching during inference.
- VS Code extension integration tests.
- Manual testing with several installed Ollama models.

Tests should not require downloading a model or running inference unless explicitly designated as optional integration tests.

Include acceptance criteria for the critical user workflows.

## 15. Build, Development, and Packaging

Define:

- Local development setup.
- Build commands.
- Test commands.
- Extension debugging.
- Packaging into a `.vsix` file.
- Installation into the local VS Code environment.
- Versioning and release practices for personal use.

The extension must not require publication to the VS Code Marketplace.

## 16. Scope and Non-Goals

The initial release must focus on inline code completion.

Explicitly exclude:

- Chat interfaces.
- Agentic code execution.
- Automatic code modifications.
- Cloud model providers.
- Billing or subscription features.
- Account management.
- Hosted backend services.
- Automatic model downloads.
- Workspace-wide indexing or embeddings unless later justified by measured completion-quality improvements.

Avoid adding features that distract from fast, reliable autocomplete.

## 17. Implementation Phases

Divide implementation into incremental milestones.

At minimum:

### Phase 1: Basic autocomplete

- Create the extension.
- Connect to Ollama.
- Generate inline suggestions.
- Accept suggestions in VS Code.

### Phase 2: Model management

- Discover installed models.
- Add the model selector.
- Persist the selected model.
- Add connection testing and model refresh.

### Phase 3: Completion quality

- Improve context construction.
- Add model-specific prompt templates and FIM where supported.
- Add response filtering.
- Reduce unnecessary requests.

### Phase 4: Reliability and performance

- Add cancellation.
- Handle race conditions.
- Add timeouts and error handling.
- Benchmark completion latency.

### Phase 5: Testing and packaging

- Add automated tests.
- Validate multiple models.
- Package the extension as a VSIX.
- Document setup and troubleshooting.

For every phase, define deliverables, dependencies, and acceptance criteria.

## 18. Deliverable: `spec.md`

Produce a complete technical specification with the following sections:

1. Project Overview
2. Goals and Non-Goals
3. Requirements
4. User Stories
5. Architecture
6. Component Responsibilities
7. Ollama API Integration
8. Dynamic Model Selection
9. Inline Completion Workflow
10. Prompt and Context Strategy
11. Performance Requirements
12. Cancellation and Concurrency
13. Configuration Schema
14. Privacy and Security
15. Error Handling
16. Testing Strategy
17. Project Structure
18. Development and Packaging
19. Implementation Roadmap
20. Acceptance Criteria
21. Technical Risks and Trade-offs
22. Open Questions

Include Mermaid diagrams where they improve understanding.

Include configuration tables, API interaction examples, and acceptance criteria where appropriate.

Distinguish confirmed technical capabilities from assumptions that need validation.

Use official VS Code and Ollama documentation as the primary references for API behavior.

If web access is available, verify relevant API details against current documentation. Do not invent API endpoints or unsupported VS Code capabilities.

The specification must be detailed enough that a coding agent can implement the extension in phases without having to invent the fundamental architecture.

Save the final document as `spec.md` in the project root.

Do not implement application code yet. Focus exclusively on producing the specification.
