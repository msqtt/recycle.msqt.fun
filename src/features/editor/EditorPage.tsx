import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position,
  applyNodeChanges, BaseEdge, EdgeLabelRenderer, getSmoothStepPath,
  type Node, type Edge, type NodeChange, type Connection, type NodeProps, type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db';
import type { FlowRecord, ToolRecord } from '../../db/types';
import type { DSL, FlowNode, NodeType, FlowEdge } from '../engine/dsl';
import { validateFlowDetailed, type ValidationIssue } from '../engine/validate';
import { NeoButton, NeoBadge, NeoModal, NeoInput, Field } from '../../shared/ui';
import { SchemaForm, schemaDefaults } from '../../shared/schema-form';
import { ConfigPanel, useBindingOptions } from './ConfigPanel';
import { useRunStore } from '../../shared/run-store';
import { buildBundle, isBundle, downloadJson, type FlowBundle } from '../bundle';

const NODE_COLORS: Record<NodeType, string> = {
  start: '#B8F53D', end: '#B8F53D', 'call-wtop': '#7DD3FC', 'call-http': '#C4B5FD',
  transform: '#FFDE59', condition: '#FFA94D', switch: '#FFA94D', loop: '#FFDE59',
  parallel: '#FFDE59', merge: '#FFDE59', approval: '#FF6B9D', subflow: '#7DD3FC',
  const: '#FFDE59', input: '#FF6B9D', output: '#B8F53D',
};

const NODE_LABELS: Record<NodeType, string> = {
  start: '开始', end: '结束', 'call-wtop': 'WTOP 调用', 'call-http': 'HTTP 调用',
  transform: '转换', condition: '条件', switch: '分支', loop: '循环',
  parallel: '并行', merge: '汇聚', approval: '人工确认', subflow: '子流程',
  const: '常量', input: '输入', output: '输出',
};

