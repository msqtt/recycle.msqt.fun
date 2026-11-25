import { describe, expect, it } from 'vitest';
import { WtopError } from '@wtop/types';
import { runFlow, type EngineDeps, type EngineEvent, type HostLike } from '../src/features/engine/engine';
import type { DSL, FlowNode } from '../src/features/engine/dsl';
import type { ToolRecord, HttpEndpoint } from '../src/db/types';

type Handler = (params: Record<string, unknown>, attempt: number, opts: {
  onProgress?: (p: { percent?: number; text?: string }) => void;
  onWaitingHuman?: (i: { reason?: string; blocking: boolean }) => void;
}) => unknown;

function mockHost(script: Record<string, Handler>) {
  const calls: { method: string; params: unknown; attempt: number }[] = [];
  const host: HostLike = {
    execute(opts) {
      calls.push({ method: opts.method, params: opts.params, attempt: opts.attempt ?? 0 });
      let settle!: (v: unknown) => void;
      let fail!: (e: unknown) => void;
      const gate = new Promise<unknown>((res, rej) => { settle = res; fail = rej; });
      let settled = false;
      void (async () => {
        try {
          const h = script[opts.method];
          if (!h) throw new WtopError('METHOD_NOT_FOUND', opts.method);
          const v = await h(opts.params as Record<string, unknown>, opts.attempt ?? 0, opts);
          if (!settled) { settled = true; settle(v); }
        } catch (e) {
          if (!settled) { settled = true; fail(e); }
        }
      })();
      return {
        id: `call_${calls.length}`,
        result: gate,
        cancel() {
          if (!settled) { settled = true; fail(new WtopError('CANCELLED', 'cancelled')); }
        },
      };
    },
  };
  return { host, calls };
}

const wtopTool = (id: string): ToolRecord => ({
  id, type: 'wtop', url: `https://${id}.test`, displayName: id,
  manifest: { protocolVersion: '1.0', name: id, version: '1.0.0', methods: [] } as never,
  health: 'ok', origins: [], addedAt: 0, updatedAt: 0,
});

const httpTool = (id: string, endpoints: HttpEndpoint[]): ToolRecord => ({
  id, type: 'http', url: 'https://api.test', displayName: id,
  http: { endpoints }, health: 'ok', origins: [], addedAt: 0, updatedAt: 0,
});

function deps(over: Partial<EngineDeps> & { host: HostLike }): { deps: EngineDeps; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return {
    events,
    deps: {
      getTool: (id) => (id.startsWith('http') ? undefined : wtopTool(id)),
      getFlow: () => undefined,
      getSecret: () => undefined,
      env: {},
      emit: (e) => events.push(e),
      ...over,
    },
  };
}

const dsl = (nodes: FlowNode[], edges: DSL['edges']): DSL => ({ id: 'f', name: 'test', version: 1, nodes, edges });
const start = (props: Record<string, unknown> = {}, required: string[] = []): FlowNode =>
  ({ id: 'start', type: 'start', inputSchema: { type: 'object', properties: props, required } });
const end = (mapping: Record<string, unknown>): FlowNode => ({ id: 'end', type: 'end', outputMapping: mapping });
const t = (id: string, expression: string, extra: Partial<FlowNode> = {}): FlowNode =>
  ({ id, type: 'transform', expression, ...extra });

const lastState = (events: EngineEvent[], nodeId: string) =>
  [...events].reverse().find((e) => e.type === 'node:state' && e.nodeId === nodeId) as
    Extract<EngineEvent, { type: 'node:state' }> | undefined;

