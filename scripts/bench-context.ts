// Workspace-context benchmark (spec §16): index speed and memory, retrieval latency, and retrieval quality on this repo.
// Needs no Ollama; never runs in CI. Usage: npm run bench:context
import { readdirSync, readFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { buildContext } from '../src/context';
import { MIN_SIM, sliceLines, tokens, WorkspaceIndex } from '../src/retrieve';
import { rng, syntheticFiles } from '../test/synthetic';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

// 1. Synthetic 5000-file workspace: build time, memory, retrieval latency.
const files = syntheticFiles(5000, 1);
const ix = new WorkspaceIndex();
gc();
const heap0 = process.memoryUsage().heapUsed;
const t0 = performance.now();
for (const f of files) ix.set(f.path, f.languageId, f.text);
const buildMs = performance.now() - t0;
gc();
const heapMb = (process.memoryUsage().heapUsed - heap0) / 2 ** 20;
const r = rng(7);
const times: number[] = [];
for (let i = 0; i < 1000; i++) {
  const lines = files[Math.floor(r() * files.length)].text.split('\n');
  const q = lines.slice(0, 21 + Math.floor(r() * (lines.length - 21))).join('\n');
  const t = performance.now();
  ix.pick(q, q, new Set());
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.log(
  `synthetic 5000 files: build ${Math.round(buildMs)} ms (${Math.round(5000 / (buildMs / 1000))} files/s), heap ${heapMb.toFixed(1)} MB, ` +
    `retrieval p50 ${pct(times, 0.5).toFixed(2)} ms, p95 ${pct(times, 0.95).toFixed(2)} ms`,
);

// 2. Quality on this repo: every src/ file at 30/60/90%, with all other src/ and test/ files indexed.
const repo = ['src', 'test']
  .flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => `${dir}/${f}`))
  .map((path) => ({ path, text: readFileSync(path, 'utf8').replace(/\r\n/g, '\n') }));
const repoIx = new WorkspaceIndex();
for (const f of repo) repoIx.set(f.path, 'typescript', f.text);

let hit = 0;
let noise = 0;
let silent = 0;
let defs = 0;
let sims = 0;
for (const { path, text } of repo.filter((f) => f.path.startsWith('src/'))) {
  const lines = text.split('\n');
  for (const p of [0.3, 0.6, 0.9]) {
    const cut = Math.floor(lines.length * p) + 1;
    const offset = lines.slice(0, cut).join('\n').length;
    const ctx = buildContext(text, offset, 6000);
    const hits = repoIx.pick(ctx.prefix, ctx.prefix + ctx.suffix, new Set([path]));
    if (!hits.length) {
      silent++;
      continue;
    }
    // Hit: a snippet has a name the real next 10 lines use and the prefix doesn't show.
    const seen = tokens(ctx.prefix);
    const needed = [...tokens(lines.slice(cut, cut + 10).join('\n'))].filter((t) => !seen.has(t));
    const got = hits.some((h) => {
      const snippet = tokens(sliceLines(repo.find((f) => f.path === h.path)!.text, h.start, h.end));
      return needed.some((t) => snippet.has(t));
    });
    if (got) hit++;
    else noise++;
    defs += hits.filter((h) => h.kind === 'def').length;
    sims += hits.filter((h) => h.kind === 'sim').length;
  }
}
console.log(`quality (MIN_SIM ${MIN_SIM}): hit ${hit}, noise ${noise}, silent ${silent} | snippets def ${defs}, sim ${sims}`);
