import Ajv2020 from 'ajv/dist/2020.js';
import type { HttpEndpoint, ToolRecord } from '../../db/types';

export class EngineError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat('wtop-file', { type: 'string', validate: () => true });

export interface HttpCallOptions {
  signal: AbortSignal;
  timeoutMs?: number;
  getSecret?: (name: string) => string | undefined;
  fetcher?: typeof fetch;
  /** 超时与取消区分 */
  timedOut?: () => boolean;
}

export async function callHttp(
  tool: ToolRecord,
  endpoint: HttpEndpoint,
  params: Record<string, unknown>,
  opts: HttpCallOptions,
): Promise<unknown> {
  const doFetch = opts.fetcher ?? fetch;
  let path = endpoint.path;
  const rest: Record<string, unknown> = { ...params };
  for (const m of endpoint.path.matchAll(/\{\{(\w+)\}\}/g)) {
    const key = m[1];
    path = path.replace(m[0], encodeURIComponent(String(rest[key] ?? '')));
    delete rest[key];
  }

  const props = (endpoint.input.properties ?? {}) as Record<string, Record<string, unknown>>;
  const query: Record<string, string> = {};
  let body: unknown;
  const bodyFields: Record<string, unknown> = {};
  const isGet = endpoint.method === 'GET' || endpoint.method === 'DELETE';
  for (const [k, v] of Object.entries(rest)) {
    const loc = props[k]?.in ?? (isGet ? 'query' : 'body');
    if (loc === 'query') query[k] = String(v);
    else bodyFields[k] = v;
  }
  if (Object.keys(bodyFields).length) {
    body = 'body' in rest && Object.keys(rest).length === 1 ? rest.body : bodyFields;
  }

  let url = tool.url.replace(/\/+$/, '') + path;
  const qs = new URLSearchParams(query).toString();
  if (qs) url += (url.includes('?') ? '&' : '?') + qs;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(endpoint.headers ?? {})) {
    headers[k] = v.replace(/\{\{secret:([\w-]+)\}\}/g, (_s, name) => opts.getSecret?.(name) ?? '');
  }
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await doFetch(url, {
      method: endpoint.method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal.aborted) {
      throw opts.timedOut?.()
        ? new EngineError('TIMEOUT', `HTTP 请求超时: ${url}`)
        : new EngineError('CANCELLED', 'HTTP 请求被取消');
    }
    throw new EngineError('HTTP_NETWORK', `网络/CORS 失败: ${String(e)}`);
  }
  if (!res.ok) {
    throw new EngineError('HTTP_STATUS', `HTTP ${res.status} ${res.statusText}`, { status: res.status });
  }
  const ct = res.headers.get('content-type') ?? '';
  let data: unknown;
  if (ct.includes('application/json')) data = await res.json();
  else if (ct.startsWith('text/')) data = await res.text();
  else data = await res.blob();

  if (endpoint.output && Object.keys(endpoint.output).length) {
    const validate = ajv.compile(endpoint.output);
    if (!validate(data)) {
      throw new EngineError('INVALID_OUTPUT', `响应不符合 output schema: ${ajv.errorsText(validate.errors)}`);
    }
  }
  return data;
}