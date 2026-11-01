import { describe, expect, it } from 'vitest';
import { endpointProblem, readSettings } from '../src/config';
import { buildContext, isSingleLine } from '../src/context';
import { cleanCompletion } from '../src/filter';
import { buildRequest, fileHeader, findTemplate } from '../src/prompt';

describe('buildContext', () => {
  it('returns everything when within budget', () => {
    expect(buildContext('abc\ndef', 4, 100)).toEqual({ prefix: 'abc\n', suffix: 'def' });
  });

  it('cuts prefix and suffix at line boundaries', () => {
    const text = 'line1\nline2\nline3|tail1\ntail2\ntail3';
    const offset = text.indexOf('|');
    expect(buildContext(text, offset, 20).prefix).toBe('line2\nline3');
    expect(buildContext(text, offset, 32).suffix).toBe('|tail1\ntail2');
  });

  it('gives unused prefix budget to the suffix', () => {
    const { suffix } = buildContext('x' + 'y\n'.repeat(50), 1, 40);
    expect(suffix.length).toBeGreaterThan(10);
  });

  it('prepends the import block when the window does not reach the top', () => {
    const imports = "import a from 'a';\nimport { b } from 'b';\n";
    const text = imports + 'const x = 1;\n'.repeat(200) + 'foo(';
    const { prefix } = buildContext(text, text.length, 1000);
    expect(prefix.startsWith(imports + 'const x = 1;\n')).toBe(true);
    expect(prefix.endsWith('foo(')).toBe(true);
    expect(prefix.length).toBeLessThanOrEqual(1000);
  });

  it('skips the import block when the whole file fits', () => {
    const text = "import a from 'a';\nfoo(";
    expect(buildContext(text, text.length, 1000).prefix).toBe(text);
  });

  it('detects single-line mode from code after the cursor', () => {
    expect(isSingleLine({ prefix: '', suffix: ');\nnext' })).toBe(true);
    expect(isSingleLine({ prefix: '', suffix: '  \nnext' })).toBe(false);
  });
});

describe('cleanCompletion', () => {
  const multi = { prefix: '', suffix: '' };

  it('unwraps a fenced block', () => {
    expect(cleanCompletion('```ts\nreturn a + b;\n```', multi)).toBe('return a + b;');
  });

  it('removes a lone opening fence', () => {
    expect(cleanCompletion('```python\n  x = 1\n', multi)).toBe('  x = 1');
  });

  it('keeps indentation and inline backticks untouched', () => {
    expect(cleanCompletion('    const s = `a${b}`;\n', multi)).toBe('    const s = `a${b}`;');
  });

  it('strips a repeated cursor line', () => {
    expect(cleanCompletion('  const x = 1;', { prefix: 'a\n  const x = ', suffix: '' })).toBe('1;');
  });

  it('trims overlap with code after the cursor', () => {
    const suffix = '\nexport default f;\n';
    expect(cleanCompletion('return x;\n}\nexport default f;', { prefix: '', suffix })).toBe('return x;\n}');
  });

  it('keeps short overlaps (under 3 chars) to avoid cutting valid code', () => {
    expect(cleanCompletion('a, b);\n}', { prefix: 'f(', suffix: '\n}' })).toBe('a, b);\n}');
  });

  it('drops a leading prose line only', () => {
    expect(cleanCompletion('Here is the code:\nreturn 1;', multi)).toBe('return 1;');
    expect(cleanCompletion('This.value = 1;', multi)).toBe('This.value = 1;');
  });

  it('keeps one line in single-line mode and caps multi-line at 15', () => {
    expect(cleanCompletion('a + b\nextra', { prefix: '', suffix: ')' })).toBe('a + b');
    expect(cleanCompletion('x\n'.repeat(30), multi)!.split('\n')).toHaveLength(15);
  });

  it('drops the partial last line only when truncated', () => {
    expect(cleanCompletion('a();\nb(', multi, true)).toBe('a();');
    expect(cleanCompletion('a();\nb(', multi)).toBe('a();\nb(');
  });

  it('leaves valid code untouched', () => {
    const code = '  if (x) {\n    return "```";\n  }';
    expect(cleanCompletion(code, { prefix: 'function f() {\n', suffix: '\n}' })).toBe(code);
  });

  it('drops empty output', () => {
    expect(cleanCompletion('  \n\n', multi)).toBeUndefined();
  });
});

describe('readSettings', () => {
  const src = (v: Record<string, unknown>) => ({ get: <T>(k: string) => v[k] as T });

  it('clamps and defaults', () => {
    const s = readSettings(src({ endpoint: 'http://h:1/', debounceMs: -5, maxTokens: 'x', disabledLanguages: ['go', 3] }));
    expect(s.endpoint).toBe('http://h:1');
    expect(s.debounceMs).toBe(0);
    expect(s.maxTokens).toBe(128);
    expect(s.disabledLanguages).toEqual(['go']);
    expect(s.enabled).toBe(true);
  });
});

describe('buildRequest', () => {
  const s = readSettings({ get: () => undefined });
  const file = { path: 'src/a.py', languageId: 'python' };

  it('uses native suffix when the model supports insert', () => {
    const body = buildRequest({ prefix: 'def f():\n', suffix: '\n' }, file, { insert: true }, s);
    expect(body.prompt).toBe('# File: src/a.py (python)\ndef f():\n');
    expect(body.suffix).toBe('\n');
    expect(body.raw).toBeUndefined();
  });

  it('falls back to raw prefix-only', () => {
    const body = buildRequest({ prefix: 'x', suffix: 'y' }, file, { insert: false }, s);
    expect(body.raw).toBe(true);
    expect(body.suffix).toBeUndefined();
  });

  it('wraps a built-in FIM template and adds a line stop in single-line mode', () => {
    const t = findTemplate('deepseek-coder:6.7b')!;
    const body = buildRequest({ prefix: 'f(', suffix: ')' }, file, { insert: false, template: t }, s);
    expect(body.prompt).toBe('<｜fim▁begin｜># File: src/a.py (python)\nf(<｜fim▁hole｜>)<｜fim▁end｜>');
    expect(body.raw).toBe(true);
    expect(body.options?.stop).toEqual([...t.stop, '\n']);
  });

  it('matches templates by name or family, not unknown models', () => {
    expect(findTemplate('my-starcoder2:3b')).toBeDefined();
    expect(findTemplate('custom', 'codellama')).toBeDefined();
    expect(findTemplate('llama3.2:3b', 'llama')).toBeUndefined();
  });

  it('omits header for languages without line comments', () => {
    expect(fileHeader({ path: 'a.json', languageId: 'json' })).toBe('');
  });
});

describe('endpointProblem', () => {
  it('accepts loopback hosts', () => {
    for (const e of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434', 'https://127.1.2.3'])
      expect(endpointProblem(e)).toBeUndefined();
  });

  it('flags remote and invalid endpoints', () => {
    expect(endpointProblem('http://192.168.1.5:11434')).toBe('remote');
    expect(endpointProblem('http://localhost.evil.com')).toBe('remote');
    expect(endpointProblem('not a url')).toBe('invalid');
    expect(endpointProblem('ftp://127.0.0.1')).toBe('invalid');
  });
});
