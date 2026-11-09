// Deterministic synthetic workspace for the perf test and `npm run bench:context`: same seed, same files.

/** mulberry32: small seeded PRNG in [0, 1). */
export function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = 'ka lo mi ren tor vel sha pin dex qua zor bel nim rup sto gal fen hux jor wib'.split(' ');
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function vocabulary(r: () => number, size: number): string[] {
  const words = new Set<string>();
  while (words.size < size) {
    const n = 2 + Math.floor(r() * 2);
    words.add(Array.from({ length: n }, () => SYLLABLES[Math.floor(r() * SYLLABLES.length)]).join(''));
  }
  return [...words];
}

const FUNCS_PER_FILE = 10;
const fnName = (vocab: string[], file: number, k: number) =>
  vocab[(file * 7 + k * 13) % vocab.length] + cap(vocab[(file * 31 + k * 17 + 5) % vocab.length]) + file;

function fnBlock(r: () => number, vocab: string[], files: number, file: number, k: number, ts: boolean): string {
  const w = () => vocab[Math.floor(r() * vocab.length)];
  // Calls go to functions defined in other files, so cross-file definitions exist.
  const call = () => fnName(vocab, Math.floor(r() * files), Math.floor(r() * FUNCS_PER_FILE));
  const [a, b, v, f1, f2, t] = [w(), w(), w(), w(), w(), cap(w())];
  const name = fnName(vocab, file, k);
  return ts
    ? `export function ${name}(${a}: ${t}, ${b}: number): ${t} {\n  const ${v} = ${call()}(${a}.${f1}, ${b});\n  if (${v}.${f2} > ${b}) {\n    return ${call()}(${v});\n  }\n  for (const ${w()} of ${a}.${w()}) {\n    ${v}.${f1} += ${call()}(${b}, ${a}.${f2});\n  }\n  return { ...${a}, ${f1}: ${v}.${f1} };\n}\n\n`
    : `def ${name}(${a}, ${b}):\n    ${v} = ${call()}(${a}.${f1}, ${b})\n    if ${v}.${f2} > ${b}:\n        return ${call()}(${v})\n    for ${w()} in ${a}.${w()}:\n        ${v}.${f1} += ${call()}(${b}, ${a}.${f2})\n    return ${v}\n\n\n`;
}

/** `count` files of ~100–150 lines, alternating TypeScript and Python, 10 functions each. */
export function syntheticFiles(count: number, seed: number): { path: string; languageId: string; text: string }[] {
  const r = rng(seed);
  const vocab = vocabulary(r, 2000);
  return Array.from({ length: count }, (_, file) => {
    const ts = file % 2 === 0;
    // join, not +=: a concatenated string is a rope until V8 flattens it, which skews heap measurements.
    const text = Array.from({ length: FUNCS_PER_FILE }, (_, k) => fnBlock(r, vocab, count, file, k, ts)).join('');
    return { path: `src/m${file}.${ts ? 'ts' : 'py'}`, languageId: ts ? 'typescript' : 'python', text };
  });
}

/** One TypeScript file of exactly `bytes` chars, for the longest-indexing-step check. */
export function bigFile(bytes: number, seed: number): string {
  const r = rng(seed);
  const vocab = vocabulary(r, 2000);
  const parts: string[] = [];
  for (let n = 0; n < bytes; ) {
    const block = fnBlock(r, vocab, 1000, 0, parts.length, true);
    parts.push(block);
    n += block.length;
  }
  return parts.join('').slice(0, bytes);
}
