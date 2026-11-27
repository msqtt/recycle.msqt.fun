import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position,
  applyNodeChanges, BaseEdge, EdgeLabelRenderer, getSmoothStepPath,
  type Node, type Edge, type NodeChange, type Connection, type NodeProps, type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db';
import type { FlowRecord, ToolRecord, NodeState } from '../../db/types';
import type { DSL, FlowNode, NodeType, FlowEdge } from '../engine/dsl';
import { migrateDsl } from '../engine/dsl';
import { validateFlowDetailed, type ValidationIssue } from '../engine/validate';
import { NeoButton, NeoBadge, NeoModal, NeoInput, Field } from '../../shared/ui';
import { SchemaForm, schemaDefaults } from '../../shared/schema-form';
import { ConfigPanel, useBindingOptions } from './ConfigPanel';
import { useRunStore } from '../../shared/run-store';
import { OutputRenderer } from '../../shared/output-view';
import { LogPanel, InputModal, ViewDrawer, PipelinePreview } from '../../shared/run-widgets';
import { CodeField } from '../../shared/code-field';
import { buildBundle, isBundle, downloadJson, type FlowBundle } from '../bundle';
import { SAMPLE_DESCRIPTIONS } from '../../wtop/samples';

const NODE_COLORS: Record<NodeType, string> = {
  start: '#B8F53D', end: '#B8F53D', 'call-wtop': '#7DD3FC', 'call-http': '#C4B5FD', http: '#C4B5FD',
  transform: '#FFDE59', condition: '#FFA94D', switch: '#FFA94D', loop: '#FFDE59',
  parallel: '#FFDE59', merge: '#FFDE59', approval: '#FF6B9D', subflow: '#7DD3FC',
  const: '#FFDE59', input: '#FF6B9D', output: '#B8F53D', function: '#C4B5FD',
};

const NODE_LABELS: Record<NodeType, string> = {
  start: '开始', end: '结束', 'call-wtop': 'WTOP 调用', 'call-http': 'HTTP 调用(旧)', http: 'HTTP',
  transform: '转换', condition: '条件', switch: '分支', loop: '循环',
  parallel: '并行', merge: '汇聚', approval: '人工确认', subflow: '子流程',
  const: '常量', input: '输入', output: '输出', function: '函数',
};

const STATE_LABEL: Record<string, string> = {
  pending: '待执行', running: '运行中', 'waiting-human': '等待人工', succeeded: '✓', failed: '✗', skipped: '跳过', cancelled: '取消',
};
const STATE_BADGE: Record<string, string> = {
  running: 'bg-sky', 'waiting-human': 'bg-lemon', succeeded: 'bg-lime', failed: 'bg-punch', skipped: 'bg-white opacity-60', cancelled: 'bg-white opacity-60',
};
const RUN_STATUS_LABEL: Record<string, string> = {
  running: '运行中', 'paused-human': '等待人工', 'paused-step': '暂停', succeeded: '成功', failed: '失败', cancelled: '已取消',
};

