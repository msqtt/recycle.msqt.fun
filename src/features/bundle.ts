import type { DSL, FlowNode } from './engine/dsl';
import type { FlowRecord, ToolRecord } from '../db/types';
import { db, loadSettings } from '../db';

export interface FlowBundle {
  bundleVersion: 1;
  flow: DSL;
  tools: ToolRecord[];
  env: Record<string, string>;
}

function collectToolIds(nodes: FlowNode[], into: Set<string>): void {
  for (const n of nodes) {
    if (n.toolId) into.add(n.toolId);
    if (n.subGraph) collectToolIds(n.subGraph.nodes, into);
  }
}

/** 导出自包含运行包；secrets 一律不进 bundle */
export async function buildBundle(flow: FlowRecord): Promise<FlowBundle> {
  const ids = new Set<string>();
  collectToolIds(flow.dsl.nodes, ids);
  const allTools = await db.tools.toArray();
  const settings = await loadSettings();
  return {
    bundleVersion: 1,
    flow: flow.dsl,
    tools: allTools.filter((t) => ids.has(t.id)),
    env: settings.env,
  };
}

export function isBundle(v: unknown): v is FlowBundle {
  return v !== null && typeof v === 'object' && (v as FlowBundle).bundleVersion === 1
    && !!(v as FlowBundle).flow && Array.isArray((v as FlowBundle).tools);
}

export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}