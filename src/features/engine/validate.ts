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

/** 图级校验（Host 设计 §14）：id 唯一 / 边端点 / 无环 / condition 分支 / 工具有效性 / 孤立节点 */
export function validateGraph(dsl: DSL, tools: ToolRecord[]): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const n of dsl.nodes) {
    if (ids.has(n.id)) issues.push(`节点 id 重复: ${n.id}`);
    ids.add(n.id);
  }
  if (!dsl.nodes.some((n) => n.type === 'start')) issues.push('缺少 start 节点');
  if (!dsl.nodes.some((n) => n.type === 'end')) issues.push('缺少 end 节点');
  for (const e of dsl.edges) {
    if (!ids.has(e.from)) issues.push(`边起点不存在: ${e.from}`);
    if (!ids.has(e.to)) issues.push(`边终点不存在: ${e.to}`);
  }
  if (hasCycle(dsl.nodes, dsl.edges)) issues.push('流程存在环（循环请用 loop 节点）');

  for (const n of dsl.nodes) {
    if (n.type === 'condition') {
      const branches = dsl.edges.filter((e) => e.from === n.id).map((e) => e.branch);
      if (!branches.includes('true') || !branches.includes('false')) {
        issues.push(`condition ${n.id} 需要 true/false 两条出边`);
      }
    }
    if (n.type === 'call-wtop' || n.type === 'call-http') {
      const tool = tools.find((t) => t.id === n.toolId);
      if (!tool) { issues.push(`节点 ${n.id} 的工具不存在: ${n.toolId}`); continue; }
      if (n.type === 'call-wtop') {
        if (tool.type !== 'wtop') issues.push(`节点 ${n.id} 需要 wtop 工具`);
        else if (!tool.manifest?.methods.some((m) => m.name === n.method)) {
          issues.push(`节点 ${n.id} 的方法不存在: ${n.method}`);
        }
      } else {
        if (tool.type !== 'http') issues.push(`节点 ${n.id} 需要 http 工具`);
        else if (!tool.http?.endpoints.some((e) => e.name === n.endpoint)) {
          issues.push(`节点 ${n.id} 的 endpoint 不存在: ${n.endpoint}`);
        }
      }
    }
    if (n.type === 'loop' && n.subGraph) {
      const sub = n.subGraph;
      if (hasCycle(sub.nodes, sub.edges)) issues.push(`loop ${n.id} 子图存在环`);
    }
    if (n.id !== 'start' && n.type !== 'start' && !dsl.edges.some((e) => e.to === n.id)) {
      issues.push(`孤立节点（无入边）: ${n.id}`);
    }
  }
  return issues;
}

export function validateFlow(dsl: unknown, tools: ToolRecord[]): string[] {
  const schemaIssues = validateDslSchema(dsl);
  if (schemaIssues.length) return schemaIssues;
  return validateGraph(dsl as DSL, tools);
}