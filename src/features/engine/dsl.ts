import type { JSONSchema, MethodMode } from '@wtop/types';

export type NodeType =
  | 'start' | 'end' | 'call-wtop' | 'call-http' | 'http' | 'transform' | 'condition'
  | 'switch' | 'loop' | 'parallel' | 'merge' | 'approval' | 'subflow'
  | 'const' | 'input' | 'output' | 'function';

export interface RetryDef { max: number; on?: string[]; backoffMs?: number }

export interface FlowNode {
  id: string;
  type: NodeType;
  onError?: 'fail' | 'skip' | 'fallback';
  retry?: RetryDef;
  // start
  inputSchema?: JSONSchema;
  // end
  outputMapping?: Record<string, unknown>;
  // call-wtop / call-http / subflow
  toolId?: string;
  method?: string;
  endpoint?: string;
  inputMapping?: Record<string, unknown>;
  mode?: MethodMode;
  timeoutMs?: number;
  preserveScene?: boolean;
  // http（免注册直连）
  url?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
  // transform / condition
  expression?: string;
  // function
  code?: string;
  // switch
  cases?: { value: string; expression: string }[];
  // loop
  itemsExpression?: string;
  itemVar?: string;
  concurrency?: number;
  subGraph?: { nodes: FlowNode[]; edges: FlowEdge[] };
  // merge
  strategy?: 'array' | 'object' | 'first';
  // approval
  prompt?: string;
  // subflow
  flowId?: string;
  // const / output
  value?: unknown;
  // output
  title?: string;
  format?: 'auto' | 'json' | 'text' | 'table';
  filename?: string;
  mime?: string;
  // 画布坐标（不参与执行）
  x?: number;
  y?: number;
}

export interface FlowEdge { from: string; to: string; branch?: string }

