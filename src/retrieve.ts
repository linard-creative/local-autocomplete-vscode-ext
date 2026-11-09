// Workspace index (spec §10, Phase 9): token postings and definition lines per workspace-relative path. Holds no file text.

export const CHUNK_LINES = 20;
export const QUERY_LINES = 21;
export const MAX_HITS = 2;
/** A name defined in more files than this is ambiguous (`render`, `init`) and never looked up. */
export const MAX_DEF_FILES = 3;
export const MIN_SIM = 0.2;
/** Similarity needs at least this many shared tokens, so a one-word query can't match on that word alone. */
export const MIN_SHARED = 3;
/** Tokens in more chunks than this are skipped when counting overlap: they cost time and say little. */
export const FREQUENT = 2000;

// Keywords and builtins of the common languages; they match everywhere and would only add noise.
const COMMON = new Set(
  `abstract and any as assert async await bool boolean break byte case catch char class const constructor continue
  def default defer del delete do double elif else enum except export extends extern false final finally float fn for
  from func function get global goto if impl implements import in instanceof int interface is lambda len let long loop
  match mod module mut namespace new nil none not null number object of or override package pass print private
  protected pub public raise readonly ref return self Self set short static str string struct super switch this
  throw throws trait true try type typeof uint undefined unsafe use using val var void where while with yield
  None True False console require exports`.split(/\s+/),
);

const IDENT = /[A-Za-z_$][\w$]*/g;

// Run over the whole text (one scan each, much faster than per line), so none may cross a line break.
const DEF = [
  /\b(?:function\*?|class|interface|type|enum|struct|trait|def|fn|func|module|namespace)[ \t]+(?:\([^)\n]*\)[ \t]*)?([A-Za-z_$][\w$]*)/g,
  // Top-level only: indented consts are locals, the main source of noise in measurement.
  /^(?:export[ \t]+)?(?:const|let|var|val)[ \t]+([A-Za-z_$][\w$]*)[ \t]*[=:]/gm,
  /^[ \t]*(?:export[ \t]+)?(?:(?:public|private|protected|static|async|readonly|override)[ \t]+)*([A-Za-z_$][\w$]*)[ \t]*\([^)\n]*\)[ \t]*(?::[^{\n]*)?\{/gm,
  /^([A-Za-z_]\w*)[ \t]*=[^=]/gm,
];

const LOCAL = /\b(?:const|let|var|val)[ \t]+([A-Za-z_$][\w$]*)/g;

/**
 * PascalCase, camelCase or snake_case. Plain words (`text`, `url`, `parse`) are mostly locals and parameters,
 * the main source of noise in `bench:context`, so only these are looked up as definitions.
 */
const SPECIFIC = /^[A-Z]|[a-z\d][A-Z]|[a-z\d]_[a-zA-Z]/;

/** A fresh copy: a substring from a regex match keeps its whole source text alive in V8. */
const own = (s: string) => (' ' + s).slice(1);

/** Identifiers of 3+ chars that aren't keywords or builtins. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const [t] of text.matchAll(IDENT)) if (t.length >= 3 && !COMMON.has(t)) out.add(t);
  return out;
}

/** Defined name → 0-based line of its first definition. A heuristic shared by all languages. */
export function definitions(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const re of DEF) {
    // Matches come in text order, so the line count only moves forward.
    let line = 0;
    let nl = text.indexOf('\n');
    for (const m of text.matchAll(re)) {
      while (nl !== -1 && nl < m.index) {
        line++;
        nl = text.indexOf('\n', nl + 1);
      }
      const name = m[1];
      const seen = out.get(name);
      if (!COMMON.has(name) && (seen === undefined || line < seen)) out.set(name, line);
    }
  }
  return out;
}

/** Lines `start`..`end` (exclusive) of the text, LF only, as `set` numbered them. */
export const sliceLines = (text: string, start: number, end: number): string =>
  text.replace(/\r\n/g, '\n').split('\n').slice(start, end).join('\n');