describe('引擎 E1–E15', () => {
  it('E1 线性流程 + 数据绑定', async () => {
    const { host } = mockHost({});
    const { deps: d } = deps({ host });
    const r = await runFlow(dsl(
      [start({ x: { type: 'number' } }), t('double', 'context.start.input.x * 2'), end({ out: '{{context.nodes.double.output}}' })],
      [{ from: 'start', to: 'double' }, { from: 'double', to: 'end' }],
    ), { x: 21 }, d).done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: 42 });
  });

  it('E2 并行分支 + merge(array)', async () => {
    const { host } = mockHost({});
    const { deps: d } = deps({ host });
    const r = await runFlow(dsl(
      [start(), t('a', '1'), t('b', '2'), { id: 'm', type: 'merge', strategy: 'array' }, end({ out: '{{context.nodes.m.output}}' })],
      [{ from: 'start', to: 'a' }, { from: 'start', to: 'b' }, { from: 'a', to: 'm' }, { from: 'b', to: 'm' }, { from: 'm', to: 'end' }],
    ), {}, d).done;
    expect(r.status).toBe('succeeded');
    expect((r.output as { out: number[] }).out.sort()).toEqual([1, 2]);
  });

  it('E3 condition 分支选择 + 死支跳过', async () => {
    const { host } = mockHost({});
    for (const [n, expected] of [[5, 'big'], [1, 'small']] as const) {
      const { deps: d, events } = deps({ host });
      const r = await runFlow(dsl(
        [start({ n: { type: 'number' } }),
          { id: 'c', type: 'condition', expression: 'context.start.input.n > 3' },
          t('big', '"big"'), t('small', '"small"'),
          { id: 'm', type: 'merge', strategy: 'first' }, end({ out: '{{context.nodes.m.output}}' })],
        [{ from: 'start', to: 'c' }, { from: 'c', to: 'big', branch: 'true' }, { from: 'c', to: 'small', branch: 'false' },
          { from: 'big', to: 'm' }, { from: 'small', to: 'm' }, { from: 'm', to: 'end' }],
      ), { n }, d).done;
      expect(r.status).toBe('succeeded');
      expect(r.output).toEqual({ out: expected });
      const skipped = expected === 'big' ? 'small' : 'big';
      expect(lastState(events, skipped)?.state.status).toBe('skipped');
    }
  });

  it('E4 switch 多分支 + default', async () => {
    const { host } = mockHost({});
    for (const [route, expected] of [['a', 'A'], ['b', 'B'], ['z', 'D']] as const) {
      const { deps: d } = deps({ host });
      const r = await runFlow(dsl(
        [start({ route: { type: 'string' } }),
          { id: 's', type: 'switch', cases: [
            { value: 'a', expression: 'context.start.input.route = "a"' },
            { value: 'b', expression: 'context.start.input.route = "b"' },
          ] },
          t('na', '"A"'), t('nb', '"B"'), t('nd', '"D"'),
          { id: 'm', type: 'merge', strategy: 'first' }, end({ out: '{{context.nodes.m.output}}' })],
        [{ from: 'start', to: 's' },
          { from: 's', to: 'na', branch: 'a' }, { from: 's', to: 'nb', branch: 'b' }, { from: 's', to: 'nd', branch: 'default' },
          { from: 'na', to: 'm' }, { from: 'nb', to: 'm' }, { from: 'nd', to: 'm' }, { from: 'm', to: 'end' }],
      ), { route }, d).done;
      expect(r.output).toEqual({ out: expected });
    }
  });

  it('E5 loop 并发迭代 + 子图上下文', async () => {
    const { host } = mockHost({});
    const { deps: d, events } = deps({ host });
    const r = await runFlow(dsl(
      [start({ list: { type: 'array' } }),
        { id: 'lp', type: 'loop', itemsExpression: 'context.start.input.list', concurrency: 2,
          subGraph: { nodes: [t('ten', 'context.loop.item * 10'), end({ v: '{{context.nodes.ten.output}}' })], edges: [{ from: 'ten', to: 'end' }] } },
        end({ out: '{{context.nodes.lp.output}}' })],
      [{ from: 'start', to: 'lp' }, { from: 'lp', to: 'end' }],
    ), { list: [1, 2, 3] }, d).done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: [{ v: 10 }, { v: 20 }, { v: 30 }] });
    expect(lastState(events, 'lp.ten')?.state.status).toBe('succeeded');
  });

  it('E6 重试后成功（新 attempt）+ progress 转发', async () => {
    const { host, calls } = mockHost({
      flaky: (_p, attempt, opts) => {
        opts.onProgress?.({ percent: 50, text: 'half' });
        if (attempt < 2) throw new WtopError('BUSINESS_ERROR', 'boom');
        return { ok: true };
      },
    });
    const { deps: d, events } = deps({ host });
    const r = await runFlow(dsl(
      [start(), { id: 'c', type: 'call-wtop', toolId: 'tool', method: 'flaky', inputMapping: {}, retry: { max: 2, backoffMs: 5 } },
        end({ out: '{{context.nodes.c.output}}' })],
      [{ from: 'start', to: 'c' }, { from: 'c', to: 'end' }],
    ), {}, d).done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: { ok: true } });
    expect(calls.map((c) => c.attempt)).toEqual([0, 1, 2]);
    expect(events.some((e) => e.type === 'node:progress' && e.percent === 50)).toBe(true);
  });

  it('E7 重试耗尽 → 失败终止', async () => {
    const { host } = mockHost({ bad: () => { throw new WtopError('BUSINESS_ERROR', 'always'); } });
    const { deps: d, events } = deps({ host });
    const r = await runFlow(dsl(
      [start(), { id: 'c', type: 'call-wtop', toolId: 'tool', method: 'bad', inputMapping: {}, retry: { max: 1, backoffMs: 1 } }, end({})],
      [{ from: 'start', to: 'c' }, { from: 'c', to: 'end' }],
    ), {}, d).done;
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('BUSINESS_ERROR');
    expect(lastState(events, 'c')?.state.attempt).toBe(1);
  });

  it('E8 onError=skip 失败跳过继续', async () => {
    const { host } = mockHost({ bad: () => { throw new WtopError('BUSINESS_ERROR', 'x'); } });
    const { deps: d, events } = deps({ host });
    const r = await runFlow(dsl(
      [start(), { id: 'c', type: 'call-wtop', toolId: 'tool', method: 'bad', inputMapping: {}, onError: 'skip' },
        t('after', '"continued"'), end({ out: '{{context.nodes.after.output}}' })],
      [{ from: 'start', to: 'c' }, { from: 'c', to: 'after' }, { from: 'after', to: 'end' }],
    ), {}, d).done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: 'continued' });
    expect(lastState(events, 'c')?.state.status).toBe('failed');
  });

  it('E9 onError=fallback 走备用边', async () => {
    const { host } = mockHost({ bad: () => { throw new WtopError('BUSINESS_ERROR', 'x'); } });
    const { deps: d, events } = deps({ host });
    const r = await runFlow(dsl(
      [start(), { id: 'c', type: 'call-wtop', toolId: 'tool', method: 'bad', inputMapping: {}, onError: 'fallback' },
        t('main', '"main"'), t('fb', '"fallback"'),
        { id: 'm', type: 'merge', strategy: 'first' }, end({ out: '{{context.nodes.m.output}}' })],
      [{ from: 'start', to: 'c' }, { from: 'c', to: 'main' }, { from: 'c', to: 'fb', branch: 'fallback' },
        { from: 'main', to: 'm' }, { from: 'fb', to: 'm' }, { from: 'm', to: 'end' }],
    ), {}, d).done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: 'fallback' });
    expect(lastState(events, 'main')?.state.status).toBe('skipped');
  });

  it('E10 取消运行 → cancelled', async () => {
    const { host } = mockHost({ hang: () => new Promise(() => {}) });
    const { deps: d } = deps({ host });
    const handle = runFlow(dsl(
      [start(), { id: 'c', type: 'call-wtop', toolId: 'tool', method: 'hang', inputMapping: {} }, end({})],
      [{ from: 'start', to: 'c' }, { from: 'c', to: 'end' }],
    ), {}, d);
    await new Promise((r) => setTimeout(r, 20));
    handle.cancel();
    const r = await handle.done;
    expect(r.status).toBe('cancelled');
  });

  it('E11 approval 批准/拒绝 + paused-human 状态', async () => {
    const { host } = mockHost({});
    for (const approve of [true, false]) {
      const { deps: d, events } = deps({ host });
      const handle = runFlow(dsl(
        [start(), { id: 'ap', type: 'approval', prompt: '继续？' }, end({ ok: true })],
        [{ from: 'start', to: 'ap' }, { from: 'ap', to: 'end' }],
      ), {}, d);
      await new Promise((r) => setTimeout(r, 20));
      expect(events.some((e) => e.type === 'run:state' && e.status === 'paused-human')).toBe(true);
      handle.resolveApproval('ap', approve);
      const r = await handle.done;
      expect(r.status).toBe(approve ? 'succeeded' : 'failed');
      if (!approve) expect(r.error?.code).toBe('CANCELLED');
    }
  });

  it('E11b WTOP requestHuman → 运行暂停/恢复', async () => {
    let release!: (v: unknown) => void;
    const { host } = mockHost({
      confirm: (_p, _a, opts) => {
        opts.onWaitingHuman?.({ reason: '请确认', blocking: true });
        return new Promise((res) => { release = res; });
      },
    });
    const { deps: d, events } = deps({ host });
    const handle = runFlow(dsl(
      [start(), { id: 'c', type: 'call-wtop', toolId: 'tool', method: 'confirm', inputMapping: {} }, end({ out: '{{context.nodes.c.output}}' })],
      [{ from: 'start', to: 'c' }, { from: 'c', to: 'end' }],
    ), {}, d);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.some((e) => e.type === 'run:state' && e.status === 'paused-human')).toBe(true);
    release({ confirmed: true });
    const r = await handle.done;
    expect(r.status).toBe('succeeded');
    expect(events.filter((e) => e.type === 'run:state').map((e) => e.status)).toContain('running');
  });

  it('E12 HTTP 节点：path/query/secret/错误映射', async () => {
    const { host } = mockHost({});
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      if (url.includes('/fail')) return new Response('nope', { status: 500, statusText: 'Server Error' });
      return new Response(JSON.stringify({ id: 7 }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const tool = httpTool('http_api', [{
      name: 'get', method: 'GET', path: '/users/{{uid}}',
      input: { type: 'object', properties: { uid: { type: 'string' }, q: { type: 'string', in: 'query' } } },
      headers: { Authorization: 'Bearer {{secret:token}}' },
    }, {
      name: 'fail', method: 'GET', path: '/fail', input: { type: 'object', properties: {} },
    }] as never);
    const { deps: d } = deps({
      host, fetcher,
      getTool: (id) => (id === 'http_api' ? tool : wtopTool(id)),
      getSecret: (_t, name) => (name === 'token' ? 's3cret' : undefined),
    });
    const r = await runFlow(dsl(
      [start(), { id: 'h', type: 'call-http', toolId: 'http_api', endpoint: 'get', inputMapping: { uid: 'u1', q: 'hi' } },
        end({ out: '{{context.nodes.h.output}}' })],
      [{ from: 'start', to: 'h' }, { from: 'h', to: 'end' }],
    ), {}, d).done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: { id: 7 } });
    expect(seen[0].url).toBe('https://api.test/users/u1?q=hi');
    expect((seen[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer s3cret');

    const r2 = await runFlow(dsl(
      [start(), { id: 'h', type: 'call-http', toolId: 'http_api', endpoint: 'fail', inputMapping: {} }, end({})],
      [{ from: 'start', to: 'h' }, { from: 'h', to: 'end' }],
    ), {}, d).done;
    expect(r2.status).toBe('failed');
    expect(r2.error?.code).toBe('HTTP_STATUS');

    const netFetcher = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const { deps: d3 } = deps({ host, fetcher: netFetcher, getTool: (id) => (id === 'http_api' ? tool : wtopTool(id)) });
    const r3 = await runFlow(dsl(
      [start(), { id: 'h', type: 'call-http', toolId: 'http_api', endpoint: 'get', inputMapping: { uid: 'u1' } }, end({})],
      [{ from: 'start', to: 'h' }, { from: 'h', to: 'end' }],
    ), {}, d3).done;
    expect(r3.error?.code).toBe('HTTP_NETWORK');
  });

  it('E13 表达式：插值 / env / 常量', async () => {
    const { host } = mockHost({});
    const { deps: d } = deps({ host, env: { base: 'https://x.test' } });
    const r = await runFlow(dsl(
      [start({ name: { type: 'string' } }),
        end({ greet: '你好 {{context.start.input.name}}', url: '{{context.env.base}}/a', n: 3 })],
      [{ from: 'start', to: 'end' }],
    ), { name: '世界' }, d).done;
    expect(r.output).toEqual({ greet: '你好 世界', url: 'https://x.test/a', n: 3 });
  });

  it('E14 subflow 子流程', async () => {
    const { host } = mockHost({});
    const sub = dsl(
      [start({ v: { type: 'number' } }), t('sq', 'context.start.input.v * context.start.input.v'), end({ r: '{{context.nodes.sq.output}}' })],
      [{ from: 'start', to: 'sq' }, { from: 'sq', to: 'end' }],
    );
    const { deps: d } = deps({ host, getFlow: (id) => (id === 'sub' ? sub : undefined) });
    const r = await runFlow(dsl(
      [start({ x: { type: 'number' } }),
        { id: 'sf', type: 'subflow', flowId: 'sub', inputMapping: { v: '{{context.start.input.x}}' } },
        end({ out: '{{context.nodes.sf.output}}' })],
      [{ from: 'start', to: 'sf' }, { from: 'sf', to: 'end' }],
    ), { x: 6 }, d).done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: { r: 36 } });
  });

  it('E15 流程输入 schema 校验失败', async () => {
    const { host } = mockHost({});
    const { deps: d } = deps({ host });
    const r = await runFlow(dsl(
      [start({ x: { type: 'number' } }, ['x']), end({})],
      [{ from: 'start', to: 'end' }],
    ), {}, d).done;
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('INVALID_INPUT');
    expect(r.error?.nodeId).toBe('start');
  });
});

