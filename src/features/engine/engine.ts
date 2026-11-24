import { WtopError, type Progress, type WaitingHumanInfo } from '@wtop/types';
import { validateData } from '@wtop/core';
import type { DSL, FlowNode, FlowEdge } from './dsl';
import { evalExpression, evalMapping, type RunContext } from './expr';
import { callHttp, EngineError } from './http';
import type { ToolRecord, NodeState, RunStatus } from '../../db/types';

export interface CallLike {
  id: string;
  result: Promise<unknown>;
  cancel(reason?: 'user' | 'engine'): void;
}

export interface HostLike {
  execute(opts: {
    toolUrl: string; method: string; params: unknown;
    timeoutMs?: number; attempt?: number; preserveScene?: boolean; allowSameOrigin?: boolean;
    onProgress?: (p: Progress) => void;
    onWaitingHuman?: (info: WaitingHumanInfo) => void;
  }): CallLike;
}

export type EngineEvent =
  | { type: 'run:state'; runId: string; status: RunStatus }
  | { type: 'node:state'; runId: string; nodeId: string; state: NodeState }
  | { type: 'node:progress'; runId: string; nodeId: string; percent?: number; text?: string }
  | { type: 'node:waiting-human'; runId: string; nodeId: string; reason?: string; blocking: boolean }
  | { type: 'node:log'; runId: string; nodeId?: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'run:finished'; runId: string; status: RunStatus; output?: unknown; error?: { nodeId: string; code: string; message: string } };

export interface EngineDeps {
  host: HostLike;
  getTool(id: string): ToolRecord | undefined;
  getFlow(id: string): DSL | undefined;
  getSecret(toolId: string, name: string): string | undefined;
  env: Record<string, unknown>;
  fetcher?: typeof fetch;
  httpConcurrency?: number;
  emit(ev: EngineEvent): void;
}

export interface RunResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  output?: unknown;
  error?: { nodeId: string; code: string; message: string };
  nodeStates: Record<string, NodeState>;
  context: RunContext;
}

export interface RunHandle {
  id: string;
  cancel(): void;
  resolveApproval(nodeId: string, approved: boolean): void;
  done: Promise<RunResult>;
}

const errCode = (e: unknown): string =>
  (e as { code?: string }).code ?? 'BUSINESS_ERROR';
