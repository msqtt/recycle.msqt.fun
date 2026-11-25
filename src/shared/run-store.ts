import { create } from 'zustand';
import { db, loadSettings, applyRetention } from '../db';
import type { FlowRecord, NodeState, LogEntry, RunStatus, RunRecord, ToolRecord } from '../db/types';
import { runFlow, type RunHandle, type EngineEvent, type RunOptions } from '../features/engine/engine';
import type { FlowBundle } from '../features/bundle';
import { getHost } from '../wtop/hostClient';

export interface NodeIO { input?: unknown; output?: unknown }

const eventListeners = new Set<(ev: EngineEvent) => void>();
const eventBuffer: EngineEvent[] = [];

/** automation bridge / devtools 订阅引擎事件流 */
export function subscribeEngineEvents(cb: (ev: EngineEvent) => void): () => void {
  eventListeners.add(cb);
  return () => eventListeners.delete(cb);
}

/** 订阅晚于启动时回放已发生事件（CLI 拿 runId 后才能订阅） */
export function replayEngineEvents(runId: string, cb: (ev: EngineEvent) => void): void {
  for (const ev of eventBuffer) if (ev.runId === runId) cb(ev);
}

interface RunStore {
  runId: string | null;
  flowId: string | null;
  flowName: string;
  status: RunStatus | null;
  mode: 'run' | 'step';
  nodeStates: Record<string, NodeState>;
  nodeIO: Record<string, NodeIO>;
  pausedNodeId: string | null;
  inputRequest: { nodeId: string; schema?: unknown; prompt?: string } | null;
  logs: LogEntry[];
  output: unknown;
  error?: { nodeId: string; code: string; message: string };
  handle: RunHandle | null;
  start(flow: FlowRecord, input: unknown, opts?: RunOptions): Promise<string>;
  startBundle(bundle: FlowBundle, input: unknown, opts?: RunOptions, secrets?: Record<string, string>): Promise<string>;
  cancel(): void;
  resolveApproval(nodeId: string, approved: boolean): void;
  resolveInput(nodeId: string, value: unknown): void;
  step(): void;
  resume(): void;
  runToEnd(): void;
  pause(): void;
}

/** 运行产物落 blobs 表，context 快照只存元数据 + blobId */
async function persistRun(
  runId: string, flow: FlowRecord, status: RunStatus, startedAt: number,
  nodeStates: Record<string, NodeState>, logs: LogEntry[],
  context: unknown, output: unknown, error?: RunRecord['error'], mode?: 'run' | 'step',
): Promise<void> {
  const blobIds: string[] = [];
  const snapshot = async (v: unknown, nodeId: string): Promise<unknown> => {
    if (v instanceof Blob) {
      const id = crypto.randomUUID();
      await db.blobs.put({
        id, runId, nodeId, name: (v as File).name ?? 'blob',
        mime: v.type || 'application/octet-stream', size: v.size, data: v,
      });
      blobIds.push(id);
      return { $blob: id, mime: v.type, size: v.size };
    }
    if (Array.isArray(v)) return Promise.all(v.map((x) => snapshot(x, nodeId)));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = await snapshot(x, nodeId);
      return out;
    }
    return v;
  };
  const ctx = context as { nodes?: Record<string, { output: unknown }> };
  const contextMeta: Record<string, unknown> = {};
  for (const [nid, rec] of Object.entries(ctx.nodes ?? {})) {
    contextMeta[nid] = await snapshot(rec.output, nid);
  }
  const outMeta = await snapshot(output, 'end');
  const rec: RunRecord = {
    id: runId, flowId: flow.id, flowVersion: flow.version, status, mode,
    startedAt, endedAt: Date.now(),
    nodeStates, contextMeta, output: outMeta, error,
    logs: logs.slice(-500),
  };
  await db.runs.put(rec);
  await applyRetention(await loadSettings());
}

