import { describe, expect, it } from 'vitest';
import { definitions, FREQUENT, sliceLines, tokens, WorkspaceIndex } from '../src/retrieve';

const invoice =
  'import { Item } from "./item";\n\nexport function computeInvoiceTotal(items: Item[]): number {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n';
const none = new Set<string>();

describe('tokens and definitions', () => {
  it('tokens drops keywords, short names and common words', () => {
    expect([...tokens('const total = items.map((x) => this.price); return total;')].sort()).toEqual(['items', 'map', 'price', 'total']);
  });

  it('definitions finds declarations across languages with their line', () => {
    const d = definitions(
      'export function foo() {}\nclass Bar {}\ndef baz(x):\nconst qux = 1;\nfunc (r *T) Quux() {}\nlet n: number = 2;\n  method(a, b) {\nif (x) {\n',
    );
    expect(Object.fromEntries(d)).toEqual({ foo: 0, Bar: 1, baz: 2, qux: 3, Quux: 4, n: 5, method: 6 });
  });

  it('definitions skips local variables', () => {
    expect(Object.fromEntries(definitions('function f() {\n  const local = 1;\n  for (let i = 0; ; ) {}\n}\nexport const top = 2;\n'))).toEqual({
      f: 0,
      top: 4,
    });
  });

  it('sliceLines cuts LF or CRLF text to the same lines', () => {
    expect(sliceLines('a\r\nb\r\nc\r\n', 1, 3)).toBe('b\nc');
    expect(sliceLines('a\nb\nc\n', 1, 3)).toBe('b\nc');
  });
});

