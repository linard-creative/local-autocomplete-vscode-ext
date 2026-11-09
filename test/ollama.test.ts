import { afterEach, describe, expect, it, vi } from 'vitest';
import { generate, getVersion, listModels, OllamaError, showModel, type GenerateRequest } from '../src/ollama';

const url = 'http://127.0.0.1:11434';
const body: GenerateRequest = { model: 'm:1b', prompt: 'p', suffix: 's', stream: false, options: { num_predict: 8 } };

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const kindOf = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e) => (e instanceof OllamaError ? e.kind : `not an OllamaError: ${e}`),
  );

afterEach(() => vi.unstubAllGlobals());

describe('ollama client', () => {
  it('posts the generate body as JSON to /api/generate', async () => {
    const fn = stubFetch(async () => Response.json({ response: 'x', done: true }));
    expect((await generate(url, body)).response).toBe('x');
    const [u, init] = fn.mock.calls[0];
    expect(u).toBe(`${url}/api/generate`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('uses GET without a body for tags and version', async () => {
    const fn = stubFetch(async (u) => Response.json(u.endsWith('/api/tags') ? { models: [] } : { version: '0.9' }));
    expect(await listModels(url)).toEqual([]);
    expect(await getVersion(url)).toBe('0.9');
    for (const [, init] of fn.mock.calls) expect(init).toMatchObject({ method: 'GET', body: undefined });
  });

  it('maps connection refused', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })));
    expect(await kindOf(generate(url, body))).toBe('connection');
  });

  it('maps a timeout signal', async () => {
    stubFetch(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    expect(await kindOf(generate(url, body, AbortSignal.timeout(1)))).toBe('timeout');
  });

  it('propagates abort to fetch and maps it', async () => {
    let seen: AbortSignal | undefined;
    stubFetch((_, init) => {
      seen = init.signal!;
      return new Promise((_, reject) => seen!.addEventListener('abort', () => reject(seen!.reason)));
    });
    const controller = new AbortController();
    const p = kindOf(generate(url, body, controller.signal));
    controller.abort();
    expect(await p).toBe('aborted');
    expect(seen?.aborted).toBe(true);
  });

  it('maps 404 "model not found" separately from other 404s', async () => {
    stubFetch(async () => Response.json({ error: "model 'm:1b' not found" }, { status: 404 }));
    expect(await kindOf(generate(url, body))).toBe('model-not-found');
    // Ollama's reply for an unknown path, e.g. an endpoint ending in /api.
    stubFetch(async () => new Response('404 page not found', { status: 404 }));
    expect(await kindOf(generate(url, body))).toBe('http');
  });

  it('maps 5xx to http with the status and a truncated body', async () => {
    stubFetch(async () => new Response('x'.repeat(1000), { status: 500 }));
    const e = (await generate(url, body).catch((e) => e)) as OllamaError;
    expect(e).toMatchObject({ kind: 'http', status: 500 });
    expect(e.message.length).toBeLessThan(220);
  });

  it('maps bad JSON and missing fields to invalid-response', async () => {
    stubFetch(async () => new Response('not json'));
    expect(await kindOf(generate(url, body))).toBe('invalid-response');
    stubFetch(async () => Response.json({ done: true }));
    expect(await kindOf(generate(url, body))).toBe('invalid-response');
    stubFetch(async () => Response.json({}));
    expect(await kindOf(listModels(url))).toBe('invalid-response');
  });

  it('sends the model name to /api/show', async () => {
    const fn = stubFetch(async () => Response.json({ capabilities: ['insert'] }));
    expect((await showModel(url, 'm:1b')).capabilities).toEqual(['insert']);
    expect(JSON.parse(fn.mock.calls[0][1].body as string)).toEqual({ model: 'm:1b' });
  });
});
