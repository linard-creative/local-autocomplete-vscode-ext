// Optional latency benchmark (spec §11). Needs a running Ollama; never runs in CI.
// Usage: npm run bench -- <model> [<model> ...]
import { readdirSync, readFileSync } from 'node:fs';
import { readSettings } from '../src/config';
import { buildContext, type CompletionContext } from '../src/context';
import { cleanCompletion } from '../src/filter';
import { generate, showModel } from '../src/ollama';
import { buildRequest, describeProfile, resolveProfile } from '../src/prompt';

// 20 fixtures from this repo's own source: cursor at the end of lines 30%, 60% and 90% through each file.
const fixtures: { ctx: CompletionContext; path: string }[] = readdirSync('src')
  .flatMap((f) => {
    const text = readFileSync(`src/${f}`, 'utf8');
    const lines = text.split('\n');
    return [0.3, 0.6, 0.9].map((p) => {
      const offset = lines.slice(0, Math.floor(lines.length * p) + 1).join('\n').length;
      return { ctx: buildContext(text, offset, 6000), path: `src/${f}` };
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
  const request = (i: number) =>
    buildRequest(fixtures[i].ctx, { path: fixtures[i].path, languageId: 'typescript' }, profile, s);

  // Warm-up so the cold load doesn't skew the percentiles.
  const warm = await generate(s.endpoint, request(0));
  const times: number[] = [];
  let tokens = 0;
  let evalNs = 0;
  let empty = 0;
  for (let i = 0; i < fixtures.length; i++) {
    const t0 = performance.now();
    const res = await generate(s.endpoint, request(i));
    times.push(performance.now() - t0);
    tokens += res.eval_count ?? 0;
    evalNs += res.eval_duration ?? 0;
    if (!cleanCompletion(res.response, fixtures[i].ctx, res.done_reason === 'length')) empty++;
  }
  times.sort((a, b) => a - b);
  console.log(
    `${model} (${describeProfile(profile)}): cold load ${Math.round((warm.load_duration ?? 0) / 1e6)} ms, ` +
      `p50 ${Math.round(pct(times, 0.5))} ms, p95 ${Math.round(pct(times, 0.95))} ms, ` +
      `${(tokens / (evalNs / 1e9)).toFixed(1)} tok/s, empty ${empty}/${fixtures.length}`,
  );
}
