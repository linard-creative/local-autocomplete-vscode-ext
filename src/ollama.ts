// The only module allowed to make network calls (enforced by eslint). Types follow
// https://github.com/ollama/ollama/blob/main/docs/api.md, limited to the fields we use.

export interface GenerateRequest {
  model: string;
  prompt: string;
  suffix?: string;
  raw?: boolean;
  stream: false;
  keep_alive?: string | number;
  options?: { num_predict?: number; temperature?: number; num_ctx?: number; stop?: string[]; top_p?: number };
}

export interface GenerateResponse {
  response: string;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface ShowResponse {
  template?: string;
  capabilities?: string[];
  details?: { family?: string };
}

export type OllamaErrorKind = 'connection' | 'timeout' | 'http' | 'model-not-found' | 'invalid-response' | 'aborted';

export class OllamaError extends Error {
  constructor(
    readonly kind: OllamaErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function toOllamaError(e: unknown): OllamaError {
  if (e instanceof OllamaError) return e;
  const name = (e as { name?: string })?.name;
  if (name === 'TimeoutError') return new OllamaError('timeout', 'Request timed out');
  if (name === 'AbortError') return new OllamaError('aborted', 'Request aborted');
  return new OllamaError('connection', `Cannot reach Ollama: ${(e as Error)?.message ?? e}`);
}

async function request<T>(endpoint: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  try {
    const res = await fetch(endpoint + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      // Truncated: error bodies may echo request content.
      const text = (await res.text().catch(() => '')).slice(0, 200);
      const kind = res.status === 404 && /not found/i.test(text) ? 'model-not-found' : 'http';
      throw new OllamaError(kind, `HTTP ${res.status}: ${text}`, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new OllamaError('invalid-response', 'Response is not valid JSON');
    }
  } catch (e) {
    throw toOllamaError(e);
  }
}

export async function generate(endpoint: string, body: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
  const res = await request<GenerateResponse>(endpoint, '/api/generate', body, signal);
  if (typeof res?.response !== 'string') throw new OllamaError('invalid-response', 'Missing "response" field');
  return res;
}

export interface TagModel {
  name: string;
  size: number;
  details?: { parameter_size?: string; quantization_level?: string };
}

export async function listModels(endpoint: string, signal?: AbortSignal): Promise<TagModel[]> {
  const res = await request<{ models?: TagModel[] }>(endpoint, '/api/tags', undefined, signal);
  if (!Array.isArray(res?.models)) throw new OllamaError('invalid-response', 'Missing "models" field');
  return res.models;
}

export async function getVersion(endpoint: string, signal?: AbortSignal): Promise<string> {
  const res = await request<{ version?: string }>(endpoint, '/api/version', undefined, signal);
  return res?.version ?? 'unknown';
}

export function showModel(endpoint: string, model: string, signal?: AbortSignal): Promise<ShowResponse> {
  return request<ShowResponse>(endpoint, '/api/show', { model }, signal);
}
