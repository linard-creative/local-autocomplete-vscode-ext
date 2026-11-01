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
