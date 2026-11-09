// Optional latency benchmark (spec §11). Needs a running Ollama; never runs in CI.
// Usage: npm run bench -- <model> [<model> ...]
import { readdirSync, readFileSync } from 'node:fs';
import { readSettings } from '../src/config';
import { buildContext, type CompletionContext } from '../src/context';
import { cleanCompletion } from '../src/filter';
import { generate, showModel } from '../src/ollama';
import { buildRequest, describeProfile, recentBlock, resolveProfile } from '../src/prompt';
import { sliceLines, WorkspaceIndex } from '../src/retrieve';

const sources = readdirSync('src').map((f) => ({ path: `src/${f}`, languageId: 'typescript', text: readFileSync(`src/${f}`, 'utf8') }));

const index = new WorkspaceIndex();
for (const f of sources) index.set(f.path, f.languageId, f.text);

// 20 fixtures from this repo's own source: cursor at the end of lines 30%, 60% and 90% through each file.
// The recent-tabs variant adds the heads of the first three other files, as the extension would with defaults.
// The workspace variant also adds the index's snippets, excluding the current file and those three.
const fixtures: { ctx: CompletionContext; path: string; recent: string; workspace: string }[] = sources
  .flatMap(({ path, text }) => {
    const lines = text.split('\n');
    const others = sources.filter((f) => f.path !== path).slice(0, 3);
    const recent = recentBlock(others, 1500);
    const exclude = new Set([path, ...others.map((f) => f.path)]);
    return [0.3, 0.6, 0.9].map((p) => {
      const offset = lines.slice(0, Math.floor(lines.length * p) + 1).join('\n').length;
      const ctx = buildContext(text, offset, 6000);
      const snippets = index.pick(ctx.prefix, ctx.prefix + ctx.suffix, exclude).map((h) => ({
        ...h,
        text: sliceLines(sources.find((f) => f.path === h.path)!.text, h.start, h.end),
      }));
      return { ctx, path, recent, workspace: recentBlock(snippets, 1500) };
    });
  })
  .slice(0, 20);

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

const models = process.argv.slice(2);
if (!models.length) {
  console.error('Usage: npm run bench -- <model> [<model> ...]');
  process.exit(1);
}

for (const model of models) {
  const s = { ...readSettings({ get: () => undefined }), model };
  const profile = resolveProfile(model, await showModel(s.endpoint, model));
  for (const variant of ['off', 'recent', 'recent+workspace'] as const) {
    const extra = (i: number) => (variant === 'off' ? '' : fixtures[i].recent + (variant === 'recent' ? '' : fixtures[i].workspace));
    const request = (i: number) => buildRequest(fixtures[i].ctx, { path: fixtures[i].path, languageId: 'typescript' }, profile, s, extra(i));

    // Warm-up so the cold load doesn't skew the percentiles.
    const warm = await generate(s.endpoint, request(0));
    const times: number[] = [];
    let tokens = 0;
    let evalNs = 0;
    let promptTokens = 0;
    let promptNs = 0;
    let empty = 0;
    for (let i = 0; i < fixtures.length; i++) {
      const t0 = performance.now();
      const res = await generate(s.endpoint, request(i));
      times.push(performance.now() - t0);
      tokens += res.eval_count ?? 0;
      evalNs += res.eval_duration ?? 0;
      promptTokens += res.prompt_eval_count ?? 0;
      promptNs += res.prompt_eval_duration ?? 0;
      if (!cleanCompletion(res.response, fixtures[i].ctx, res.done_reason === 'length')) empty++;
    }
    times.sort((a, b) => a - b);
    console.log(
      `${model} (${describeProfile(profile)}, context ${variant}): cold load ${Math.round((warm.load_duration ?? 0) / 1e6)} ms, ` +
        `p50 ${Math.round(pct(times, 0.5))} ms, p95 ${Math.round(pct(times, 0.95))} ms, ` +
        `${(tokens / (evalNs / 1e9)).toFixed(1)} tok/s, prompt eval ${Math.round(promptTokens / fixtures.length)} tok / ${Math.round(promptNs / 1e6 / fixtures.length)} ms avg, ` +
        `empty ${empty}/${fixtures.length}`,
    );
  }
}
