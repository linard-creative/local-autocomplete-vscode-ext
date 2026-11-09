// Performance budgets for the workspace index (spec §16). Generous on purpose: they catch real regressions, not CI noise.
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../src/retrieve';
import { bigFile, rng, syntheticFiles } from './synthetic';

// Measured +31.1 MB on 2026-11-10 (Node 22); 2× headroom, rounded up.
const HEAP_CEILING_MB = 70;

const files = syntheticFiles(5000, 1);
const ix = new WorkspaceIndex();
let heapMb = 0;

/** The 21+ lines before a seeded random line of a random file, like the code before a cursor. */
function queries(n: number): string[] {
  const r = rng(7);
  return Array.from({ length: n }, () => {
    const lines = files[Math.floor(r() * files.length)].text.split('\n');
    return lines.slice(0, 21 + Math.floor(r() * (lines.length - 21))).join('\n');
  });
}

beforeAll(() => {
  // A real GC before both readings; otherwise collections mid-build make the delta meaningless.
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  gc();
  const before = process.memoryUsage().heapUsed;
  for (const f of files) ix.set(f.path, f.languageId, f.text);
  gc();
  heapMb = (process.memoryUsage().heapUsed - before) / 2 ** 20;
  console.log(`workspace index: 5000 files, heap +${heapMb.toFixed(1)} MB`);
}, 60_000);

describe('workspace index performance', () => {
  it('retrieval p95 ≤ 5 ms over 500 queries on 5000 files', () => {
    const qs = queries(520);
    for (const q of qs.slice(0, 20)) ix.pick(q, q, new Set()); // warm-up
    const times = qs.slice(20).map((q) => {
      const t = performance.now();
      ix.pick(q, q, new Set());
      return performance.now() - t;
    });
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(0.95 * times.length) - 1];
    console.log(`retrieval p50 ${times[times.length >> 1].toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
    expect(p95).toBeLessThanOrEqual(5);
  });

  it('the longest indexing step (one 256 KB file) ≤ 16 ms', () => {
    const big = bigFile(256 * 1024, 2);
    new WorkspaceIndex().set('warm.ts', 'typescript', big.slice(0, 4096)); // JIT warm-up
    // Best of 3: a single run on a busy CI machine can catch a GC pause; a real regression is slow every time.
    const ms = Math.min(
      ...[0, 1, 2].map(() => {
        const t = performance.now();
        new WorkspaceIndex().set('big.ts', 'typescript', big);
        return performance.now() - t;
      }),
    );
    console.log(`256 KB file indexed in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThanOrEqual(16);
  });

  it('index memory stays under the ceiling', () => {
    expect(heapMb).toBeLessThanOrEqual(HEAP_CEILING_MB);
  });

  it('the same query gives identical picks', () => {
    const [q] = queries(1);
    expect(ix.pick(q, q, new Set())).toEqual(ix.pick(q, q, new Set()));
  });
});
