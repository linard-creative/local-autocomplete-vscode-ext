export interface Settings {
  enabled: boolean;
  endpoint: string;
  model: string;
  requestTimeoutMs: number;
  debounceMs: number;
  maxTokens: number;
  temperature: number;
  maxContextChars: number;
  numCtx: number;
  keepAlive: string;
  disabledLanguages: string[];
  recentTabs: boolean;
  recentTabsCount: number;
}

// Structural subset of vscode.WorkspaceConfiguration, so this module stays testable without VS Code.
export interface ConfigSource {
  get<T>(key: string): T | undefined;
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

/** 'remote' means code leaves this machine; the user must be warned. */
export function endpointProblem(endpoint: string): 'invalid' | 'remote' | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'invalid';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'invalid';
  const h = url.hostname;
  return h === 'localhost' || h === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(h) ? undefined : 'remote';
}

export function readSettings(c: ConfigSource): Settings {
  const langs = c.get<unknown>('disabledLanguages');
  return {
    enabled: c.get<unknown>('enabled') !== false,
    endpoint: str(c.get('endpoint'), 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    model: str(c.get('model'), ''),
    requestTimeoutMs: num(c.get('requestTimeoutMs'), 500, 60000, 5000),
    debounceMs: num(c.get('debounceMs'), 0, 2000, 250),
    maxTokens: Math.round(num(c.get('maxTokens'), 1, 1024, 128)),
    temperature: num(c.get('temperature'), 0, 2, 0.2),
    maxContextChars: num(c.get('maxContextChars'), 500, 100000, 6000),
    numCtx: Math.round(num(c.get('numCtx'), 512, 131072, 4096)),
    keepAlive: str(c.get('keepAlive'), '30m') || '30m',
    disabledLanguages: Array.isArray(langs) ? langs.filter((l): l is string => typeof l === 'string') : [],
    recentTabs: c.get<unknown>('recentTabs') !== false,
    recentTabsCount: Math.round(num(c.get('recentTabsCount'), 1, 10, 3)),
  };
}