describe('引擎 v2 E16–E25', () => {
  it('E16 const→transform→end + node:input/output 事件', async () => {
    const { host } = mockHost({ echo: (p) => p });
    const { deps: d, events } = deps({ host });
    const r = await runFlow(dsl(
      [start(), { id: 'k', type: 'const', value: { n: 7 } },
        { id: 'c', type: 'call-wtop', toolId: 'tool', method: 'echo', inputMapping: { v: '{{context.nodes.k.output.n}}' } },
        end({ out: '{{context.nodes.c.output.v}}' })],
      [{ from: 'start', to: 'k' }, { from: 'k', to: 'c' }, { from: 'c', to: 'end' }],
    ), {}, d).done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: 7 });
    const inputEv = events.find((e) => e.type === 'node:input' && e.nodeId === 'c');
    expect(inputEv && inputEv.type === 'node:input' && inputEv.params).toEqual({ v: 7 });
    const outEv = events.find((e) => e.type === 'node:output' && e.nodeId === 'k');
    expect(outEv && outEv.type === 'node:output' && outEv.output).toEqual({ n: 7 });
  });

  it('E17 input 节点：UI 提交 + schema 校验', async () => {
    const { host } = mockHost({});
    const { deps: d, events } = deps({ host });
    const handle = runFlow(dsl(
      [start(), { id: 'ask', type: 'input', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, prompt: '你的名字？' },
        end({ out: '{{context.nodes.ask.output.name}}' })],
      [{ from: 'start', to: 'ask' }, { from: 'ask', to: 'end' }],
    ), {}, d);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.some((e) => e.type === 'node:input-required' && e.nodeId === 'ask')).toBe(true);
    expect(events.some((e) => e.type === 'run:state' && e.status === 'paused-human')).toBe(true);
    expect(() => handle.resolveInput('ask', {})).toThrow();
    handle.resolveInput('ask', { name: 'bob' });
    const r = await handle.done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: 'bob' });
  });

  it('E18 input 节点：无头预置值直接通过', async () => {
    const { host } = mockHost({});
    const { deps: d, events } = deps({ host });
    const r = await runFlow(dsl(
      [start(), { id: 'ask', type: 'input', inputSchema: { type: 'object', properties: { n: { type: 'number' } } } },
        end({ out: '{{context.nodes.ask.output.n}}' })],
      [{ from: 'start', to: 'ask' }, { from: 'ask', to: 'end' }],
    ), {}, d, { runtimeInputs: { ask: { n: 42 } } }).done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: 42 });
    expect(events.some((e) => e.type === 'node:input-required')).toBe(false);
  });

  it('E19 input 节点：无头无预置 → INPUT_REQUIRED', async () => {
    const { host } = mockHost({});
    const { deps: d } = deps({ host });
    const r = await runFlow(dsl(
      [start(), { id: 'ask', type: 'input', inputSchema: { type: 'object', properties: {} } }, end({})],
      [{ from: 'start', to: 'ask' }, { from: 'ask', to: 'end' }],
    ), {}, d, { headless: true }).done;
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('INPUT_REQUIRED');
    expect(r.error?.nodeId).toBe('ask');
  });

  it('E20 output 节点透传 + 多 output 独立', async () => {
    const { host } = mockHost({});
    const { deps: d } = deps({ host });
    const r = await runFlow(dsl(
      [start({ s: { type: 'string' } }),
        { id: 'o1', type: 'output', value: '{{context.start.input.s}}', title: '预览' },
        { id: 'o2', type: 'output', value: '前缀-{{context.nodes.o1.output}}' },
        end({ out: '{{context.nodes.o2.output}}' })],
      [{ from: 'start', to: 'o1' }, { from: 'o1', to: 'o2' }, { from: 'o2', to: 'end' }],
    ), { s: 'hi' }, d).done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: '前缀-hi' });
    expect(r.context.nodes.o1.output).toBe('hi');
  });

  it('E21 start→end 直连旁路：end 先完成输出 {}', async () => {
    const { host } = mockHost({});
    const { deps: d } = deps({ host });
    const r = await runFlow(dsl(
      [start(), t('side', '"later"'), end({})],
      [{ from: 'start', to: 'end' }, { from: 'start', to: 'side' }],
    ), {}, d).done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({});
  });

  it('E22 step 模式逐节点暂停 + step() 放行', async () => {
    const { host } = mockHost({});
    const { deps: d, events } = deps({ host });
    const handle = runFlow(dsl(
      [start(), t('a', '1'), t('b', '2'), end({ out: '{{context.nodes.b.output}}' })],
      [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'end' }],
    ), {}, d, { mode: 'step' });
    const pausedSeq: string[] = [];
    const timer = setInterval(() => {
      const last = [...events].reverse().find((e) => e.type === 'node:paused');
      if (last && last.type === 'node:paused' && pausedSeq[pausedSeq.length - 1] !== last.nodeId) {
        pausedSeq.push(last.nodeId);
        handle.step();
      }
    }, 10);
    const r = await handle.done;
    clearInterval(timer);
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: 2 });
    expect(pausedSeq).toEqual(['start', 'a', 'b', 'end']);
    expect(events.some((e) => e.type === 'run:state' && e.status === 'paused-step')).toBe(true);
  });

  it('E23 断点命中仅暂停断点节点 + resume 跑到底', async () => {
    const { host } = mockHost({});
    const { deps: d, events } = deps({ host });
    const handle = runFlow(dsl(
      [start(), t('a', '1'), t('b', '2'), end({ out: '{{context.nodes.b.output}}' })],
      [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'end' }],
    ), {}, d, { breakpoints: ['b'] });
    await new Promise((r) => setTimeout(r, 30));
    const pausedEvents = events.filter((e) => e.type === 'node:paused');
    expect(pausedEvents.map((e) => e.type === 'node:paused' && e.nodeId)).toEqual(['b']);
    expect(events.some((e) => e.type === 'node:output' && e.nodeId === 'a')).toBe(true);
    handle.resume();
    const r = await handle.done;
    expect(r.status).toBe('succeeded');
    expect(r.output).toEqual({ out: 2 });
  });

  it('E24 pause/resume 切换', async () => {
    const { host } = mockHost({});
    const { deps: d, events } = deps({ host });
    const handle = runFlow(dsl(
      [start(), t('a', '1'), t('b', '2'), end({ out: '{{context.nodes.b.output}}' })],
      [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'end' }],
    ), {}, d);
    handle.pause();
    await new Promise((r) => setTimeout(r, 20));
    handle.step();
    await new Promise((r) => setTimeout(r, 20));
    handle.resume();
    const r = await handle.done;
    expect(r.status).toBe('succeeded');
    expect(events.some((e) => e.type === 'node:paused')).toBe(true);
  });

  it('E25 step 中取消 → cancelled', async () => {
    const { host } = mockHost({});
    const { deps: d } = deps({ host });
    const handle = runFlow(dsl(
      [start(), t('a', '1'), end({})],
      [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
    ), {}, d, { mode: 'step' });
    await new Promise((r) => setTimeout(r, 20));
    handle.cancel();
    const r = await handle.done;
    expect(r.status).toBe('cancelled');
  });
});