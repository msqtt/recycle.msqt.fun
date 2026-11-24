import { create } from 'zustand';
import { db, loadSettings, applyRetention } from '../db';
import type { FlowRecord, NodeState, LogEntry, RunStatus, RunRecord } from '../db/types';
import { runFlow, type RunHandle, type EngineEvent } from '../features/engine/engine';
import { getHost } from '../wtop/hostClient';

interface RunStore {
  runId: string | null;
  flowId: string | null;
  flowName: string;
  status: RunStatus | null;
  nodeStates: Record<string, NodeState>;
  logs: LogEntry[];
  output: unknown;
  error?: { nodeId: string; code: string; message: string };
  handle: RunHandle | null;
  start(flow: FlowRecord, input: unknown): Promise<string>;
  cancel(): void;
  resolveApproval(nodeId: string, approved: boolean): void;
}

/** 运行产物落 blobs 表，context 快照只存元数据 + blobId */
async function persistRun(
  runId: string, flow: FlowRecord, status: RunStatus, startedAt: number,
  nodeStates: Record<string, NodeState>, logs: LogEntry[],
  context: unknown, output: unknown, error?: RunRecord['error'],
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
    id: runId, flowId: flow.id, flowVersion: flow.version, status,
    startedAt, endedAt: Date.now(),
    nodeStates, contextMeta, output: outMeta, error,
    logs: logs.slice(-500),
  };
  await db.runs.put(rec);
  await applyRetention(await loadSettings());
}

export const useRunStore = create<RunStore>((set, get) => ({
  runId: null, flowId: null, flowName: '', status: null,
  nodeStates: {}, logs: [], output: undefined, error: undefined, handle: null,

  async start(flow, input) {
    const [host, tools, flows, secrets, settings] = await Promise.all([
      getHost(), db.tools.toArray(), db.flows.toArray(), db.secrets.toArray(), loadSettings(),
    ]);
    const flowMap = new Map(flows.map((f) => [f.id, f.dsl]));
    const toolMap = new Map(tools.map((t) => [t.id, t]));
    const logs: LogEntry[] = [];
    const startedAt = Date.now();

    const emit = (ev: EngineEvent) => {
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
        case 'run:finished':
          set({ status: ev.status, output: ev.output, error: ev.error });
          break;
        default:
          break;
      }
    };

    set({
      runId: null, flowId: flow.id, flowName: flow.name, status: 'running',
      nodeStates: {}, logs: [], output: undefined, error: undefined, handle: null,
    });

    const handle = runFlow(flow.dsl, input, {
      host,
      getTool: (id) => toolMap.get(id),
      getFlow: (id) => flowMap.get(id),
      getSecret: (toolId, name) => secrets.find((s) => s.toolId === toolId && s.name === name)?.value,
      env: settings.env,
      httpConcurrency: settings.httpConcurrency,
      emit,
    });

    set({ runId: handle.id, handle });

    void handle.done.then(async (r) => {
      await persistRun(handle.id, flow, r.status, startedAt, r.nodeStates, logs, r.context, r.output, r.error);
      set({ handle: null });
    });
    return handle.id;
  },

  cancel() { get().handle?.cancel(); },
  resolveApproval(nodeId, approved) { get().handle?.resolveApproval(nodeId, approved); },
}));