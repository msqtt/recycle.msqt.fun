import Ajv2020 from 'ajv/dist/2020.js';
import { DSL_SCHEMA, type DSL, type FlowNode } from './dsl';
import type { ToolRecord } from '../../db/types';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const dslValidator = ajv.compile(DSL_SCHEMA);

export function validateDslSchema(dsl: unknown): string[] {
  if (dslValidator(dsl)) return [];
  return (dslValidator.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

function hasCycle(nodes: FlowNode[], edges: { from: string; to: string }[]): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const state = new Map<string, 1 | 2>();
  const dfs = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const next of adj.get(id) ?? []) if (dfs(next)) return true;
    state.set(id, 2);
    return false;
  };
  return nodes.some((n) => dfs(n.id));
}

export interface ValidationIssue { level: 'error' | 'warn'; message: string }

/** 图级校验（Host 设计 §14 + v2 §2.4）：error 阻止运行，warn 仅提示 */
export function validateGraphDetailed(dsl: DSL, tools: ToolRecord[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (message: string) => issues.push({ level: 'error', message });
  const warn = (message: string) => issues.push({ level: 'warn', message });
  const ids = new Set<string>();
  for (const n of dsl.nodes) {
    if (ids.has(n.id)) err(`节点 id 重复: ${n.id}`);
    ids.add(n.id);
  }
  if (!dsl.nodes.some((n) => n.type === 'start')) err('缺少 start 节点');
  if (!dsl.nodes.some((n) => n.type === 'end')) err('缺少 end 节点');
  for (const e of dsl.edges) {
    if (!ids.has(e.from)) err(`边起点不存在: ${e.from}`);
    if (!ids.has(e.to)) err(`边终点不存在: ${e.to}`);
  }
  if (hasCycle(dsl.nodes, dsl.edges)) err('流程存在环（循环请用 loop 节点）');

  // 从 start 出发的可达性
  const adj = new Map<string, string[]>();
  for (const e of dsl.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const reachable = new Set<string>();
  const queue = dsl.nodes.filter((n) => n.type === 'start').map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...(adj.get(id) ?? []));
  }

  for (const n of dsl.nodes) {
    if (n.type === 'condition') {
      const branches = dsl.edges.filter((e) => e.from === n.id).map((e) => e.branch);
      if (!branches.includes('true') || !branches.includes('false')) {
        err(`condition ${n.id} 需要 true/false 两条出边`);
      }
    }
    if (n.type === 'call-wtop' || n.type === 'call-http') {
      const tool = tools.find((t) => t.id === n.toolId);
      if (!tool) { err(`节点 ${n.id} 的工具不存在: ${n.toolId}`); continue; }
      if (n.type === 'call-wtop') {
        if (tool.type !== 'wtop') err(`节点 ${n.id} 需要 wtop 工具`);
        else {
          const method = tool.manifest?.methods.find((m) => m.name === n.method);
          if (!method) err(`节点 ${n.id} 的方法不存在: ${n.method}`);
          else {
            const required = (method.input as { required?: string[] })?.required ?? [];
            const missing = required.filter((k) => !(k in (n.inputMapping ?? {})));
            if (missing.length) warn(`节点 ${n.id} 必填字段未绑定: ${missing.join(', ')}`);
          }
        }
      } else {
        if (tool.type !== 'http') err(`节点 ${n.id} 需要 http 工具`);
        else if (!tool.http?.endpoints.some((e) => e.name === n.endpoint)) {
          err(`节点 ${n.id} 的 endpoint 不存在: ${n.endpoint}`);
        }
      }
    }
    if (n.type === 'http' && !(n.url ?? '').trim()) err(`http 节点 ${n.id} 未配置 url`);
    if (n.type === 'loop' && n.subGraph) {
      const sub = n.subGraph;
      if (hasCycle(sub.nodes, sub.edges)) err(`loop ${n.id} 子图存在环`);
    }
    if (n.type !== 'start' && !reachable.has(n.id)) {
      warn(`节点 ${n.id} 从 start 不可达（未接入流程，不会被执行）`);
    }
    if (n.type === 'end') {
      if (!Object.keys(n.outputMapping ?? {}).length) {
        warn(`end ${n.id} 的输出映射为空，流程输出将是 {}`);
      }
      if (!reachable.has(n.id)) err(`end ${n.id} 从 start 不可达`);
    }
  }
  if (dsl.nodes.length > 2) {
    const startNode = dsl.nodes.find((n) => n.type === 'start');
    const endNode = dsl.nodes.find((n) => n.type === 'end');
    if (startNode && endNode && dsl.edges.some((e) => e.from === startNode.id && e.to === endNode.id)) {
      warn('start 直连 end：end 会先于其他节点完成，输出可能为空。建议把 end 接在业务节点之后');
    }
  }
  return issues;
}

export function validateGraph(dsl: DSL, tools: ToolRecord[]): string[] {
  return validateGraphDetailed(dsl, tools).map((i) => i.message);
}

export function validateFlowDetailed(dsl: unknown, tools: ToolRecord[]): ValidationIssue[] {
  const schemaIssues = validateDslSchema(dsl);
  if (schemaIssues.length) return schemaIssues.map((message) => ({ level: 'error' as const, message }));
  return validateGraphDetailed(dsl as DSL, tools);
}

export function validateFlow(dsl: unknown, tools: ToolRecord[]): string[] {
  return validateFlowDetailed(dsl, tools).map((i) => i.message);
}