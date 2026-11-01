import type { Settings } from "./config";
import { isSingleLine, type CompletionContext } from "./context";
import type { GenerateRequest, ShowResponse } from "./ollama";

/** Raw FIM prompt: `prefix + <code before> + suffix + <code after> + middle`. */
export interface FimTemplate {
	prefix: string;
	suffix: string;
	middle: string;
	stop: string[];
}

export interface ModelProfile {
	/** Model template supports Ollama's native `suffix` (FIM). */
	insert: boolean;
	/** Built-in FIM tokens for models without `insert`; neither means prefix-only. */
	template?: FimTemplate;
}

export interface FileInfo {
	path: string;
	languageId: string;
}

// Token formats from each model's tokenizer/model card (spec §8, [Source]): validate per model before trusting.
const TEMPLATES: [string[], FimTemplate][] = [
	[
		["qwen2.5-coder", "qwen3-coder", "codegemma"],
		{
			prefix: "<|fim_prefix|>",
			suffix: "<|fim_suffix|>",
			middle: "<|fim_middle|>",
			stop: [
				"<|endoftext|>",
				"<|file_sep|>",
				"<|fim_prefix|>",
				"<|fim_suffix|>",
				"<|fim_middle|>",
			],
		},
	],
	[
		["deepseek-coder"],
		{
			prefix: "<｜fim▁begin｜>",
			suffix: "<｜fim▁hole｜>",
			middle: "<｜fim▁end｜>",
			stop: [
				"<｜end▁of▁sentence｜>",
				"<｜fim▁begin｜>",
				"<｜fim▁hole｜>",
				"<｜fim▁end｜>",
			],
		},
	],
	[
		["starcoder"],
		{
			prefix: "<fim_prefix>",
			suffix: "<fim_suffix>",
			middle: "<fim_middle>",
			stop: ["<|endoftext|>", "<fim_prefix>", "<fim_suffix>", "<fim_middle>"],
		},
	],
	[
		["codellama"],
		{
			prefix: "<PRE> ",
			suffix: " <SUF>",
			middle: " <MID>",
			stop: ["<EOT>", "<PRE>", "<SUF>", "<MID>"],
		},
	],
];

/** Matches a model name or family (from /api/show) against the built-in FIM templates. */
export function findTemplate(
	...names: (string | undefined)[]
): FimTemplate | undefined {
	const hay = names.filter(Boolean).join(" ").toLowerCase();
	return TEMPLATES.find(([keys]) => keys.some((k) => hay.includes(k)))?.[1];
}

/** Native `insert` → built-in template → prefix-only (spec §8). */
export function resolveProfile(
	model: string,
	show: ShowResponse,
): ModelProfile {
	const insert = show.capabilities?.includes("insert") ?? false;
	return {
		insert,
		template: insert ? undefined : findTemplate(model, show.details?.family),
	};
}

export const describeProfile = (p: ModelProfile): string =>
	p.insert
		? "native FIM"
		: p.template
			? "built-in FIM template"
			: "prefix-only";

const HASH_COMMENT = new Set([
	"python",
	"shellscript",
	"ruby",
	"perl",
	"r",
	"yaml",
	"toml",
	"dockerfile",
	"makefile",
	"powershell",
	"elixir",
	"julia",
]);
const DASH_COMMENT = new Set(["sql", "lua", "haskell"]);
// Languages without a line comment; a fake header would be invalid syntax for the model to imitate.
const NO_HEADER = new Set([
	"html",
	"xml",
	"css",
	"json",
	"jsonc",
	"vue",
	"svelte",
]);

export function fileHeader({ path, languageId }: FileInfo): string {
	if (NO_HEADER.has(languageId)) return "";
	const c = HASH_COMMENT.has(languageId)
		? "#"
		: DASH_COMMENT.has(languageId)
			? "--"
			: "//";
	return `${c} File: ${path} (${languageId})\n`;
}

export interface RecentFile extends FileInfo {
	text: string;
}

/**
 * Head of each recent file, `budget` split evenly, each under its own file header.
 * Heads don't change while you type elsewhere, so Ollama's prompt cache reuses this block.
 */
export function recentBlock(files: RecentFile[], budget: number): string {
	const usable = files.filter((f) => fileHeader(f));
	const each = Math.floor(budget / Math.max(1, usable.length));
	return usable
		.map((f) => {
			const head =
				f.text.length <= each
					? f.text
					: f.text.slice(0, f.text.lastIndexOf("\n", each) + 1);
			return head.trim() ? `${fileHeader(f)}${head.trimEnd()}\n\n` : "";
		})
		.join("");
}

export function buildRequest(
	ctx: CompletionContext,
	file: FileInfo,
	profile: ModelProfile,
	s: Settings,
	recent = "",
): GenerateRequest {
	// Recent files first: a stable start of the prompt is what Ollama's prompt cache can reuse.
	const prompt = recent + fileHeader(file) + ctx.prefix;
	const lineStop = isSingleLine(ctx) ? ["\n"] : [];
	const options = {
		num_predict: s.maxTokens,
		temperature: s.temperature,
		num_ctx: s.numCtx,
		top_p: 0.9,
	};
	const base = {
		model: s.model,
		stream: false as const,
		keep_alive: s.keepAlive,
	};

	if (profile.insert) {
		return {
			...base,
			prompt,
			suffix: ctx.suffix,
			options: lineStop.length ? { ...options, stop: lineStop } : options,
		};
	}
	const t = profile.template;
	if (t) {
		const raw = t.prefix + prompt + t.suffix + ctx.suffix + t.middle;
		return {
			...base,
			prompt: raw,
			raw: true,
			options: { ...options, stop: [...t.stop, ...lineStop] },
		};
	}
	// Prefix-only continuation; raw so instruct models aren't wrapped in a chat template.
	return {
		...base,
		prompt,
		raw: true,
		options: { ...options, stop: ["\n\n\n", ...lineStop] },
	};
}