export interface DSL {
  id: string;
  name: string;
  version: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export const DSL_SCHEMA: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id', 'name', 'version', 'nodes', 'edges'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    nodes: { type: 'array', items: { $ref: '#/$defs/node' } },
    edges: { type: 'array', items: { $ref: '#/$defs/edge' } },
  },
  $defs: {
    binding: {
      type: ['string', 'number', 'boolean', 'object', 'array', 'null'],
    },
    mapping: { type: 'object', additionalProperties: { $ref: '#/$defs/binding' } },
    retry: {
      type: 'object',
      properties: {
        max: { type: 'integer', minimum: 0 },
        on: { type: 'array', items: { type: 'string' } },
        backoffMs: { type: 'integer', minimum: 0 },
      },
    },
    edge: {
      type: 'object',
      required: ['from', 'to'],
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        branch: { type: 'string' },
      },
    },
    node: {
      type: 'object',
      required: ['id', 'type'],
      properties: {
        id: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$' },
        type: {
          enum: ['start', 'end', 'call-wtop', 'call-http', 'http', 'transform', 'condition',
            'switch', 'loop', 'parallel', 'merge', 'approval', 'subflow', 'const', 'input', 'output', 'function'],
        },
        onError: { enum: ['fail', 'skip', 'fallback'], default: 'fail' },
        retry: { $ref: '#/$defs/retry' },
      },
      allOf: [
        { if: { properties: { type: { const: 'start' } } }, then: { required: ['inputSchema'], properties: { inputSchema: { type: 'object' } } } },
        { if: { properties: { type: { const: 'end' } } }, then: { required: ['outputMapping'], properties: { outputMapping: { $ref: '#/$defs/mapping' } } } },
        { if: { properties: { type: { const: 'call-wtop' } } }, then: { required: ['toolId', 'method', 'inputMapping'], properties: { toolId: { type: 'string' }, method: { type: 'string' }, inputMapping: { $ref: '#/$defs/mapping' }, mode: { enum: ['headless', 'hybrid', 'interactive'] }, timeoutMs: { type: 'integer' }, preserveScene: { type: 'boolean', default: true } } } },
        { if: { properties: { type: { const: 'call-http' } } }, then: { required: ['toolId', 'endpoint', 'inputMapping'], properties: { toolId: { type: 'string' }, endpoint: { type: 'string' }, inputMapping: { $ref: '#/$defs/mapping' }, timeoutMs: { type: 'integer' } } } },
        { if: { properties: { type: { const: 'http' } } }, then: { required: ['url'], properties: { url: { type: 'string', minLength: 1 }, method: { enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] }, query: { $ref: '#/$defs/mapping' }, headers: { $ref: '#/$defs/mapping' }, body: { $ref: '#/$defs/binding' }, timeoutMs: { type: 'integer', minimum: 1 } } } },
        { if: { properties: { type: { const: 'transform' } } }, then: { required: ['expression'], properties: { expression: { type: 'string' } } } },
        { if: { properties: { type: { const: 'condition' } } }, then: { required: ['expression'], properties: { expression: { type: 'string' } } } },
        { if: { properties: { type: { const: 'switch' } } }, then: { required: ['cases'], properties: { cases: { type: 'array', items: { type: 'object', required: ['value', 'expression'], properties: { value: { type: 'string' }, expression: { type: 'string' } } } } } } },
        { if: { properties: { type: { const: 'loop' } } }, then: { required: ['itemsExpression', 'subGraph'], properties: { itemsExpression: { type: 'string' }, itemVar: { type: 'string', default: 'item' }, concurrency: { type: 'integer', minimum: 1, default: 1 }, subGraph: { type: 'object' } } } },
        { if: { properties: { type: { const: 'merge' } } }, then: { properties: { strategy: { enum: ['array', 'object', 'first'], default: 'array' } } } },
        { if: { properties: { type: { const: 'approval' } } }, then: { required: ['prompt'], properties: { prompt: { type: 'string' } } } },
        { if: { properties: { type: { const: 'subflow' } } }, then: { required: ['flowId', 'inputMapping'], properties: { flowId: { type: 'string' }, inputMapping: { $ref: '#/$defs/mapping' } } } },
        { if: { properties: { type: { const: 'const' } } }, then: { required: ['value'], properties: { value: { $ref: '#/$defs/binding' } } } },
        { if: { properties: { type: { const: 'input' } } }, then: { required: ['inputSchema'], properties: { inputSchema: { type: 'object' }, prompt: { type: 'string' } } } },
        { if: { properties: { type: { const: 'output' } } }, then: { required: ['value'], properties: { value: { $ref: '#/$defs/binding' }, title: { type: 'string' }, format: { enum: ['auto', 'json', 'text', 'table'] }, filename: { type: 'string' }, mime: { type: 'string' } } } },
        { if: { properties: { type: { const: 'function' } } }, then: { required: ['code'], properties: { code: { type: 'string' }, inputMapping: { $ref: '#/$defs/mapping' }, timeoutMs: { type: 'integer', minimum: 1 } } } },
      ],
    },
  },
};
/** v2.2：旧 call-http（需注册工具）→ 独立 http 节点。找不到工具定义时原样保留，交给校验报错 */
export function migrateDsl(dsl: DSL, tools: { id: string; url: string; http?: { endpoints: { name: string; method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; path: string; headers?: Record<string, string>; timeoutMs?: number }[] } }[]): DSL {
  const convert = (n: FlowNode): FlowNode => {
    if (n.type !== 'call-http') return n;
    const tool = tools.find((t) => t.id === n.toolId);
    const ep = tool?.http?.endpoints.find((e) => e.name === n.endpoint);
    if (!tool || !ep) return n;
    const params = { ...(n.inputMapping ?? {}) };
    let path = ep.path;
    for (const m of ep.path.matchAll(/\{\{(\w+)\}\}/g)) {
      const v = params[m[1]];
      path = path.replace(m[0], typeof v === 'string' ? v : encodeURIComponent(String(v ?? '')));
      delete params[m[1]];
    }
    const isGet = ep.method === 'GET' || ep.method === 'DELETE';
    const next: FlowNode = {
      id: n.id, type: 'http', method: ep.method,
      url: tool.url.replace(/\/+$/, '') + path,
      headers: ep.headers, timeoutMs: n.timeoutMs ?? ep.timeoutMs,
      x: n.x, y: n.y, onError: n.onError, retry: n.retry,
    };
    if (isGet) { if (Object.keys(params).length) next.query = params; }
    else if (Object.keys(params).length) {
      next.body = 'body' in params && Object.keys(params).length === 1 ? params.body : params;
    }
    return next;
  };
  return {
    ...dsl,
    nodes: dsl.nodes.map((n) => {
      const c = convert(n);
      return c.subGraph ? { ...c, subGraph: { ...c.subGraph, nodes: c.subGraph.nodes.map(convert) } } : c;
    }),
  };
}