describe('WorkspaceIndex.pick', () => {
  it('a call to a name defined in another file picks that definition first', () => {
    const ix = new WorkspaceIndex();
    ix.set('src/invoice.ts', 'typescript', invoice);
    ix.set('src/other.ts', 'typescript', 'export function unrelated() {}\n');
    expect(ix.pick('const t = computeInvoiceTotal(cart.items);\n', '', none)[0]).toEqual({
      path: 'src/invoice.ts',
      languageId: 'typescript',
      start: 2,
      end: 22,
      kind: 'def',
    });
  });

  it('a name the current window already defines is not looked up', () => {
    const ix = new WorkspaceIndex();
    ix.set('src/invoice.ts', 'typescript', invoice);
    expect(ix.pick('computeInvoiceTotal(x);\n', 'function computeInvoiceTotal() {}', none)).toEqual([]);
  });

  it('a property name after a dot is not looked up', () => {
    const ix = new WorkspaceIndex();
    ix.set('src/models.ts', 'typescript', 'export const modelName = loadModel();\n');
    expect(ix.pick('const m = settings.modelName;\n', '', none)).toEqual([]);
    expect(ix.pick('const m = modelName;\n', '', none)).toHaveLength(1);
  });

  it('only specific names (camelCase, PascalCase, snake_case) are looked up', () => {
    const ix = new WorkspaceIndex();
    ix.set('src/parse.ts', 'typescript', 'export function parse() {}\nexport function parseConfig() {}\n');
    ix.set('src/parse.py', 'python', 'def parse_config():\n    pass\n');
    ix.set('src/types.ts', 'typescript', 'export interface Config {}\n');
    expect(ix.pick('parse(x);\n', '', none)).toEqual([]);
    expect(ix.pick('parseConfig(x);\n', '', none).map((h) => h.path)).toEqual(['src/parse.ts']);
    expect(ix.pick('parse_config(x)\n', '', none).map((h) => h.path)).toEqual(['src/parse.py']);
    expect(ix.pick('let c: Config;\n', '', none).map((h) => h.path)).toEqual(['src/types.ts']);
  });

  it('a local variable of the current window is not looked up', () => {
    const ix = new WorkspaceIndex();
    ix.set('src/io.ts', 'typescript', 'export const fileText = "";\n');
    const window = 'function f() {\n  const fileText = read();\n  use(fileText);\n';
    expect(ix.pick(window, window, none)).toEqual([]);
  });

  it('a name the current file or a recent tab defines is not looked up elsewhere', () => {
    const ix = new WorkspaceIndex();
    ix.set('src/invoice.ts', 'typescript', invoice);
    ix.set('src/current.ts', 'typescript', 'export function computeInvoiceTotal() {}\n');
    expect(ix.pick('computeInvoiceTotal(x);\n', '', new Set(['src/current.ts']))).toEqual([]);
  });

  it('a name defined in more than 3 files is ambiguous and ignored', () => {
    const ix = new WorkspaceIndex();
    for (const f of ['a', 'b', 'c', 'd']) ix.set(`src/${f}.ts`, 'typescript', 'export function renderView() {}\n');
    expect(ix.pick('renderView();\n', '', none)).toEqual([]);
  });

  it('excluded paths, deleted files and rewritten files never come back', () => {
    const ix = new WorkspaceIndex();
    ix.set('src/invoice.ts', 'typescript', invoice);
    expect(ix.pick('computeInvoiceTotal(x);\n', '', new Set(['src/invoice.ts']))).toEqual([]);
    ix.set('src/invoice.ts', 'typescript', 'export const nothing = 1;\n');
    expect(ix.pick('computeInvoiceTotal(x);\n', '', none)).toEqual([]);
    ix.set('src/b.ts', 'typescript', invoice);
    ix.delete('src/b.ts');
    expect(ix.pick('computeInvoiceTotal(x);\n', '', none)).toEqual([]);
    expect(ix.size).toBe(1);
  });

  it('similar code is picked only above the threshold, at most one hit per file and 2 overall', () => {
    const ix = new WorkspaceIndex();
    const similar = 'export function apply(item) {\n  let sum = item.shippingCost + item.taxRate;\n  sum -= item.discountCode.value;\n  return sum;\n}\n';
    for (const f of ['a', 'b', 'c']) ix.set(`src/${f}.ts`, 'typescript', similar + similar);
    ix.set('src/zoo.ts', 'typescript', 'export const zebra = giraffe.neck;\n');
    const hits = ix.pick('  total += item.shippingCost * item.taxRate;\n  total -= item.discountCode.value;\n', '', none);
    expect(hits.map((h) => [h.path, h.kind])).toEqual([
      ['src/a.ts', 'sim'],
      ['src/b.ts', 'sim'],
    ]);
    expect(ix.pick('const elephant = rhino.horn;\n', '', none)).toEqual([]);
  });

  it('typing inside an identifier keeps the picks identical', () => {
    const ix = new WorkspaceIndex();
    ix.set('src/invoice.ts', 'typescript', invoice);
    const p = (tail: string) => ix.pick(`const t = computeInvoiceTotal(cart);\n${tail}`, '', none);
    expect(p('comp')).toEqual(p('compu'));
    expect(p('compu')).toEqual(p(''));
    expect(p('')).toHaveLength(1);
  });

  it('a file saved thousands of times still matches as similar code', () => {
    const ix = new WorkspaceIndex();
    const similar = 'export function apply(item) {\n  let sum = item.shippingCost + item.taxRate;\n  sum -= item.discountCode.value;\n  return sum;\n}\n';
    for (let i = 0; i <= FREQUENT; i++) ix.set('src/a.ts', 'typescript', similar);
    expect(ix.pick('  total += item.shippingCost * item.taxRate;\n  total -= item.discountCode.value;\n', '', none).map((h) => h.kind)).toEqual(['sim']);
  });

  it('CRLF text gives the same line numbers as LF', () => {
    const a = new WorkspaceIndex();
    const b = new WorkspaceIndex();
    a.set('x.ts', 'typescript', invoice);
    b.set('x.ts', 'typescript', invoice.replace(/\n/g, '\r\n'));
    expect(b.pick('computeInvoiceTotal(1);\n', '', none)).toEqual(a.pick('computeInvoiceTotal(1);\n', '', none));
    expect(a.pick('computeInvoiceTotal(1);\n', '', none)[0].start).toBe(2);
  });
});