function summarize(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? '' : s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function NeoFlowNode({ data, selected }: NodeProps) {
  const n = data.node as FlowNode;
  const breakpoint = data.breakpoint as boolean;
  const outputSummary = data.outputSummary as string | undefined;
  return (
    <div
      className="border-2 border-ink px-3 py-2 min-w-[130px] font-bold text-sm relative"
      style={{ background: NODE_COLORS[n.type], boxShadow: selected ? '6px 6px 0 #111' : '3px 3px 0 #111' }}
    >
      {breakpoint && (
        <span title="断点" className="absolute -top-1.5 -left-1.5 w-3.5 h-3.5 rounded-full bg-punch border-2 border-ink" />
      )}
      {outputSummary !== undefined && (
        <span title={`最近输出: ${outputSummary}`} className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-lime border-2 border-ink" />
      )}
      <Handle type="target" position={Position.Left} className="!bg-ink !w-3 !h-3 !border-2 !border-ink" />
      <div className="text-[10px] uppercase opacity-70">{n.type} · {NODE_LABELS[n.type]}</div>
      <div className="font-mono">{n.id}</div>
      {n.method && <div className="text-xs font-mono">.{n.method}</div>}
      {n.endpoint && <div className="text-xs font-mono">:{n.endpoint}</div>}
      {n.type === 'output' && n.title && <div className="text-xs">{n.title}</div>}
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
  { group: '调用', items: ['call-wtop', 'call-http', 'subflow'] },
  { group: '控制', items: ['transform', 'condition', 'switch', 'loop', 'parallel', 'merge', 'approval'] },
];

function nodeDefaults(type: NodeType, id: string): FlowNode {
  const base: FlowNode = { id, type };
  switch (type) {
    case 'start': return { ...base, inputSchema: { type: 'object', properties: {} } };
    case 'end': return { ...base, outputMapping: {} };
    case 'call-wtop': return { ...base, inputMapping: {} };
    case 'call-http': return { ...base, inputMapping: {} };
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

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const record = useLiveQuery(() => (id ? db.flows.get(id) : undefined), [id]);
  const tools = useLiveQuery(() => db.tools.toArray(), []) ?? [];
  const flows = useLiveQuery(() => db.flows.toArray(), []) ?? [];
  const startRun = useRunStore((s) => s.start);
  const liveFlowId = useRunStore((s) => s.flowId);
  const nodeIO = useRunStore((s) => s.nodeIO);

  const [dsl, setDsl] = useState<DSL | null>(null);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [runInput, setRunInput] = useState<Record<string, unknown>>({});
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [breakpoints, setBreakpoints] = useState<Set<string>>(new Set());
  const [insertEdge, setInsertEdge] = useState<FlowEdge | null>(null);

  useEffect(() => {
    if (record && !dsl) {
      setDsl(record.dsl);
      setName(record.name);
    }
  }, [record, dsl]);

  const patch = useCallback((fn: (d: DSL) => DSL) => {
    setDsl((d) => (d ? fn(d) : d));
    setDirty(true);
    setIssues(null);
  }, []);

  const toggleBreakpoint = useCallback((nid: string) => {
    setBreakpoints((s) => {
      const next = new Set(s);
      if (next.has(nid)) next.delete(nid); else next.add(nid);
      return next;
    });
  }, []);

  const rfNodes: Node[] = useMemo(() => (dsl?.nodes ?? []).map((n, i) => ({
    id: n.id,
    type: 'neo',
    position: { x: n.x ?? 80 + (i % 4) * 220, y: n.y ?? 60 + Math.floor(i / 4) * 140 },
    data: {
      node: n,
      breakpoint: breakpoints.has(n.id),
      outputSummary: liveFlowId === id && nodeIO[n.id]?.output !== undefined
        ? summarize(nodeIO[n.id].output) : undefined,
    },
    selected: n.id === selectedId,
    measured: measured[n.id],
  })), [dsl, selectedId, measured, breakpoints, nodeIO, liveFlowId, id]);

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
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
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
  const bindingOptions = useBindingOptions(dsl ?? { id: '', name: '', version: 1, nodes: [], edges: [] }, selectedId ?? '', tools as ToolRecord[]);

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
    const startNode = saved.dsl.nodes.find((n) => n.type === 'start');
    setRunInput(schemaDefaults(startNode?.inputSchema ?? {}));
    setRunOpen(true);
  };

  const doRun = async (mode: 'run' | 'step') => {
    if (!record || !dsl) return;
    const saved: FlowRecord = { ...record, name, dsl: { ...dsl, name } };
    setRunOpen(false);
    const runId = await startRun(saved, runInput, { mode, breakpoints: [...breakpoints] });
    nav(`/run/${runId}`);
  };

  if (!record || !dsl) return <p className="font-mono p-6">加载中…</p>;

  const errorCount = issues?.filter((i) => i.level === 'error').length ?? 0;
  const warnCount = issues?.filter((i) => i.level === 'warn').length ?? 0;

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <div className="flex items-center gap-3 px-4 py-2 border-b-2 border-ink bg-paper flex-wrap">
        <NeoInput value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} className="!w-56 font-bold" />
        <NeoBadge tone="ok">v{record.version}{dirty ? ' *' : ''}</NeoBadge>
        <div className="flex-1" />
        <NeoButton color="bg-white" onClick={autoLayout}>整理布局</NeoButton>
        <NeoButton color="bg-white" onClick={() => nav('/flows')}>← 返回</NeoButton>
        <NeoButton color="bg-sky" onClick={save}>保存</NeoButton>
        <NeoButton color="bg-lime" onClick={openRun}>▶ 运行</NeoButton>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="w-40 border-r-2 border-ink bg-paper p-2 overflow-auto shrink-0">
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
            选中节点后添加会自动接在其后；点连线上的 ＋ 插入节点；Ctrl/Cmd+D 复制；右键节点切换断点；Delete 删除。
          </p>
        </div>

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
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onNodeContextMenu={(e, n) => { e.preventDefault(); toggleBreakpoint(n.id); }}
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
        </div>

        <div className="w-[360px] border-l-2 border-ink bg-paper p-3 overflow-auto shrink-0">
          {selectedNode ? (
            <ConfigPanel
              key={selectedNode.id}
              node={selectedNode}
              dsl={dsl}
              tools={tools}
              flows={flows}
              bindingOptions={bindingOptions}
              breakpoint={breakpoints.has(selectedNode.id)}
              onToggleBreakpoint={() => toggleBreakpoint(selectedNode.id)}
              onChange={(p) => patch((d) => ({
                ...d,
                nodes: d.nodes.map((n) => (n.id === selectedNode.id ? { ...n, ...p } : n)),
              }))}
            />
          ) : (
            <p className="text-sm font-mono opacity-60">点击画布节点进行配置</p>
          )}
        </div>
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
        <NeoModal title="运行流程 · 输入" onClose={() => setRunOpen(false)}>
          <SchemaForm
            schema={dsl.nodes.find((n) => n.type === 'start')?.inputSchema ?? { type: 'object', properties: {} }}
            value={runInput}
            onChange={setRunInput}
            allowBindings={false}
          />
          {breakpoints.size > 0 && (
            <p className="text-xs font-mono mt-2">断点：{[...breakpoints].join(', ')}</p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <NeoButton color="bg-lemon" onClick={() => doRun('step')}>⏵ 试运行（单步）</NeoButton>
            <NeoButton color="bg-lime" onClick={() => doRun('run')}>▶ 开始运行</NeoButton>
          </div>
        </NeoModal>
      )}
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

  const exportFlow = (f: FlowRecord) => {
    downloadJson(f.dsl, `${f.name}.wtop-flow.json`);
  };

  const exportBundle = async (f: FlowRecord) => {
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
              <NeoBadge tone="ok">v{f.version}</NeoBadge>
            </div>
            <p className="font-mono text-xs opacity-60 mb-3">
              {f.dsl.nodes.length} 节点 · {f.dsl.edges.length} 边 · {new Date(f.updatedAt).toLocaleString()}
            </p>
            <div className="flex gap-2 flex-wrap">
              <NeoButton color="bg-sky" onClick={() => nav(`/flows/${f.id}`)}>编辑</NeoButton>
              <NeoButton color="bg-white" onClick={() => copyFlow(f)}>复制</NeoButton>
              <NeoButton color="bg-white" onClick={() => exportFlow(f)}>导出</NeoButton>
              <NeoButton color="bg-white" onClick={() => void exportBundle(f)}>导出运行包</NeoButton>
              <NeoButton color="bg-punch" onClick={() => { if (confirm(`删除流程「${f.name}」？`)) void db.flows.delete(f.id); }}>删除</NeoButton>
            </div>
          </div>
        ))}
      </div>

      {importOpen && (
        <NeoModal title="导入流程 JSON / 运行包" onClose={() => setImportOpen(false)}>
          <Field label="DSL JSON 或 .wtop-bundle.json" hint={importErr || undefined}>
            <textarea
              rows={12}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              className="border-2 border-ink w-full font-mono text-xs p-2"
            />
          </Field>
          <div className="flex justify-end">
            <NeoButton color="bg-lime" onClick={doImport}>导入</NeoButton>
          </div>
        </NeoModal>
      )}
    </div>
  );
}