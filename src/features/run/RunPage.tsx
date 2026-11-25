import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db';
import type { NodeState, LogEntry, RunStatus, BlobRecord } from '../../db/types';
import type { FlowNode } from '../engine/dsl';
import type { JSONSchema } from '@wtop/types';
import { useRunStore, type NodeIO } from '../../shared/run-store';
import { getHost } from '../../wtop/hostClient';
import { NeoButton, NeoBadge, NeoModal, PageTitle } from '../../shared/ui';
import { SchemaForm, schemaDefaults } from '../../shared/schema-form';
import { OutputRenderer } from '../../shared/output-view';

const STATUS_LABEL: Record<string, string> = {
  running: '运行中', 'paused-human': '等待人工', 'paused-step': '单步暂停', succeeded: '成功', failed: '失败', cancelled: '已取消',
  pending: '待执行', ready: '就绪', 'waiting-human': '等待人工', skipped: '已跳过',
};

function NodeCard({ nodeId, state, live, flowNodes, blobs, io, paused, onView, onApprove, onFillInput }: {
  nodeId: string; state: NodeState; live: boolean;
  flowNodes: FlowNode[];
  blobs: BlobRecord[];
  io?: NodeIO;
  paused?: boolean;
  onView: (callId: string) => void;
  onApprove: (nodeId: string, ok: boolean) => void;
  onFillInput: () => void;
}) {
  const node = flowNodes.find((n) => n.id === nodeId);
  const isApproval = node?.type === 'approval';
  const canView = live && state.callId && ['running', 'waiting-human', 'failed'].includes(state.status);
  return (
    <div className={`border-2 border-ink shadow-neo-sm p-3 ${paused ? 'bg-lemon' : 'bg-white'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        {paused && <span className="w-2.5 h-2.5 rounded-full bg-punch border border-ink" title="暂停于此节点" />}
        <span className="font-mono font-bold">{nodeId}</span>
        {node && <span className="text-[10px] uppercase opacity-60">{node.type}</span>}
        <NeoBadge tone={state.status}>{STATUS_LABEL[state.status] ?? state.status}</NeoBadge>
        {state.attempt > 1 && <span className="text-xs font-mono">第 {state.attempt} 次</span>}
        <div className="flex-1" />
        {canView && <NeoButton color="bg-sky" className="!px-2 !py-0.5 text-xs" onClick={() => onView(state.callId!)}>查看现场</NeoButton>}
      </div>
      {state.percent !== undefined && state.status === 'running' && (
        <div className="mt-2 border-2 border-ink h-4 bg-white">
          <div className="h-full bg-lime border-r-2 border-ink transition-all" style={{ width: `${Math.min(100, state.percent)}%` }} />
        </div>
      )}
      {state.text && <p className="text-xs font-mono mt-1 opacity-70">{state.text}</p>}
      {state.error && (
        <p className="text-xs font-mono mt-1 bg-punch/30 border-2 border-punch px-2 py-1">
          [{state.error.code}] {state.error.message}
        </p>
      )}
      {live && isApproval && state.status === 'waiting-human' && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-sm font-bold">{node?.prompt ?? '确认继续？'}</span>
          <NeoButton color="bg-lime" className="!px-3 !py-0.5" onClick={() => onApprove(nodeId, true)}>批准</NeoButton>
          <NeoButton color="bg-punch" className="!px-3 !py-0.5" onClick={() => onApprove(nodeId, false)}>拒绝</NeoButton>
        </div>
      )}
      {live && node?.type === 'input' && state.status === 'waiting-human' && (
        <div className="mt-2">
          <NeoButton color="bg-lemon" className="!px-3 !py-0.5" onClick={onFillInput}>✎ 填写输入</NeoButton>
        </div>
      )}
      {io?.input !== undefined && (
        <details className="mt-2">
          <summary className="text-xs font-bold cursor-pointer opacity-70">输入（已求值入参）</summary>
          <div className="mt-1"><OutputRenderer value={io.input} blobs={blobs} name={`${nodeId}-input`} /></div>
        </details>
      )}
      {io?.output !== undefined && (
        node?.type === 'output' ? (
          <div className="mt-2 border-t-2 border-ink/20 pt-2">
            <OutputRenderer
              value={io.output} blobs={blobs}
              format={node.format} title={node.title} filename={node.filename} mime={node.mime}
              name={`${nodeId}`}
            />
          </div>
        ) : (
          <details className="mt-2" open={paused}>
            <summary className="text-xs font-bold cursor-pointer opacity-70">输出</summary>
            <div className="mt-1"><OutputRenderer value={io.output} blobs={blobs} name={`${nodeId}-output`} /></div>
          </details>
        )
      )}
      {!live && state.blobIds && state.blobIds.length > 0 && (
        <div className="mt-2 flex gap-1 flex-wrap">
          {state.blobIds.map((id) => <OutputRenderer key={id} value={{ $blob: id }} blobs={blobs} name={nodeId} />)}
        </div>
      )}
    </div>
  );
}

function LogPanel({ logs }: { logs: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [logs.length]);
  return (
    <div ref={ref} className="border-2 border-ink bg-ink text-lime font-mono text-xs p-3 h-56 overflow-auto">
      {logs.length === 0 && <p className="opacity-50">暂无日志</p>}
      {logs.map((l, i) => (
        <p key={i} className={l.level === 'error' ? 'text-punch' : l.level === 'warn' ? 'text-tang' : ''}>
          <span className="opacity-50">{new Date(l.at).toLocaleTimeString()}</span>
          {l.nodeId ? ` [${l.nodeId}]` : ''} {l.message}
        </p>
      ))}
    </div>
  );
}

/** 右侧查看抽屉：把 iframe 定位到抽屉区域（固定层，不 reparent） */
function ViewDrawer({ callId, onClose }: { callId: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let host: Awaited<ReturnType<typeof getHost>> | null = null;
    const place = async () => {
      host = await getHost();
      const r = ref.current?.getBoundingClientRect();
      if (r) host.show(callId, { left: r.x, top: r.y, width: r.width, height: r.height });
    };
    void place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      void host?.hide(callId);
    };
  }, [callId]);
  return (
    <div className="fixed right-0 top-16 bottom-0 w-[480px] z-[900] border-l-2 border-ink bg-paper flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b-2 border-ink bg-lemon">
        <span className="font-bold text-sm uppercase">工具现场 · {callId.slice(0, 8)}</span>
        <NeoButton color="bg-white" className="!px-2 !py-0.5" onClick={onClose}>收起</NeoButton>
      </div>
      <div ref={ref} className="flex-1 m-2 border-2 border-dashed border-ink/40" />
    </div>
  );
}

function InputModal({ request, onSubmit, onCancel }: {
  request: { nodeId: string; schema?: unknown; prompt?: string };
  onSubmit: (value: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const schema = (request.schema ?? { type: 'object', properties: {} }) as JSONSchema;
  const [value, setValue] = useState<Record<string, unknown>>(() => schemaDefaults(schema));
  const [err, setErr] = useState('');
  const submit = () => {
    try { onSubmit(value); setErr(''); } catch (e) {
      const code = (e as { code?: string }).code;
      setErr(`${code ? `[${code}] ` : ''}${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <NeoModal title={`输入 · ${request.nodeId}`} onClose={onCancel}>
      {request.prompt && <p className="text-sm font-bold mb-3">{request.prompt}</p>}
      <SchemaForm schema={schema} value={value} onChange={setValue} allowBindings={false} />
      {err && <p className="text-xs font-mono bg-punch/30 border-2 border-punch px-2 py-1 mb-2">{err}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <NeoButton color="bg-white" onClick={onCancel}>稍后填写</NeoButton>
        <NeoButton color="bg-lime" onClick={submit}>提交</NeoButton>
      </div>
    </NeoModal>
  );
}

export function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const store = useRunStore();
  const live = store.runId === runId;
  const record = useLiveQuery(() => (runId && !live ? db.runs.get(runId) : undefined), [runId, live]);
  const blobs = useLiveQuery(() => (runId ? db.blobs.where('runId').equals(runId).toArray() : []), [runId]) ?? [];
  const flow = useLiveQuery(
    () => {
      const fid = live ? store.flowId : record?.flowId;
      return fid ? db.flows.get(fid) : undefined;
    },
    [live, store.flowId, record?.flowId],
  );
  const [viewCallId, setViewCallId] = useState<string | null>(null);
  const [inputHidden, setInputHidden] = useState(false);
  useEffect(() => { setInputHidden(false); }, [store.inputRequest?.nodeId]);

  const status: RunStatus | null = live ? store.status : record?.status ?? null;
  const nodeStates: Record<string, NodeState> = live ? store.nodeStates : record?.nodeStates ?? {};
  const logs = live ? store.logs : record?.logs ?? [];
  const output = live ? store.output : record?.output;
  const error = live ? store.error : record?.error;
  const mode = live ? store.mode : record?.mode;
  const nodeIO: Record<string, NodeIO> = live
    ? store.nodeIO
    : Object.fromEntries(Object.entries((record?.contextMeta ?? {}) as Record<string, unknown>).map(([k, v]) => [k, { output: v }]));
  const flowNodes = flow?.dsl.nodes ?? [];
  const orderedIds = flowNodes.length
    ? flowNodes.map((n) => n.id).filter((id) => id in nodeStates || live)
    : Object.keys(nodeStates);
  const flowName = live ? store.flowName : flow?.name ?? '运行';
  const stepActive = live && (status === 'running' || status === 'paused-step') && (store.mode === 'step' || status === 'paused-step');

  if (!live && !record) return <p className="font-mono p-6">加载中…</p>;

  return (
    <div className="p-6 max-w-4xl mx-auto" style={{ marginRight: viewCallId ? 500 : undefined }}>
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <PageTitle sub={runId}>{flowName}</PageTitle>
        <div className="flex-1" />
        {mode === 'step' && <NeoBadge tone="ok">试运行</NeoBadge>}
        {status && <span data-run-status={status}><NeoBadge tone={status}>{STATUS_LABEL[status] ?? status}</NeoBadge></span>}
        {live && (status === 'running' || status === 'paused-human' || status === 'paused-step') && (
          <NeoButton color="bg-punch" onClick={() => store.cancel()}>■ 取消运行</NeoButton>
        )}
        <Link to="/history" className="font-bold text-sm underline">历史 →</Link>
      </div>

      {stepActive && (
        <div className="border-2 border-ink bg-lemon shadow-neo p-2 mb-4 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-black uppercase">试运行控制</span>
          {store.pausedNodeId
            ? <span className="font-mono text-xs">暂停于 <b>{store.pausedNodeId}</b>（展开上游输出审查后放行）</span>
            : <span className="font-mono text-xs">运行中…</span>}
          <div className="flex-1" />
          <NeoButton color="bg-white" className="!px-2 !py-0.5 text-xs" disabled={status !== 'paused-step'} onClick={() => store.step()}>⏭ 单步</NeoButton>
          <NeoButton color="bg-sky" className="!px-2 !py-0.5 text-xs" disabled={status !== 'paused-step'} onClick={() => store.resume()}>▶ 继续</NeoButton>
          <NeoButton color="bg-lime" className="!px-2 !py-0.5 text-xs" onClick={() => store.runToEnd()}>⏩ 跑到底</NeoButton>
          {status === 'running' && store.mode === 'run' && (
            <NeoButton color="bg-white" className="!px-2 !py-0.5 text-xs" onClick={() => store.pause()}>⏸ 暂停</NeoButton>
          )}
        </div>
      )}

      {error && (
        <div className="border-2 border-ink bg-punch shadow-neo p-3 mb-4 font-mono text-sm">
          ✗ 节点 {error.nodeId} 失败：[{error.code}] {error.message}
        </div>
      )}

      <div className="space-y-3 mb-6">
        {orderedIds.map((id) => (
          <NodeCard
            key={id}
            nodeId={id}
            state={nodeStates[id] ?? { status: 'pending', attempt: 0 }}
            live={live}
            flowNodes={flowNodes}
            blobs={blobs}
            io={nodeIO[id]}
            paused={live && store.pausedNodeId === id}
            onView={setViewCallId}
            onApprove={(nid, ok) => store.resolveApproval(nid, ok)}
            onFillInput={() => setInputHidden(false)}
          />
        ))}
      </div>

      {output !== undefined && (
        <div className={`border-2 border-ink shadow-neo p-3 mb-6 ${status === 'succeeded' ? 'bg-lime' : 'bg-white'}`}>
          <p className="font-black uppercase text-sm mb-2">流程输出（end）</p>
          <OutputRenderer value={output} blobs={blobs} name={`${flowName}-end`} />
        </div>
      )}

      <p className="font-black uppercase text-sm mb-2">日志</p>
      <LogPanel logs={logs} />

      {viewCallId && <ViewDrawer callId={viewCallId} onClose={() => setViewCallId(null)} />}

      {live && store.inputRequest && !inputHidden && (
        <InputModal
          key={store.inputRequest.nodeId}
          request={store.inputRequest}
          onSubmit={(v) => store.resolveInput(store.inputRequest!.nodeId, v)}
          onCancel={() => setInputHidden(true)}
        />
      )}
    </div>
  );
}

export function HistoryPage() {
  const runs = useLiveQuery(() => db.runs.orderBy('startedAt').reverse().limit(200).toArray(), []) ?? [];
  const flows = useLiveQuery(() => db.flows.toArray(), []) ?? [];
  const nameOf = (id: string) => flows.find((f) => f.id === id)?.name ?? id;
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageTitle sub="运行历史（按保留策略自动清理）">历史</PageTitle>
      {runs.length === 0 && <p className="font-mono text-sm border-2 border-dashed border-ink p-6 text-center">暂无运行记录</p>}
      <div className="space-y-3">
        {runs.map((r) => (
          <Link key={r.id} to={`/run/${r.id}`} className="block border-2 border-ink bg-white shadow-neo-sm p-3 hover:bg-lemon/30">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-black">{nameOf(r.flowId)}</span>
              <NeoBadge tone={r.status}>{STATUS_LABEL[r.status] ?? r.status}</NeoBadge>
              {r.mode === 'step' && <NeoBadge tone="ok">试运行</NeoBadge>}
              <span className="font-mono text-xs opacity-60">v{r.flowVersion} · {new Date(r.startedAt).toLocaleString()}</span>
              <div className="flex-1" />
              {r.error && <span className="font-mono text-xs text-punch font-bold">[{r.error.code}]</span>}
              <NeoButton
                color="bg-punch"
                className="!px-2 !py-0.5 text-xs"
                onClick={async (e) => {
                  e.preventDefault();
                  if (!confirm('删除这条运行记录及其产物？')) return;
                  await db.runs.delete(r.id);
                  await db.blobs.where('runId').equals(r.id).delete();
                }}
              >删除</NeoButton>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}