export interface CompletionContext {
  prefix: string;
  suffix: string;
}

const IMPORT = /^(import|from|#include|using|require|use)\b/;

/** File head through the last import-like line in the first 50 lines; '' if none or longer than `max`. */
function importBlock(text: string, max: number): string {
  const lines = text.split('\n', 50);
  const last = lines.findLastIndex((l) => IMPORT.test(l));
  // The final split element may be the partial cursor line, so it never counts.
  if (last === -1 || (lines.length < 50 && last === lines.length - 1)) return '';
  const head = lines.slice(0, last + 1).join('\n') + '\n';
  return head.length <= max ? head : '';
}

/**
 * Text around `offset` within `budget` chars: suffix gets up to 25% (more if the prefix is short), cut at line boundaries.
 * When the prefix window doesn't reach the top of the file, the import block is prepended so types and names stay visible.
 */
export function buildContext(text: string, offset: number, budget: number): CompletionContext {
  const before = text.slice(0, offset);
  const after = text.slice(offset);
  const suffixBudget = Math.min(after.length, Math.max(Math.floor(budget * 0.25), budget - before.length));
  let prefixBudget = budget - suffixBudget;

  // head.length <= 25% of budget keeps the window start past the head, so they never overlap.
  const head = before.length > prefixBudget ? importBlock(before, Math.floor(budget * 0.25)) : '';
  prefixBudget -= head.length;

  let prefix = before;
  if (prefix.length > prefixBudget) {
    prefix = prefix.slice(prefix.length - prefixBudget);
    const nl = prefix.indexOf('\n');
    if (nl !== -1) prefix = prefix.slice(nl + 1);
  }

  let suffix = after;
  if (suffix.length > suffixBudget) {
    suffix = suffix.slice(0, suffixBudget);
    const nl = suffix.lastIndexOf('\n');
    if (nl !== -1) suffix = suffix.slice(0, nl);
  }

  // LF only: the filter compares the model's `\n` output against the suffix, and models see LF far more in training.
  return { prefix: (head + prefix).replace(/\r\n/g, '\n'), suffix: suffix.replace(/\r\n/g, '\n') };
}

// Files that commonly hold secrets (spec §14): never completed in, never sent as recent-tab context.
const SECRET =
  /(^|[\\/])(\.env(\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.htpasswd|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.(json|ya?ml|toml|ini|txt))?|secrets?\.(json|ya?ml|toml|env|txt)|local\.settings\.json|[^\\/]*\.(pem|key|p12|pfx|jks|keystore|tfvars|tfstate(\.backup)?))$/i;

export const isSecretFile = (path: string): boolean => SECRET.test(path);

/** Code after the cursor on the same line means the completion must fit in that line. */
export const isSingleLine = (ctx: CompletionContext): boolean => /\S/.test(ctx.suffix.split('\n', 1)[0]);