export interface Hit {
  path: string;
  languageId: string;
  /** Lines, `end` exclusive. */
  start: number;
  end: number;
  kind: 'def' | 'sim';
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class WorkspaceIndex {
  private files = new Map<string, { id: number; languageId: string; chunks: number }>();
  /** Path per file id. Every `set` gets a new id, so entries of an older id are stale. */
  private paths: string[] = [];
  // shortcut: these three keep one number per stale chunk (24 bytes); fine for a session, rebuild if that ever shows up.
  private chunkFile: number[] = [];
  private chunkStart: number[] = [];
  private chunkSize: number[] = [];
  /** Stale entries are skipped until they outnumber live ones, then compact() drops them. */
  private postings = new Map<string, number[]>();
  private defs = new Map<string, { id: number; line: number }[]>();
  private liveChunks = 0;
  private staleChunks = 0;

  get size(): number {
    return this.files.size;
  }

  private live(id: number): boolean {
    return this.files.get(this.paths[id])?.id === id;
  }

  set(path: string, languageId: string, text: string): void {
    const old = this.files.get(path);
    const id = this.paths.push(path) - 1;
    const entry = { id, languageId, chunks: 0 };
    this.files.set(path, entry);
    const lf = text.replace(/\r\n/g, '\n');
    const lines = lf.split('\n');
    for (let start = 0; start < lines.length; start += CHUNK_LINES) {
      const toks = tokens(lines.slice(start, start + CHUNK_LINES).join('\n'));
      if (!toks.size) continue;
      entry.chunks++;
      const chunk = this.chunkFile.push(id) - 1;
      this.chunkStart.push(start);
      this.chunkSize.push(toks.size);
      for (const t of toks) {
        const list = this.postings.get(t);
        if (list) list.push(chunk);
        else this.postings.set(own(t), [chunk]);
      }
    }
    for (const [name, line] of definitions(lf)) {
      const list = this.defs.get(name);
      if (list) list.push({ id, line });
      else this.defs.set(own(name), [{ id, line }]);
    }
    this.liveChunks += entry.chunks;
    if (old) this.retire(old.chunks);
  }

  delete(path: string): void {
    const old = this.files.get(path);
    if (!old) return;
    this.files.delete(path);
    this.retire(old.chunks);
  }

  /**
   * Stale entries would otherwise pile up with every save, and count against FREQUENT:
   * a file saved often would switch off similarity for its own tokens.
   */
  private retire(chunks: number): void {
    this.liveChunks -= chunks;
    this.staleChunks += chunks;
    if (this.staleChunks <= this.liveChunks) return;
    for (const [t, list] of this.postings) {
      const kept = list.filter((c) => this.live(this.chunkFile[c]));
      if (kept.length) this.postings.set(t, kept);
      else this.postings.delete(t);
    }
    for (const [name, list] of this.defs) {
      const kept = list.filter((d) => this.live(d.id));
      if (kept.length) this.defs.set(name, kept);
      else this.defs.delete(name);
    }
    this.staleChunks = 0;
  }

  /**
   * Up to MAX_HITS snippets for the code before the cursor, one per file, none from `exclude`.
   * Definitions of specific names used near the cursor (and not declared in `window`) come first, then similar chunks.
   * Deterministic, and the partial identifier at the cursor is ignored, so typing inside a name keeps the result.
   */
  pick(prefix: string, window: string, exclude: ReadonlySet<string>): Hit[] {
    const query = prefix.split('\n').slice(-QUERY_LINES).join('\n').replace(/[\w$]+$/, '');
    const q = tokens(query);
    // Everything the window declares, locals included, is already visible to the model.
    const own = new Set([...definitions(window).keys(), ...[...window.matchAll(LOCAL)].map((m) => m[1])]);
    const hits: Hit[] = [];
    const used = new Set<string>();
    const usable = (id: number) => this.live(id) && !exclude.has(this.paths[id]) && !used.has(this.paths[id]);
    const add = (id: number, start: number, kind: Hit['kind']) => {
      const path = this.paths[id];
      used.add(path);
      hits.push({ path, languageId: this.files.get(path)!.languageId, start, end: start + CHUNK_LINES, kind });
    };

    // Free names only, nearest the cursor first: `x.model` is a property, not something defined under that name.
    const free = [...query.matchAll(IDENT)].filter((m) => query[m.index - 1] !== '.').map((m) => m[0]);
    const wanted = new Set(free.reverse().filter((t) => q.has(t) && !own.has(t) && SPECIFIC.test(t)));
    for (const name of wanted) {
      if (hits.length === MAX_HITS) return hits;
      const live = (this.defs.get(name) ?? []).filter((d) => this.live(d.id));
      // Ambiguous, or the current file or a recent tab defines it: another file's same-named definition would be noise.
      if (new Set(live.map((d) => d.id)).size > MAX_DEF_FILES || live.some((d) => exclude.has(this.paths[d.id]))) continue;
      const d = live.filter((d) => usable(d.id)).sort((a, b) => byPath(this.paths[a.id], this.paths[b.id]) || a.line - b.line)[0];
      if (d) add(d.id, d.line, 'def');
    }

    const shared = new Map<number, number>();
    for (const t of q) {
      const list = this.postings.get(t);
      if (list && list.length <= FREQUENT) for (const c of list) shared.set(c, (shared.get(c) ?? 0) + 1);
    }
    const ranked: { c: number; score: number }[] = [];
    for (const [c, n] of shared) {
      const score = n / (q.size + this.chunkSize[c] - n);
      if (n >= MIN_SHARED && score >= MIN_SIM && usable(this.chunkFile[c])) ranked.push({ c, score });
    }
    ranked.sort(
      (a, b) =>
        b.score - a.score || byPath(this.paths[this.chunkFile[a.c]], this.paths[this.chunkFile[b.c]]) || this.chunkStart[a.c] - this.chunkStart[b.c],
    );
    for (const { c } of ranked) {
      if (hits.length === MAX_HITS) break;
      if (usable(this.chunkFile[c])) add(this.chunkFile[c], this.chunkStart[c], 'sim');
    }
    return hits;
  }
}