export const useRunStore = create<RunStore>((set, get) => {
  const begin = async (
    flow: FlowRecord, input: unknown, opts?: RunOptions,
    overrideTools?: ToolRecord[], overrideEnv?: Record<string, string>,
    secretOverrides?: Record<string, string>,
  ): Promise<string> => {
    const [host, dbTools, flows, secrets, settings] = await Promise.all([
      getHost(overrideTools ?? []), db.tools.toArray(), db.flows.toArray(), db.secrets.toArray(), loadSettings(),
    ]);
    const tools = overrideTools ?? dbTools;
    const env = overrideEnv ?? settings.env;
    const flowMap = new Map(flows.map((f) => [f.id, f.dsl]));
    const toolMap = new Map(tools.map((t) => [t.id, t]));
    const logs: LogEntry[] = [];
    const startedAt = Date.now();

    const emit = (ev: EngineEvent) => {
      eventBuffer.push(ev);
      if (eventBuffer.length > 1000) eventBuffer.splice(0, eventBuffer.length - 1000);
      for (const cb of eventListeners) cb(ev);
      switch (ev.type) {
        case 'run:state':
          set({ status: ev.status });
          break;
        case 'node:state':
          set((s) => ({ nodeStates: { ...s.nodeStates, [ev.nodeId]: ev.state } }));
          break;
        case 'node:progress':
          set((s) => ({
            nodeStates: {
              ...s.nodeStates,
              [ev.nodeId]: { ...s.nodeStates[ev.nodeId], percent: ev.percent, text: ev.text },
            },
          }));
          break;
        case 'node:log': {
          const entry: LogEntry = { at: Date.now(), nodeId: ev.nodeId, level: ev.level, message: ev.message };
          logs.push(entry);
          set((s) => ({ logs: [...s.logs.slice(-499), entry] }));
          break;
        }
        case 'node:waiting-human':
          set((s) => ({
            nodeStates: {
              ...s.nodeStates,
              [ev.nodeId]: { ...s.nodeStates[ev.nodeId], status: 'waiting-human', text: ev.reason },
            },
          }));
          break;
        case 'node:input-required':
          set({ inputRequest: { nodeId: ev.nodeId, schema: ev.schema, prompt: ev.prompt } });
          break;
        case 'node:paused':
          set({ pausedNodeId: ev.nodeId });
          break;
        case 'node:input':
          set((s) => ({ nodeIO: { ...s.nodeIO, [ev.nodeId]: { ...s.nodeIO[ev.nodeId], input: ev.params } } }));
          break;
        case 'node:output':
          set((s) => ({
            nodeIO: { ...s.nodeIO, [ev.nodeId]: { ...s.nodeIO[ev.nodeId], output: ev.output } },
            pausedNodeId: s.pausedNodeId === ev.nodeId ? null : s.pausedNodeId,
          }));
          break;
        case 'run:finished':
          set({ status: ev.status, output: ev.output, error: ev.error, pausedNodeId: null, inputRequest: null });
          break;
        default:
          break;
      }
    };

    set({
      runId: null, flowId: flow.id, flowName: flow.name, status: 'running', mode: opts?.mode ?? 'run',
      nodeStates: {}, nodeIO: {}, pausedNodeId: null, inputRequest: null,
      logs: [], output: undefined, error: undefined, handle: null,
    });

    const handle = runFlow(flow.dsl, input, {
      host,
      getTool: (id) => toolMap.get(id),
      getFlow: (id) => flowMap.get(id),
      getSecret: (toolId, name) => secretOverrides?.[`${toolId}.${name}`]
        ?? secrets.find((s) => s.toolId === toolId && s.name === name)?.value,
      env,
      httpConcurrency: settings.httpConcurrency,
      emit,
    }, opts);

    set({ runId: handle.id, handle });

    void handle.done.then(async (r) => {
      await persistRun(handle.id, flow, r.status, startedAt, r.nodeStates, logs, r.context, r.output, r.error, opts?.mode ?? 'run');
      set({ handle: null });
    });
    return handle.id;
  };

  return {
    runId: null, flowId: null, flowName: '', status: null, mode: 'run',
    nodeStates: {}, nodeIO: {}, pausedNodeId: null, inputRequest: null,
    logs: [], output: undefined, error: undefined, handle: null,

    start: (flow, input, opts) => begin(flow, input, opts),

    startBundle: (bundle, input, opts, secrets) => begin({
      id: bundle.flow.id, name: bundle.flow.name, version: bundle.flow.version,
      dsl: bundle.flow, createdAt: 0, updatedAt: 0,
    }, input, opts, bundle.tools, bundle.env, secrets),

    cancel() { get().handle?.cancel(); },
    resolveApproval(nodeId, approved) { get().handle?.resolveApproval(nodeId, approved); },
    resolveInput(nodeId, value) {
      get().handle?.resolveInput(nodeId, value);
      set({ inputRequest: null });
    },
    step() { get().handle?.step(); },
    resume() { set({ mode: 'run' }); get().handle?.resume(); },
    runToEnd() {
      get().handle?.setBreakpoints([]);
      set({ mode: 'run' });
      get().handle?.resume();
    },
    pause() { set({ mode: 'step' }); get().handle?.pause(); },
  };
});