import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db';
import type { NodeState, LogEntry, RunStatus, BlobRecord } from '../../db/types';
import { useRunStore } from '../../shared/run-store';
import { getHost } from '../../wtop/hostClient';
import { NeoButton, NeoBadge, PageTitle } from '../../shared/ui';

const STATUS_LABEL: Record<string, string> = {
  running: '运行中', 'paused-human': '等待人工', succeeded: '成功', failed: '失败', cancelled: '已取消',
  pending: '待执行', ready: '就绪', 'waiting-human': '等待人工', skipped: '已跳过',
};

function OutputView({ value, blobs }: { value: unknown; blobs: BlobRecord[] }) {
  if (value !== null && typeof value === 'object' && '$blob' in (value as object)) {
    const id = (value as { $blob: string }).$blob;
    const b = blobs.find((x) => x.id === id);
    return (
      <button
        className="border-2 border-ink bg-sky px-2 py-0.5 text-xs font-bold shadow-neo-sm hover:shadow-none"
        onClick={() => {
          if (!b) return;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(b.data);
          a.download = b.name;
          a.click();
          URL.revokeObjectURL(a.href);
        }}
      >
        ⬇ {b?.name ?? id}（{b ? `${(b.size / 1024).toFixed(1)}KB` : '已清理'}）
      </button>
    );
  }
  if (Array.isArray(value)) {
    return <span>[{value.map((v, i) => <span key={i} className="inline-block mr-1"><OutputView value={v} blobs={blobs} />{i < value.length - 1 ? ',' : ''}</span>)}]</span>;
  }
  if (value !== null && typeof value === 'object') {
    return (
      <span>{'{'}{Object.entries(value).map(([k, v], i, arr) => (
        <span key={k} className="inline-block mr-1">
          <span className="font-bold">{k}:</span> <OutputView value={v} blobs={blobs} />{i < arr.length - 1 ? ',' : ''}
        </span>
      ))}{'}'}</span>
    );
  }
  return <span className="font-mono text-xs">{JSON.stringify(value)}</span>;
}

function NodeCard({ nodeId, state, live, flowNodes, blobs, onView, onApprove }: {
  nodeId: string; state: NodeState; live: boolean;
  flowNodes: { id: string; type: string; prompt?: string }[];
  blobs: BlobRecord[];
  onView: (callId: string) => void;
  onApprove: (nodeId: string, ok: boolean) => void;
}) {
  const node = flowNodes.find((n) => n.id === nodeId);
  const isApproval = node?.type === 'approval';
  const canView = live && state.callId && ['running', 'waiting-human', 'failed'].includes(state.status);
  return (
    <div className="border-2 border-ink bg-white shadow-neo-sm p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono font-bold">{nodeId}</span>
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
      {!live && state.blobIds && state.blobIds.length > 0 && (
        <div className="mt-2 flex gap-1 flex-wrap">
          {state.blobIds.map((id) => <OutputView key={id} value={{ $blob: id }} blobs={blobs} />)}
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

  const status: RunStatus | null = live ? store.status : record?.status ?? null;
  const nodeStates: Record<string, NodeState> = live ? store.nodeStates : record?.nodeStates ?? {};
  const logs = live ? store.logs : record?.logs ?? [];
  const output = live ? store.output : record?.output;
  const error = live ? store.error : record?.error;
  const flowNodes = flow?.dsl.nodes ?? [];
  const orderedIds = flowNodes.length
    ? flowNodes.map((n) => n.id).filter((id) => id in nodeStates || live)
    : Object.keys(nodeStates);

  if (!live && !record) return <p className="font-mono p-6">加载中…</p>;

  return (
    <div className="p-6 max-w-4xl mx-auto" style={{ marginRight: viewCallId ? 500 : undefined }}>
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <PageTitle sub={runId}>{live ? store.flowName : flow?.name ?? '运行'}</PageTitle>
        <div className="flex-1" />
        {status && <span data-run-status={status}><NeoBadge tone={status}>{STATUS_LABEL[status] ?? status}</NeoBadge></span>}
        {live && (status === 'running' || status === 'paused-human') && (
          <NeoButton color="bg-punch" onClick={() => store.cancel()}>■ 取消运行</NeoButton>
        )}
        <Link to="/history" className="font-bold text-sm underline">历史 →</Link>
      </div>

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
            onView={setViewCallId}
            onApprove={(nid, ok) => store.resolveApproval(nid, ok)}
          />
        ))}
      </div>

      {(status === 'succeeded' || (!live && output !== undefined)) && (
        <div className="border-2 border-ink bg-lime shadow-neo p-3 mb-6">
          <p className="font-black uppercase text-sm mb-2">输出</p>
          <div className="text-sm break-all"><OutputView value={output} blobs={blobs} /></div>
        </div>
      )}

      <p className="font-black uppercase text-sm mb-2">日志</p>
      <LogPanel logs={logs} />

      {viewCallId && <ViewDrawer callId={viewCallId} onClose={() => setViewCallId(null)} />}
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