function summarize(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? '' : s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function NeoFlowNode({ data, selected }: NodeProps) {
  const n = data.node as FlowNode;
  const st = data.runState as NodeState | undefined;
  const outputSummary = data.outputSummary as string | undefined;
  return (
    <div
      className="border-2 border-ink px-3 py-2 min-w-[130px] font-bold text-sm relative"
      style={{
        background: NODE_COLORS[n.type],
        boxShadow: selected ? '6px 6px 0 #111' : '3px 3px 0 #111',
        opacity: st?.status === 'skipped' ? 0.55 : 1,
      }}
    >
      {st && st.status !== 'pending' && (
        <span
          data-node-status={st.status}
          className={`absolute -top-2.5 -left-2 border-2 border-ink px-1 text-[10px] font-black ${STATE_BADGE[st.status] ?? 'bg-white'}`}
        >
          {STATE_LABEL[st.status] ?? st.status}{st.status === 'running' && st.percent !== undefined ? ` ${Math.round(st.percent)}%` : ''}
        </span>
      )}
      {outputSummary !== undefined && (
        <span title={`最近输出: ${outputSummary}`} className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-lime border-2 border-ink" />
      )}
      <Handle type="target" position={Position.Left} className="!bg-ink !w-3 !h-3 !border-2 !border-ink" />
      <div className="text-[10px] uppercase opacity-70">{n.type} · {NODE_LABELS[n.type]}</div>
      <div className="font-mono">{n.id}</div>
      {n.type === 'call-wtop' && n.method && <div className="text-xs font-mono">.{n.method}</div>}
      {n.type === 'http' && <div className="text-xs font-mono">{n.method ?? 'GET'} {String(n.url ?? '').slice(0, 24)}</div>}
      {n.type === 'output' && n.title && <div className="text-xs">{n.title}</div>}
      {st?.error && (
        <div className="text-[10px] font-mono mt-1 bg-punch/30 border border-punch px-1 truncate max-w-[180px]" title={st.error.message}>
          [{st.error.code}]
        </div>
      )}
      {n.type !== 'start' && (
        <button
          type="button"
          title="运行到此节点（下游跳过）"
          className="absolute -bottom-2.5 right-1 border-2 border-ink bg-lemon px-1 text-[10px] font-black leading-tight shadow-neo-sm hover:shadow-none hover:bg-lime"
          onClick={(e) => { e.stopPropagation(); (data.onRunTo as (() => void) | undefined)?.(); }}
        >
          ▶ 到此
        </button>
      )}
      <Handle type="source" position={Position.Right} className="!bg-ink !w-3 !h-3 !border-2 !border-ink" />
    </div>
  );
}

function NeoEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, data }: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: '#111', strokeWidth: 2 }} />
      <EdgeLabelRenderer>
        <div
          className="absolute pointer-events-auto flex items-center gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {label && (
            <span className="border-2 border-ink bg-lemon px-1 text-[10px] font-bold font-mono">{String(label)}</span>
          )}
          <button
            type="button"
            title="在此连线插入节点"
            className="w-5 h-5 border-2 border-ink bg-white text-xs font-black leading-none shadow-neo-sm hover:shadow-none hover:bg-lime"
            onClick={(e) => {
              e.stopPropagation();
              (data?.onInsert as (() => void) | undefined)?.();
            }}
          >
            ＋
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { neo: NeoFlowNode };
const edgeTypes = { neo: NeoEdge };

const PALETTE_GROUPS: { group: string; items: NodeType[] }[] = [
  { group: '数据', items: ['const', 'input', 'output'] },
  { group: '调用', items: ['call-wtop', 'http', 'subflow'] },
  { group: '控制', items: ['transform', 'function', 'condition', 'switch', 'loop', 'parallel', 'merge', 'approval'] },
];

function nodeDefaults(type: NodeType, id: string): FlowNode {
  const base: FlowNode = { id, type };
  switch (type) {
    case 'start': return { ...base, inputSchema: { type: 'object', properties: {} } };
    case 'end': return { ...base, outputMapping: {} };
    case 'call-wtop': return { ...base, inputMapping: {} };
    case 'http': return { ...base, method: 'GET', url: '' };
    case 'transform': case 'condition': return { ...base, expression: '' };
    case 'switch': return { ...base, cases: [] };
    case 'loop': return { ...base, itemsExpression: '', subGraph: { nodes: [], edges: [] } };
    case 'approval': return { ...base, prompt: '确认继续？' };
    case 'subflow': return { ...base, inputMapping: {} };
    case 'const': return { ...base, value: '' };
    case 'input': return {
      ...base, prompt: '请输入',
      inputSchema: { type: 'object', properties: { text: { type: 'string', title: '文本' } }, required: ['text'] },
    };
    case 'output': return { ...base, value: '', format: 'auto' };
    case 'function': return { ...base, code: '// inputs 为输入映射结果对象，context 为运行上下文快照\nreturn inputs;', inputMapping: {}, timeoutMs: 30000 };
    default: return base;
  }
}

function nextNodeId(nodes: FlowNode[], type: NodeType): string {
  const stem = type.replace(/-/g, '_');
  let i = 1;
  while (nodes.some((n) => n.id === `${stem}_${i}`)) i++;
  return `${stem}_${i}`;
}

/** condition/switch 出边按已占用分支取下一可用分支 */
function nextBranch(d: DSL, sourceId: string): string | undefined {
  const src = d.nodes.find((n) => n.id === sourceId);
  if (src?.type === 'condition') {
    const existing = d.edges.filter((e) => e.from === sourceId);
    return existing.some((e) => e.branch === 'true') ? 'false' : 'true';
  }
  if (src?.type === 'switch') {
    const used = new Set(d.edges.filter((e) => e.from === sourceId).map((e) => e.branch));
    return src.cases?.find((cs) => !used.has(cs.value))?.value ?? 'default';
  }
  return undefined;
}

