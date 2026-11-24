import jsonata from 'jsonata';
import { WtopError } from '@wtop/types';

export interface RunContext {
  start: { input: unknown };
  nodes: Record<string, { output: unknown }>;
  loop?: { item: unknown; index: number };
  env: Record<string, unknown>;
}

const EXPR_TIMEOUT_MS = 100;
const exprCache = new Map<string, jsonata.Expression>();

function compile(expr: string): jsonata.Expression {
  let e = exprCache.get(expr);
  if (!e) {
    e = jsonata(expr);
    exprCache.set(expr, e);
  }
  return e;
}

/** JSONata 受限求值：只暴露 context 数据，无宿主函数注入 */
export async function evalExpression(expr: string, ctx: RunContext): Promise<unknown> {
  const started = performance.now();
  try {
    const result = await compile(expr).evaluate({ context: ctx });
    if (performance.now() - started > EXPR_TIMEOUT_MS) {
      throw new Error(`表达式求值超过 ${EXPR_TIMEOUT_MS}ms`);
    }
    return result;
  } catch (e) {
    throw new WtopError('INVALID_INPUT', `表达式求值失败: ${expr} → ${String(e)}`);
  }
}

const FULL_BINDING = /^\{\{([\s\S]+)\}\}$/;
const INTERPOLATION = /\{\{([\s\S]+?)\}\}/g;

/** binding：整字段 {{expr}} 取求值结果；字符串内插值拼接；其余为常量 */
export async function evalBinding(binding: unknown, ctx: RunContext): Promise<unknown> {
  if (typeof binding !== 'string') return binding;
  const full = FULL_BINDING.exec(binding);
  if (full) return evalExpression(full[1].trim(), ctx);
  if (binding.includes('{{')) {
    const parts: unknown[] = [];
    let last = 0;
    for (const m of binding.matchAll(INTERPOLATION)) {
      parts.push(binding.slice(last, m.index));
      parts.push(await evalExpression(m[1].trim(), ctx));
      last = m.index! + m[0].length;
    }
    parts.push(binding.slice(last));
    return parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('');
  }
  return binding;
}

export async function evalMapping(
  mapping: Record<string, unknown>,
  ctx: RunContext,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mapping)) out[k] = await evalBinding(v, ctx);
  return out;
}