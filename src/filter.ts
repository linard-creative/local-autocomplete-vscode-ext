import { isSingleLine, type CompletionContext } from './context';

const MAX_LINES = 15;
const PROSE = /^(Here|Sure|This |The following).*:\s*$/;

/**
 * Conservative cleanup (spec §10): every rule is an exact match, and indentation and code content are never rewritten.
 * `truncated` is true when the model hit the token limit (done_reason "length").
 */
export function cleanCompletion(raw: string, ctx: CompletionContext, truncated = false): string | undefined {
  let text = raw;

  const fenced = /^\s*```[\w+#.-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fenced) text = fenced[1];
  else text = text.replace(/^\s*```[\w+#.-]*\n/, '').replace(/\n```\s*$/, '');

  // Model repeated the line the cursor is on.
  const lastLine = ctx.prefix.slice(ctx.prefix.lastIndexOf('\n') + 1);
  if (lastLine.trim().length >= 3 && text.startsWith(lastLine)) text = text.slice(lastLine.length);

  // Model ran into code that already follows the cursor.
  const after = ctx.suffix.trimStart();
  for (let k = Math.min(text.length, after.length); k >= 3; k--) {
    if (text.endsWith(after.slice(0, k))) {
      text = text.slice(0, -k);
      break;
    }
  }

  let lines = text.split('\n');
  if (PROSE.test(lines[0])) lines = lines.slice(1);
  if (truncated && lines.length > 1) lines.pop();
  text = lines.slice(0, isSingleLine(ctx) ? 1 : MAX_LINES).join('\n').trimEnd();

  return text.trim() ? text : undefined;
}

const balanced = (line: string): boolean => {
  const s = line.replace(/\\./g, '');
  const n = (c: string) => s.split(c).length - 1;
  return n('(') === n(')') && n('[') === n(']') && n('{') === n('}') && ['"', "'", '`'].every((q) => n(q) % 2 === 0);
};

/**
 * True when the completion should replace `rest` (the code after the cursor on its line, e.g. an auto-closed `")`)
 * instead of going in front of it. `rest` must appear in the completion in order, so nothing typed is lost,
 * and only the replaced line may balance its brackets and quotes.
 */
export function replacesRest(before: string, text: string, rest: string): boolean {
  if (!rest || text.includes('\n')) return false;
  let i = 0;
  for (const c of text) if (c === rest[i]) i++;
  return i === rest.length && balanced(before + text) && !balanced(before + text + rest);
}