function usePanelOpen(key: 'left' | 'right'): [boolean, (v: boolean) => void] {
  const storageKey = `recycle.editor.${key}`;
  const [open, setOpen] = useState(() => localStorage.getItem(storageKey) !== '0');
  const set = (v: boolean) => { setOpen(v); localStorage.setItem(storageKey, v ? '1' : '0'); };
  return [open, set];
}

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const record = useLiveQuery(() => (id ? db.flows.get(id) : undefined), [id]);
  const toolsQuery = useLiveQuery(() => db.tools.toArray(), []);
  const tools = toolsQuery ?? [];
  const flows = useLiveQuery(() => db.flows.toArray(), []) ?? [];
  const settingsRec = useLiveQuery(() => db.settings.get('app'), []);
  const envKeys = useMemo(
    () => Object.keys(((settingsRec?.value as { env?: Record<string, string> } | undefined)?.env) ?? {}),
    [settingsRec],
  );
  const store = useRunStore();
  const liveRun = !!store.runId && store.flowId === id;

  const [dsl, setDsl] = useState<DSL | null>(null);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<string | null>(null);
  const [runInput, setRunInput] = useState<Record<string, unknown>>({});
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [insertEdge, setInsertEdge] = useState<FlowEdge | null>(null);
  const [leftOpen, setLeftOpen] = usePanelOpen('left');
  const [rightOpen, setRightOpen] = usePanelOpen('right');
  const [logsOpen, setLogsOpen] = useState(false);
  const [viewCallId, setViewCallId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const hasWtop = (dsl?.nodes ?? []).some((n) => n.type === 'call-wtop');
  useEffect(() => { if (liveRun && hasWtop) setPreviewOpen(true); }, [liveRun, hasWtop]);
  const [inputHidden, setInputHidden] = useState(false);
  useEffect(() => { setInputHidden(false); }, [store.inputRequest?.nodeId]);

  useEffect(() => {
    if (record && !dsl && toolsQuery) {
      setDsl(migrateDsl(record.dsl, toolsQuery));
      setName(record.name);
    }
  }, [record, dsl, toolsQuery]);

  const patch = useCallback((fn: (d: DSL) => DSL) => {
    setDsl((d) => (d ? fn(d) : d));
    setDirty(true);
    setIssues(null);
  }, []);

  const openRunTo = useCallback((nid: string | null) => {
    setStopTarget(nid);
    setRunInput(schemaDefaults(dsl?.nodes.find((n) => n.type === 'start')?.inputSchema ?? {}));
    setRunOpen(true);
  }, [dsl]);

  const rfNodes: Node[] = useMemo(() => (dsl?.nodes ?? []).map((n, i) => ({
    id: n.id,
    type: 'neo',
    position: { x: n.x ?? 80 + (i % 4) * 220, y: n.y ?? 60 + Math.floor(i / 4) * 140 },
    data: {
      node: n,
      runState: liveRun ? store.nodeStates[n.id] : undefined,
      outputSummary: liveRun && store.nodeIO[n.id]?.output !== undefined
        ? summarize(store.nodeIO[n.id].output) : undefined,
      onRunTo: () => openRunTo(n.id),
    },
    selected: n.id === selectedId,
    measured: measured[n.id],
  })), [dsl, selectedId, measured, store.nodeStates, store.nodeIO, liveRun, openRunTo]);

  const rfEdges: Edge[] = useMemo(() => (dsl?.edges ?? []).map((e, i) => ({
    id: `e${i}_${e.from}_${e.to}`,
    source: e.from,
    target: e.to,
    type: 'neo',
    label: e.branch,
    data: { onInsert: () => setInsertEdge(e) },
  })), [dsl]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // 受控模式必须把 dimensions 变化写回 nodes，否则新节点永远 visibility:hidden
    const dims = changes.filter(
      (c): c is Extract<NodeChange, { type: 'dimensions' }> => c.type === 'dimensions' && !!c.dimensions,
    );
    if (dims.length) {
      setMeasured((m) => ({
        ...m,
        ...Object.fromEntries(dims.map((c) => [c.id, c.dimensions!])),
      }));
    }
    const moved = applyNodeChanges(changes, rfNodes);
    const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id));
    if (removed.size) {
      patch((d) => ({
        ...d,
        nodes: d.nodes.filter((n) => !removed.has(n.id)),
        edges: d.edges.filter((e) => !removed.has(e.from) && !removed.has(e.to)),
      }));
      if (selectedId && removed.has(selectedId)) setSelectedId(null);
      return;
    }
    const pos = new Map(moved.map((n) => [n.id, n.position]));
    setDsl((d) => d && ({
      ...d,
      nodes: d.nodes.map((n) => {
        const p = pos.get(n.id);
        return p && (p.x !== n.x || p.y !== n.y) ? { ...n, x: Math.round(p.x), y: Math.round(p.y) } : n;
      }),
    }));
    if (changes.some((c) => c.type === 'position' && c.dragging === false)) setDirty(true);
  }, [rfNodes, patch, selectedId]);

  const onConnect = useCallback((c: Connection) => {
    patch((d) => ({
      ...d,
      edges: [...d.edges, { from: c.source!, to: c.target!, branch: nextBranch(d, c.source!) }],
    }));
  }, [patch]);

  /** 面板添加：选中节点（非 end）时自动接在其后并选中新节点 */
  const addNode = (type: NodeType) => {
    if (!dsl) return;
    const nid = nextNodeId(dsl.nodes, type);
    const anchor = selectedId ? dsl.nodes.find((n) => n.id === selectedId && n.type !== 'end') : undefined;
    patch((d) => {
      const n = nodeDefaults(type, nid);
      if (anchor) {
        n.x = (anchor.x ?? 120) + 240;
        n.y = anchor.y ?? 120;
      } else {
        n.x = 120 + (d.nodes.length % 4) * 220;
        n.y = 80 + Math.floor(d.nodes.length / 4) * 140;
      }
      const edges = anchor
        ? [...d.edges, { from: anchor.id, to: nid, branch: nextBranch(d, anchor.id) }]
        : d.edges;
      return { ...d, nodes: [...d.nodes, n], edges };
    });
    setSelectedId(nid);
    setRightOpen(true);
  };

  /** 连线 ＋：A→B 变 A→新→B，原 branch 保留在 A→新（分支语义不变） */
  const insertOnEdge = (type: NodeType) => {
    if (!dsl || !insertEdge) return;
    const nid = nextNodeId(dsl.nodes, type);
    const target = insertEdge;
    patch((d) => {
      const n = nodeDefaults(type, nid);
      const a = d.nodes.find((x) => x.id === target.from);
      const b = d.nodes.find((x) => x.id === target.to);
      n.x = Math.round(((a?.x ?? 120) + (b?.x ?? 360)) / 2);
      n.y = Math.round(((a?.y ?? 120) + (b?.y ?? 120)) / 2) + 90;
      const edges = d.edges.filter((e) => !(e.from === target.from && e.to === target.to && e.branch === target.branch));
      edges.push({ from: target.from, to: nid, branch: target.branch });
      edges.push({ from: nid, to: target.to });
      return { ...d, nodes: [...d.nodes, n], edges };
    });
    setInsertEdge(null);
    setSelectedId(nid);
    setRightOpen(true);
  };

  const duplicateSelected = useCallback(() => {
    if (!dsl || !selectedId) return;
    const src = dsl.nodes.find((n) => n.id === selectedId);
    if (!src || src.type === 'start' || src.type === 'end') return;
    const nid = nextNodeId(dsl.nodes, src.type);
    patch((d) => ({
      ...d,
      nodes: [...d.nodes, { ...structuredClone(src), id: nid, x: (src.x ?? 120) + 40, y: (src.y ?? 120) + 60 }],
    }));
    setSelectedId(nid);
  }, [dsl, selectedId, patch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        const t = e.target as HTMLElement;
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.closest('.cm-editor')) return;
        e.preventDefault();
        duplicateSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [duplicateSelected]);

  const autoLayout = () => {
    if (!dsl) return;
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 90 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of dsl.nodes) {
      const m = measured[n.id];
      g.setNode(n.id, { width: m?.width ?? 170, height: m?.height ?? 64 });
    }
    for (const e of dsl.edges) g.setEdge(e.from, e.to);
    dagre.layout(g);
    patch((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        const p = g.node(n.id);
        const m = measured[n.id];
        return { ...n, x: Math.round(p.x - (m?.width ?? 170) / 2), y: Math.round(p.y - (m?.height ?? 64) / 2) };
      }),
    }));
  };

  const selectedNode = dsl?.nodes.find((n) => n.id === selectedId) ?? null;
  const bindingOptions = useBindingOptions(dsl ?? { id: '', name: '', version: 1, nodes: [], edges: [] }, selectedId ?? '', tools as ToolRecord[], envKeys);

  const save = async (): Promise<FlowRecord | null> => {
    if (!dsl || !record) return null;
    const found = validateFlowDetailed({ ...dsl, name }, tools);
    setIssues(found);
    const next: FlowRecord = {
      ...record, name, version: record.version + 1,
      dsl: { ...dsl, name }, updatedAt: Date.now(),
    };
    await db.flows.put(next);
    setDsl(next.dsl);
    setDirty(false);
    return next;
  };

  const openRun = async () => {
    const saved = await save();
    if (!saved) return;
    if (validateFlowDetailed(saved.dsl, tools).some((i) => i.level === 'error')) return;
    openRunTo(null);
  };

  const doRun = async () => {
    if (!record || !dsl) return;
    const found = validateFlowDetailed({ ...dsl, name }, tools);
    if (found.some((i) => i.level === 'error')) { setIssues(found); setRunOpen(false); return; }
    const saved: FlowRecord = { ...record, name, dsl: { ...dsl, name } };
    setRunOpen(false);
    setLogsOpen(true);
    await store.start(saved, runInput, { mode: 'run', stopAfterNodeId: stopTarget ?? undefined });
  };

  if (!record || !dsl) return <p className="font-mono p-6">加载中…</p>;

  const errorCount = issues?.filter((i) => i.level === 'error').length ?? 0;
  const warnCount = issues?.filter((i) => i.level === 'warn').length ?? 0;
  const runActive = liveRun && ['running', 'paused-human', 'paused-step'].includes(store.status ?? '');
  const selectedState = liveRun && selectedId ? store.nodeStates[selectedId] : undefined;
  const selectedIO = liveRun && selectedId ? store.nodeIO[selectedId] : undefined;
  const waitingApprovals = liveRun
    ? Object.entries(store.nodeStates).filter(([nid, st]) =>
        st.status === 'waiting-human' && dsl.nodes.find((n) => n.id === nid)?.type === 'approval')
    : [];

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <div className="flex items-center gap-3 px-4 py-2 border-b-2 border-ink bg-paper flex-wrap" style={{ marginRight: liveRun && previewOpen && !viewCallId ? 500 : undefined }}>
        <NeoInput value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} className="!w-56 font-bold" />
        <NeoBadge tone="ok">v{record.version}{dirty ? ' *' : ''}</NeoBadge>
        {liveRun && store.status && (
          <span data-run-status={store.status}>
            <NeoBadge tone={store.status}>{RUN_STATUS_LABEL[store.status] ?? store.status}</NeoBadge>
          </span>
        )}
        {liveRun && stopTarget && <NeoBadge tone="ok">到 {stopTarget} 为止</NeoBadge>}
        <div className="flex-1" />
        {runActive && <NeoButton color="bg-punch" onClick={() => store.cancel()}>■ 取消</NeoButton>}
        {liveRun && (
          <>
            <NeoButton color="bg-white" onClick={() => setLogsOpen(!logsOpen)}>{logsOpen ? '隐藏日志' : '日志'}</NeoButton>
            {hasWtop && <NeoButton color="bg-white" onClick={() => setPreviewOpen(!previewOpen)}>{previewOpen ? '隐藏现场' : '现场'}</NeoButton>}
            <Link to={`/run/${store.runId}`} className="font-bold text-xs underline">详情</Link>
          </>
        )}
        <NeoButton color="bg-white" onClick={autoLayout}>整理布局</NeoButton>
        <NeoButton color="bg-white" onClick={() => nav('/flows')}>← 返回</NeoButton>
        <NeoButton color="bg-sky" onClick={save}>保存</NeoButton>
        <NeoButton color="bg-lime" onClick={openRun} disabled={runActive}>▶ 运行</NeoButton>
      </div>

      <div className="flex flex-1 min-h-0" style={{ marginRight: liveRun && previewOpen && !viewCallId ? 500 : undefined }}>
        {leftOpen ? (
          <div className="w-40 border-r-2 border-ink bg-paper p-2 overflow-auto shrink-0">
            <button type="button" title="收起节点面板" onClick={() => setLeftOpen(false)}
              className="block w-full border-2 border-ink bg-white text-xs font-black mb-2 hover:bg-lemon">◀ 收起</button>
            {PALETTE_GROUPS.map((g) => (
              <div key={g.group} className="mb-3">
                <p className="text-xs font-black uppercase mb-1.5">{g.group}</p>
                {g.items.map((type) => (
                  <button
                    key={type}
                    onClick={() => addNode(type)}
                    className="block w-full text-left border-2 border-ink px-2 py-1 mb-1.5 text-xs font-bold shadow-neo-sm hover:shadow-none"
                    style={{ background: NODE_COLORS[type] }}
                  >
                    + {NODE_LABELS[type]}
                  </button>
                ))}
              </div>
            ))}
            <p className="text-[10px] mt-3 opacity-60 leading-relaxed">
              选中节点后添加会自动接在其后；点连线上的 ＋ 插入节点；Ctrl/Cmd+D 复制；节点上的「▶ 到此」运行到该节点为止；Delete 删除。
            </p>
          </div>
        ) : (
          <button type="button" title="展开节点面板" onClick={() => setLeftOpen(true)}
            className="w-7 border-r-2 border-ink bg-paper text-xs font-black shrink-0 hover:bg-lemon">▶</button>
        )}

        <div className="flex-1 relative">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onEdgesDelete={(es) => patch((d) => ({
              ...d,
              edges: d.edges.filter((e) => !es.some((x) => x.source === e.from && x.target === e.to)),
            }))}
            onNodeClick={(_, n) => { setSelectedId(n.id); setRightOpen(true); }}
            onNodeContextMenu={(e, n) => { e.preventDefault(); void openRunTo(n.id); }}
            onPaneClick={() => setSelectedId(null)}
            fitView
            deleteKeyCode={['Delete', 'Backspace']}
          >
            <Background color="#111" gap={24} size={1} />
            <Controls />
            <MiniMap pannable className="!border-2 !border-ink" />
          </ReactFlow>
          {dsl.nodes.length <= 2 && dsl.edges.length === 0 && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 border-2 border-ink bg-lemon shadow-neo px-3 py-2 text-xs font-bold pointer-events-none">
              从左侧添加节点，拖圆点连线；选中节点后添加会自动接在其后
            </div>
          )}
          {waitingApprovals.length > 0 && (
            <div className="absolute top-3 right-3 border-2 border-ink bg-lemon shadow-neo p-3 space-y-2 max-w-xs">
              {waitingApprovals.map(([nid]) => (
                <div key={nid} className="text-xs">
                  <p className="font-bold mb-1">{dsl.nodes.find((n) => n.id === nid)?.prompt ?? '确认继续？'}（{nid}）</p>
                  <div className="flex gap-2">
                    <NeoButton color="bg-lime" className="!px-2 !py-0.5 text-xs" onClick={() => store.resolveApproval(nid, true)}>批准</NeoButton>
                    <NeoButton color="bg-punch" className="!px-2 !py-0.5 text-xs" onClick={() => store.resolveApproval(nid, false)}>拒绝</NeoButton>
                  </div>
                </div>
              ))}
            </div>
          )}
          {issues !== null && (
            <div className="absolute bottom-3 left-3 max-w-md border-2 border-ink shadow-neo bg-white p-3 text-xs max-h-48 overflow-auto">
              {issues.length === 0
                ? <p className="font-bold bg-lime inline-block px-2 border-2 border-ink">✓ 校验通过</p>
                : <>
                    <div className="flex gap-2 mb-2">
                      {errorCount > 0 && <p className="font-bold bg-punch inline-block px-2 border-2 border-ink">✗ {errorCount} 错误（阻止运行）</p>}
                      {warnCount > 0 && <p className="font-bold bg-lemon inline-block px-2 border-2 border-ink">⚠ {warnCount} 警告</p>}
                    </div>
                    <ul className="font-mono space-y-1">
                      {issues.map((s, i) => (
                        <li key={i} className={s.level === 'warn' ? 'opacity-70' : ''}>· {s.level === 'warn' ? '⚠' : '✗'} {s.message}</li>
                      ))}
                    </ul>
                  </>}
            </div>
          )}
          {logsOpen && liveRun && (
            <div className="absolute bottom-3 right-3 w-[420px] max-w-[60%] shadow-neo">
              <LogPanel logs={store.logs} className="h-40" />
            </div>
          )}
        </div>

        {rightOpen ? (
          <div className="w-[380px] border-l-2 border-ink bg-paper p-3 overflow-auto shrink-0">
            <button type="button" title="收起配置面板" onClick={() => setRightOpen(false)}
              className="block w-full border-2 border-ink bg-white text-xs font-black mb-2 hover:bg-lemon">收起 ▶</button>
            {selectedNode ? (
              <>
                {liveRun && (selectedIO?.output !== undefined || selectedIO?.input !== undefined) && (
                  <div className="border-2 border-ink bg-white p-2 mb-3">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-xs font-black uppercase">本次运行 I/O</p>
                      <div className="flex-1" />
                      {selectedState?.callId && ['running', 'waiting-human', 'failed'].includes(selectedState.status) && (
                        <NeoButton color="bg-sky" className="!px-2 !py-0.5 text-xs" onClick={() => setViewCallId(selectedState.callId!)}>查看现场</NeoButton>
                      )}
                    </div>
                    {selectedIO?.input !== undefined && (
                      <details className="mb-1">
                        <summary className="text-xs font-bold cursor-pointer opacity-70">输入</summary>
                        <OutputRenderer value={selectedIO.input} name={`${selectedNode.id}-input`} />
                      </details>
                    )}
                    {selectedIO?.output !== undefined && (
                      selectedNode.type === 'end' || selectedNode.type === 'output' ? (
                        <OutputRenderer
                          value={selectedIO.output}
                          format={selectedNode.format}
                          title={selectedNode.type === 'end' ? '流程输出' : selectedNode.title}
                          filename={selectedNode.filename} mime={selectedNode.mime}
                          name={selectedNode.id}
                        />
                      ) : (
                        <details open>
                          <summary className="text-xs font-bold cursor-pointer opacity-70">输出</summary>
                          <OutputRenderer value={selectedIO.output} name={`${selectedNode.id}-output`} />
                        </details>
                      )
                    )}
                  </div>
                )}
                <ConfigPanel
                  key={selectedNode.id}
                  node={selectedNode}
                  dsl={dsl}
                  tools={tools}
                  flows={flows}
                  bindingOptions={bindingOptions}
                  onRunTo={() => openRunTo(selectedNode.id)}
                  onChange={(p) => patch((d) => ({
                    ...d,
                    nodes: d.nodes.map((n) => (n.id === selectedNode.id ? { ...n, ...p } : n)),
                  }))}
                />
              </>
            ) : (
              <p className="text-sm font-mono opacity-60">点击画布节点进行配置</p>
            )}
          </div>
        ) : (
          <button type="button" title="展开配置面板" onClick={() => setRightOpen(true)}
            className="w-7 border-l-2 border-ink bg-paper text-xs font-black shrink-0 hover:bg-lemon">◀</button>
        )}
      </div>

      {insertEdge && (
        <NeoModal title={`插入节点 · ${insertEdge.from} → ${insertEdge.to}`} onClose={() => setInsertEdge(null)}>
          {PALETTE_GROUPS.map((g) => (
            <div key={g.group} className="mb-3">
              <p className="text-xs font-black uppercase mb-1.5">{g.group}</p>
              <div className="flex flex-wrap gap-2">
                {g.items.map((type) => (
                  <button
                    key={type}
                    onClick={() => insertOnEdge(type)}
                    className="border-2 border-ink px-2 py-1 text-xs font-bold shadow-neo-sm hover:shadow-none"
                    style={{ background: NODE_COLORS[type] }}
                  >
                    + {NODE_LABELS[type]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </NeoModal>
      )}

      {runOpen && (
        <NeoModal title={stopTarget ? `运行到 ${stopTarget} · 输入` : '运行流程 · 输入'} onClose={() => setRunOpen(false)}>
          <SchemaForm
            schema={dsl.nodes.find((n) => n.type === 'start')?.inputSchema ?? { type: 'object', properties: {} }}
            value={runInput}
            onChange={setRunInput}
            allowBindings={false}
          />
          {stopTarget && (
            <p className="text-xs font-mono mt-2">▶ 运行到 <b>{stopTarget}</b> 完成为止，下游节点跳过。</p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <NeoButton color="bg-lime" onClick={() => void doRun()}>▶ 开始运行</NeoButton>
          </div>
        </NeoModal>
      )}

      {liveRun && store.inputRequest && !inputHidden && (
        <InputModal
          key={store.inputRequest.nodeId}
          request={store.inputRequest}
          onSubmit={(v) => store.resolveInput(store.inputRequest!.nodeId, v)}
          onCancel={() => setInputHidden(true)}
        />
      )}
      {viewCallId && <ViewDrawer callId={viewCallId} onClose={() => setViewCallId(null)} />}
      {liveRun && previewOpen && !viewCallId && <PipelinePreview nodes={dsl.nodes} onClose={() => setPreviewOpen(false)} />}
    </div>
  );
}

export function FlowsPage() {
  const flows = useLiveQuery(() => db.flows.orderBy('updatedAt').reverse().toArray(), []) ?? [];
  const nav = useNavigate();
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importErr, setImportErr] = useState('');

  const createFlow = async () => {
    const id = `flow_${Date.now().toString(36)}`;
    const rec: FlowRecord = {
      id, name: '新流程', version: 1,
      dsl: {
        id, name: '新流程', version: 1,
        nodes: [
          { id: 'start', type: 'start', inputSchema: { type: 'object', properties: {} }, x: 80, y: 120 },
          { id: 'end', type: 'end', outputMapping: {}, x: 520, y: 120 },
        ],
        edges: [],
      },
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await db.flows.put(rec);
    nav(`/flows/${id}`);
  };

  const copyFlow = async (f: FlowRecord) => {
    const id = `flow_${Date.now().toString(36)}`;
    await db.flows.put({
      ...f, id, name: `${f.name} 副本`, version: 1,
      dsl: { ...f.dsl, id, name: `${f.name} 副本`, version: 1 },
      createdAt: Date.now(), updatedAt: Date.now(),
    });
  };

  const exportFlow = async (f: FlowRecord) => {
    const bundle = await buildBundle(f);
    downloadJson(bundle, `${f.name}.wtop-bundle.json`);
  };

  const doImport = async () => {
    try {
      const parsed = JSON.parse(importText) as DSL | FlowBundle;
      let dslIn: DSL;
      if (isBundle(parsed)) {
        // 运行包：批量登记工具（已存在同 url 的跳过）+ 导入流程
        const existing = await db.tools.toArray();
        for (const t of parsed.tools) {
          if (!existing.some((x) => x.url === t.url)) await db.tools.put(t);
        }
        dslIn = parsed.flow;
      } else {
        dslIn = parsed;
      }
      if (!dslIn.nodes || !dslIn.edges) throw new Error('缺少 nodes/edges');
      const tools = await db.tools.toArray();
      dslIn = migrateDsl(dslIn, tools);
      // 工具未登记不算导入错误（换环境导入常见），其余 error 拦截
      const problems = validateFlowDetailed(dslIn, tools)
        .filter((i) => i.level === 'error' && !i.message.includes('不存在'));
      if (problems.length) throw new Error(problems[0].message);
      const id = `flow_${Date.now().toString(36)}`;
      const dsl = { ...dslIn, id, version: 1 };
      await db.flows.put({
        id, name: dslIn.name ?? '导入流程', version: 1, dsl,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      setImportOpen(false);
      setImportText('');
      nav(`/flows/${id}`);
    } catch (e) {
      setImportErr(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-3xl font-black uppercase bg-lime border-2 border-ink shadow-neo px-3 py-1">流程</h1>
        <div className="flex gap-2">
          <NeoButton color="bg-white" onClick={() => { setImportOpen(true); setImportErr(''); }}>导入 JSON</NeoButton>
          <NeoButton color="bg-lemon" onClick={createFlow}>+ 新建流程</NeoButton>
        </div>
      </div>

      {flows.length === 0 && (
        <p className="font-mono text-sm border-2 border-dashed border-ink p-6 text-center">还没有流程，点击「新建流程」开始编排</p>
      )}
      <div className="grid md:grid-cols-2 gap-4">
        {flows.map((f) => (
          <div key={f.id} className="border-2 border-ink bg-white shadow-neo p-4">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-black text-lg">{f.name}</h3>
              <div className="flex gap-1">
                {f.id.startsWith('sample-') && <NeoBadge tone="ok">示例</NeoBadge>}
                <NeoBadge tone="ok">v{f.version}</NeoBadge>
              </div>
            </div>
            {SAMPLE_DESCRIPTIONS[f.id] && <p className="text-xs font-bold mb-1 opacity-80">{SAMPLE_DESCRIPTIONS[f.id]}</p>}
            <p className="font-mono text-xs opacity-60 mb-3">
              {f.dsl.nodes.length} 节点 · {f.dsl.edges.length} 边 · {new Date(f.updatedAt).toLocaleString()}
            </p>
            <div className="flex gap-2 flex-wrap">
              <NeoButton color="bg-sky" onClick={() => nav(`/flows/${f.id}`)}>编辑</NeoButton>
              <NeoButton color="bg-white" onClick={() => copyFlow(f)}>复制</NeoButton>
              <NeoButton color="bg-white" onClick={() => void exportFlow(f)}>导出</NeoButton>
              <NeoButton color="bg-punch" onClick={() => { if (confirm(`删除流程「${f.name}」？`)) void db.flows.delete(f.id); }}>删除</NeoButton>
            </div>
          </div>
        ))}
      </div>

      {importOpen && (
        <NeoModal title="导入流程 JSON / 运行包" onClose={() => setImportOpen(false)}>
          <Field label="DSL JSON 或 .wtop-bundle.json" hint={importErr || undefined}>
            <CodeField value={importText} language="json" rows={12} onChange={setImportText} />
          </Field>
          <div className="flex justify-end">
            <NeoButton color="bg-lime" onClick={doImport}>导入</NeoButton>
          </div>
        </NeoModal>
      )}
    </div>
  );
}