const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function runFlow(dsl: DSL, startInput: unknown, deps: EngineDeps): RunHandle {
  const runId = crypto.randomUUID();
  const controller = new AbortController();
  const approvals = new Map<string, (approved: boolean) => void>();
  const activeWtop = new Map<string, CallLike>();
  const nodeStates: Record<string, NodeState> = {};
  let waitingCount = 0;
  let cancelled = false;

  const emit = deps.emit;
  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, nodeId?: string) =>
    emit({ type: 'node:log', runId, nodeId, level, message });

  const setRunStatus = (status: RunStatus) => emit({ type: 'run:state', runId, status });

  const setState = (nodeId: string, patch: Partial<NodeState>) => {
    const prev = nodeStates[nodeId] ?? { status: 'pending', attempt: 0 };
    const next = { ...prev, ...patch };
    nodeStates[nodeId] = next;
    emit({ type: 'node:state', runId, nodeId, state: next });
  };

  const enterWaiting = (nodeId: string, reason: string | undefined, blocking: boolean) => {
    waitingCount++;
    setState(nodeId, { status: 'waiting-human' });
    emit({ type: 'node:waiting-human', runId, nodeId, reason, blocking });
    setRunStatus('paused-human');
  };
  const leaveWaiting = (nodeId: string) => {
    waitingCount = Math.max(0, waitingCount - 1);
    if (waitingCount === 0 && !cancelled) setRunStatus('running');
    setState(nodeId, { status: 'running' });
  };

  const httpLimit = deps.httpConcurrency ?? 6;
  let httpActive = 0;
  const httpWaiters: (() => void)[] = [];
  const acquireHttp = async () => {
    if (httpActive < httpLimit) { httpActive++; return; }
    await new Promise<void>((r) => httpWaiters.push(r));
    httpActive++;
  };
  const releaseHttp = () => {
    httpActive--;
    httpWaiters.shift()?.();
  };

  interface GraphScope {
    incoming: Map<string, FlowEdge[]>;
    activeEdges: Set<FlowEdge>;
  }

  async function execNode(node: FlowNode, attempt: number, ctx: RunContext, prefix: string, scope: GraphScope): Promise<unknown> {
    const nid = prefix + node.id;
    switch (node.type) {
      case 'start': {
        if (node.inputSchema && Object.keys(node.inputSchema).length) {
          const r = validateData(node.inputSchema, ctx.start.input);
          if (!r.valid) throw new WtopError('INVALID_INPUT', `流程输入不符合 schema: ${r.errors}`);
        }
        return ctx.start.input;
      }
      case 'end':
        return evalMapping(node.outputMapping ?? {}, ctx);
      case 'transform':
        return evalExpression(node.expression ?? '', ctx);
      case 'condition': {
        const v = await evalExpression(node.expression ?? '', ctx);
        return Boolean(v);
      }
      case 'switch': {
        for (const c of node.cases ?? []) {
          if (await evalExpression(c.expression, ctx)) return c.value;
        }
        return 'default';
      }
      case 'parallel':
        return null;
      case 'merge': {
        const inputs = scope.incoming.get(node.id) ?? [];
        const vals = inputs.filter((e) => scope.activeEdges.has(e)).map((e) => ctx.nodes[prefix + e.from]?.output);
        if (node.strategy === 'object') {
          return Object.fromEntries(inputs.filter((e) => scope.activeEdges.has(e)).map((e) => [e.from, ctx.nodes[prefix + e.from]?.output]));
        }
        if (node.strategy === 'first') return vals[0];
        return vals;
      }
      case 'call-wtop': {
        const tool = deps.getTool(node.toolId!);
        if (!tool?.manifest) throw new EngineError('INVALID_INPUT', `工具不存在: ${node.toolId}`);
        const params = await evalMapping(node.inputMapping ?? {}, ctx);
        const call = deps.host.execute({
          toolUrl: tool.url, method: node.method!, params,
          timeoutMs: node.timeoutMs, attempt,
          preserveScene: node.preserveScene ?? true,
          allowSameOrigin: tool.allowSameOrigin,
          onProgress: (p) => {
            setState(nid, { percent: p.percent, text: p.text });
            emit({ type: 'node:progress', runId, nodeId: nid, percent: p.percent, text: p.text });
          },
          onWaitingHuman: (info) => enterWaiting(nid, info.reason, info.blocking),
        });
        activeWtop.set(nid, call);
        setState(nid, { callId: call.id });
        try {
          const output = await call.result;
          if (nodeStates[nid]?.status === 'waiting-human') leaveWaiting(nid);
          return output;
        } catch (e) {
          if (nodeStates[nid]?.status === 'waiting-human') leaveWaiting(nid);
          throw e;
        } finally {
          activeWtop.delete(nid);
        }
      }
      case 'call-http': {
        const tool = deps.getTool(node.toolId!);
        const endpoint = tool?.http?.endpoints.find((e) => e.name === node.endpoint);
        if (!tool || !endpoint) throw new EngineError('INVALID_INPUT', `HTTP 工具/endpoint 不存在: ${node.toolId}/${node.endpoint}`);
        const params = await evalMapping(node.inputMapping ?? {}, ctx);
        await acquireHttp();
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        controller.signal.addEventListener('abort', onAbort);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; ac.abort(); }, node.timeoutMs ?? endpoint.timeoutMs ?? 60000);
        try {
          return await callHttp(tool, endpoint, params, {
            signal: ac.signal,
            timedOut: () => timedOut,
            fetcher: deps.fetcher,
            getSecret: (name) => deps.getSecret(tool.id, name),
          });
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', onAbort);
          releaseHttp();
        }
      }
      case 'approval': {
        enterWaiting(nid, node.prompt, true);
        const approved = await new Promise<boolean>((resolve) => {
          approvals.set(nid, resolve);
          controller.signal.addEventListener('abort', () => resolve(false), { once: true });
        });
        approvals.delete(nid);
        leaveWaiting(nid);
        if (!approved) throw new EngineError('CANCELLED', cancelled ? '运行被取消' : '人工拒绝');
        return { approved: true };
      }
      case 'loop': {
        const items = await evalExpression(node.itemsExpression ?? '', ctx);
        if (!Array.isArray(items)) throw new EngineError('INVALID_INPUT', 'loop itemsExpression 结果不是数组');
        const sub = node.subGraph!;
        const results: unknown[] = new Array(items.length);
        let cursor = 0;
        const worker = async () => {
          while (cursor < items.length && !cancelled) {
            const index = cursor++;
            const subCtx: RunContext = { ...ctx, loop: { item: items[index], index }, nodes: { ...ctx.nodes } };
            const r = await executeGraph(sub.nodes, sub.edges, subCtx, `${nid}.`, nodeStates);
            if (r.error) throw r.error.err;
            results[index] = r.endOutput;
          }
        };
        await Promise.all(Array.from({ length: Math.min(node.concurrency ?? 1, items.length) }, worker));
        return results;
      }
      case 'subflow': {
        const sub = deps.getFlow(node.flowId!);
        if (!sub) throw new EngineError('INVALID_INPUT', `子流程不存在: ${node.flowId}`);
        const input = await evalMapping(node.inputMapping ?? {}, ctx);
        const subCtx: RunContext = { start: { input }, nodes: {}, env: ctx.env };
        const r = await executeGraph(sub.nodes, sub.edges, subCtx, `${nid}.`, nodeStates);
        if (r.error) throw r.error.err;
        return r.endOutput;
      }
      default:
        throw new EngineError('INVALID_INPUT', `未知节点类型: ${node.type}`);
    }
  }

  async function execWithRetry(node: FlowNode, attempt: number, ctx: RunContext, prefix: string, scope: GraphScope): Promise<unknown> {
    const nid = prefix + node.id;
    setState(nid, { status: 'running', startedAt: Date.now(), attempt });
    try {
      return await execNode(node, attempt, ctx, prefix, scope);
    } catch (e) {
      const code = errCode(e);
      if (cancelled || code === 'CANCELLED') throw e;
      const retry = node.retry;
      if (retry && attempt < retry.max && (!retry.on || retry.on.includes(code))) {
        log('warn', `节点 ${nid} 失败（${code}），${retry.backoffMs ?? 500}ms 后重试 ${attempt + 1}/${retry.max}`, nid);
        await sleep(retry.backoffMs ?? 500);
        return execWithRetry(node, attempt + 1, ctx, prefix, scope);
      }
      throw e;
    }
  }

  // ---- 图调度（§16）----

  interface GraphResult {
    endOutput?: unknown;
    outputs: Record<string, unknown>;
    error?: { nodeId: string; err: unknown };
    cancelled?: boolean;
  }

  async function executeGraph(
    nodes: FlowNode[], edges: FlowEdge[], ctx: RunContext, prefix: string,
    states: Record<string, NodeState>,
  ): Promise<GraphResult> {
    const incoming = new Map<string, FlowEdge[]>();
    const outgoing = new Map<string, FlowEdge[]>();
    const activeEdges = new Set<FlowEdge>();
    const scope: GraphScope = { incoming, activeEdges };
    const resolved = new Set<FlowEdge>();
    const pendingIn = new Map<string, number>();
    const outputs: Record<string, unknown> = {};
    const ready: FlowNode[] = [];
    const active = new Map<string, Promise<{ id: string; ok: boolean; output?: unknown; err?: unknown }>>();
    let failure: { nodeId: string; err: unknown } | null = null;

    for (const n of nodes) {
      incoming.set(n.id, []); outgoing.set(n.id, []);
      states[prefix + n.id] = { status: 'pending', attempt: 0 };
      emit({ type: 'node:state', runId, nodeId: prefix + n.id, state: states[prefix + n.id] });
    }
    for (const e of edges) {
      incoming.get(e.to)?.push(e);
      outgoing.get(e.from)?.push(e);
    }
    for (const n of nodes) {
      pendingIn.set(n.id, incoming.get(n.id)!.length);
      if (pendingIn.get(n.id) === 0) ready.push(n);
    }

    const skipNode = (n: FlowNode) => {
      const nid = prefix + n.id;
      states[nid] = { ...states[nid], status: 'skipped', endedAt: Date.now() };
      emit({ type: 'node:state', runId, nodeId: nid, state: states[nid] });
      for (const e of outgoing.get(n.id) ?? []) resolveEdge(e, false);
    };

    const resolveEdge = (e: FlowEdge, active: boolean) => {
      if (resolved.has(e)) return;
      resolved.add(e);
      if (active) activeEdges.add(e);
      const left = (pendingIn.get(e.to) ?? 1) - 1;
      pendingIn.set(e.to, left);
      if (left === 0) {
        const target = nodes.find((n) => n.id === e.to)!;
        const anyActive = incoming.get(e.to)!.some((x) => activeEdges.has(x));
        if (anyActive) ready.push(target);
        else skipNode(target);
      }
    };

    const settle = (node: FlowNode, output: unknown, branchSel?: (e: FlowEdge) => boolean) => {
      const nid = prefix + node.id;
      outputs[node.id] = output;
      ctx.nodes[nid] = { output };
      // 子图内表达式用局部 id 引用（子图 ctx 是独立副本，不会污染外层）
      if (prefix) ctx.nodes[node.id] = { output };
      states[nid] = { ...states[nid], status: 'succeeded', endedAt: Date.now(), percent: 100 };
      emit({ type: 'node:state', runId, nodeId: nid, state: states[nid] });
      for (const e of outgoing.get(node.id) ?? []) {
        resolveEdge(e, branchSel ? branchSel(e) : true);
      }
    };

    while ((ready.length || active.size) && !failure) {
      while (ready.length && !cancelled) {
        const node = ready.shift()!;
        const nid = prefix + node.id;
        const p = execWithRetry(node, 0, ctx, prefix, scope).then(
          (output) => ({ id: node.id, ok: true, output }),
          (err) => ({ id: node.id, ok: false, err }),
        );
        active.set(nid, p);
      }
      if (!active.size) break;
      const settled = await Promise.race(active.values());
      active.delete(prefix + settled.id);
      const node = nodes.find((n) => n.id === settled.id)!;
      const nid = prefix + node.id;
      if (cancelled) {
        states[nid] = { ...states[nid], status: 'cancelled', endedAt: Date.now() };
        emit({ type: 'node:state', runId, nodeId: nid, state: states[nid] });
        continue;
      }
      if (settled.ok) {
        if (node.type === 'condition') {
          settle(node, settled.output, (e) => e.branch === String(settled.output));
        } else if (node.type === 'switch') {
          settle(node, settled.output, (e) => e.branch === settled.output);
        } else {
          settle(node, settled.output);
        }
      } else {
        const code = errCode(settled.err);
        states[nid] = {
          ...states[nid], status: 'failed', endedAt: Date.now(),
          error: { code, message: errMsg(settled.err) },
        };
        emit({ type: 'node:state', runId, nodeId: nid, state: states[nid] });
        log('error', `节点 ${nid} 失败: ${code} ${errMsg(settled.err)}`, nid);
        if (node.onError === 'skip') {
          outputs[node.id] = undefined;
          ctx.nodes[nid] = { output: undefined };
          for (const e of outgoing.get(node.id) ?? []) resolveEdge(e, true);
        } else if (node.onError === 'fallback' && (outgoing.get(node.id) ?? []).some((e) => e.branch === 'fallback')) {
          for (const e of outgoing.get(node.id) ?? []) resolveEdge(e, e.branch === 'fallback');
        } else {
          failure = { nodeId: nid, err: settled.err };
        }
      }
    }

    if (failure) {
      controller.abort();
      for (const call of activeWtop.values()) call.cancel('engine');
      await Promise.allSettled(active.values());
    }
    const endNode = nodes.find((n) => n.type === 'end');
    return {
      outputs,
      endOutput: endNode ? outputs[endNode.id] : undefined,
      error: failure ?? undefined,
      cancelled,
    };
  }

  const ctx: RunContext = { start: { input: startInput }, nodes: {}, env: deps.env };
  setRunStatus('running');
  log('info', `流程 ${dsl.name} 开始运行`);

  const done = (async (): Promise<RunResult> => {
    const r = await executeGraph(dsl.nodes, dsl.edges, ctx, '', nodeStates);
    let status: RunResult['status'];
    if (cancelled) status = 'cancelled';
    else if (r.error) status = 'failed';
    else status = 'succeeded';
    const error = r.error
      ? { nodeId: r.error.nodeId, code: errCode(r.error.err), message: errMsg(r.error.err) }
      : undefined;
    emit({ type: 'run:finished', runId, status, output: r.endOutput, error });
    return { status, output: r.endOutput, error, nodeStates, context: ctx };
  })();

  return {
    id: runId,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      log('warn', '运行被用户取消');
      controller.abort();
      for (const call of activeWtop.values()) call.cancel('user');
      for (const resolve of approvals.values()) resolve(false);
    },
    resolveApproval(nodeId, approved) {
      approvals.get(nodeId)?.(approved);
    },
    done,
  };
}