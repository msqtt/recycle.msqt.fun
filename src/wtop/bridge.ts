import { db } from '../db';
import type { RunOptions, EngineEvent } from '../features/engine/engine';
import { buildBundle, isBundle, type FlowBundle } from '../features/bundle';
import { useRunStore, subscribeEngineEvents, replayEngineEvents, type NodeIO } from '../shared/run-store';

export interface BridgeRunOptions extends RunOptions {
  /** CLI --secret 注入：key 为 `toolId.name`，不落库 */
  secrets?: Record<string, string>;
}

export interface RunSnapshot {
  status: string | null;
  mode: 'run' | 'step';
  pausedNodeId: string | null;
  nodeStates: Record<string, unknown>;
  nodeIO: Record<string, NodeIO>;
  output: unknown;
  error?: { nodeId: string; code: string; message: string };
  inputRequest: { nodeId: string; schema?: unknown; prompt?: string } | null;
}

export interface WtopHostBridge {
  version: 1;
  listFlows(): Promise<{ id: string; name: string; version: number }[]>;
  exportBundle(flowId: string): Promise<FlowBundle>;
  runBundle(bundle: FlowBundle, input: unknown, opts?: BridgeRunOptions): Promise<string>;
  runFlowById(flowId: string, input: unknown, opts?: RunOptions): Promise<string>;
  getRun(runId: string): Promise<RunSnapshot>;
  control(runId: string, action: 'step' | 'resume' | 'pause' | 'cancel' | 'runToEnd'): Promise<void>;
  resolveInput(runId: string, nodeId: string, value: unknown): Promise<void>;
  resolveApproval(runId: string, nodeId: string, approved: boolean): Promise<void>;
  subscribe(runId: string, cb: (ev: EngineEvent) => void): () => void;
}

declare global {
  interface Window { wtopHost?: WtopHostBridge }
}

function requireLive(runId: string) {
  const s = useRunStore.getState();
  if (s.runId !== runId || !s.handle) throw new Error(`run 不在运行中: ${runId}`);
  return s;
}

/** Blob 不可跨 evaluate/exposeFunction 序列化 → 转元数据 */
function serializeSafe(v: unknown): unknown {
  if (v instanceof Blob) {
    return { $blobMeta: { name: (v as File).name ?? 'blob', size: v.size, mime: v.type } };
  }
  if (Array.isArray(v)) return v.map(serializeSafe);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, serializeSafe(x)]));
  }
  return v;
}

/** 同源自动化 API（CLI/控制台用）；不开放跨域入口 */
export function installBridge(): void {
  const bridge: WtopHostBridge = {
    version: 1,

    async listFlows() {
      const flows = await db.flows.toArray();
      return flows.map((f) => ({ id: f.id, name: f.name, version: f.version }));
    },

    async exportBundle(flowId) {
      const flow = await db.flows.get(flowId);
      if (!flow) throw new Error(`流程不存在: ${flowId}`);
      return buildBundle(flow);
    },

    async runBundle(bundle, input, opts) {
      if (!isBundle(bundle)) throw new Error('非法 Flow Bundle（需要 bundleVersion: 1）');
      const { secrets, ...runOpts } = opts ?? {};
      return useRunStore.getState().startBundle(bundle, input, runOpts, secrets);
    },

    async runFlowById(flowId, input, opts) {
      const flow = await db.flows.get(flowId);
      if (!flow) throw new Error(`流程不存在: ${flowId}`);
      return useRunStore.getState().start(flow, input, opts);
    },

    async getRun(runId) {
      const s = useRunStore.getState();
      if (s.runId === runId) {
        return {
          status: s.status, mode: s.mode, pausedNodeId: s.pausedNodeId,
          nodeStates: s.nodeStates, nodeIO: serializeSafe(s.nodeIO) as Record<string, NodeIO>,
          output: serializeSafe(s.output), error: s.error,
          inputRequest: s.inputRequest,
        };
      }
      const rec = await db.runs.get(runId);
      if (!rec) throw new Error(`run 不存在: ${runId}`);
      return {
        status: rec.status, mode: rec.mode ?? 'run', pausedNodeId: null,
        nodeStates: rec.nodeStates,
        nodeIO: Object.fromEntries(Object.entries((rec.contextMeta ?? {}) as Record<string, unknown>).map(([k, v]) => [k, { output: v }])),
        output: rec.output, error: rec.error, inputRequest: null,
      };
    },

    async control(runId, action) {
      const s = requireLive(runId);
      if (action === 'step') s.step();
      else if (action === 'resume') s.resume();
      else if (action === 'pause') s.pause();
      else if (action === 'runToEnd') s.runToEnd();
      else s.cancel();
    },

    async resolveInput(runId, nodeId, value) {
      requireLive(runId).resolveInput(nodeId, value);
    },

    async resolveApproval(runId, nodeId, approved) {
      requireLive(runId).resolveApproval(nodeId, approved);
    },

    subscribe(runId, cb) {
      const safe = (ev: EngineEvent) => cb(serializeSafe(ev) as EngineEvent);
      replayEngineEvents(runId, safe);
      return subscribeEngineEvents((ev) => { if (ev.runId === runId) safe(ev); });
    },
  };
  window.wtopHost = bridge;
}