import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position,
  applyNodeChanges, type Node, type Edge, type NodeChange, type Connection, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db';
import type { FlowRecord, ToolRecord } from '../../db/types';
import type { DSL, FlowNode, NodeType } from '../engine/dsl';
import { validateFlow } from '../engine/validate';
import { NeoButton, NeoBadge, NeoModal, NeoInput, Field } from '../../shared/ui';
import { SchemaForm, schemaDefaults } from '../../shared/schema-form';
import { ConfigPanel, useBindingOptions } from './ConfigPanel';
import { useRunStore } from '../../shared/run-store';

const NODE_COLORS: Record<NodeType, string> = {
  start: '#B8F53D', end: '#B8F53D', 'call-wtop': '#7DD3FC', 'call-http': '#C4B5FD',
  transform: '#FFDE59', condition: '#FFA94D', switch: '#FFA94D', loop: '#FFDE59',
  parallel: '#FFDE59', merge: '#FFDE59', approval: '#FF6B9D', subflow: '#7DD3FC',
};

function NeoFlowNode({ data, selected }: NodeProps) {
  const n = data.node as FlowNode;
  return (
    <div
      className="border-2 border-ink px-3 py-2 min-w-[130px] font-bold text-sm"
      style={{ background: NODE_COLORS[n.type], boxShadow: selected ? '6px 6px 0 #111' : '3px 3px 0 #111' }}
    >
      <Handle type="target" position={Position.Left} className="!bg-ink !w-3 !h-3 !border-2 !border-ink" />
      <div className="text-[10px] uppercase opacity-70">{n.type}</div>
      <div className="font-mono">{n.id}</div>
      {n.method && <div className="text-xs font-mono">.{n.method}</div>}
      {n.endpoint && <div className="text-xs font-mono">:{n.endpoint}</div>}
      <Handle type="source" position={Position.Right} className="!bg-ink !w-3 !h-3 !border-2 !border-ink" />
    </div>
  );
}
const nodeTypes = { neo: NeoFlowNode };

const PALETTE: { type: NodeType; label: string }[] = [
  { type: 'call-wtop', label: 'WTOP 调用' },
  { type: 'call-http', label: 'HTTP 调用' },
  { type: 'transform', label: '转换' },
  { type: 'condition', label: '条件' },
  { type: 'switch', label: '分支' },
  { type: 'loop', label: '循环' },
  { type: 'parallel', label: '并行' },
  { type: 'merge', label: '汇聚' },
  { type: 'approval', label: '人工确认' },
  { type: 'subflow', label: '子流程' },
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
    default: return base;
  }
}

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const record = useLiveQuery(() => (id ? db.flows.get(id) : undefined), [id]);
  const tools = useLiveQuery(() => db.tools.toArray(), []) ?? [];
  const flows = useLiveQuery(() => db.flows.toArray(), []) ?? [];
  const startRun = useRunStore((s) => s.start);

  const [dsl, setDsl] = useState<DSL | null>(null);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[] | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [runInput, setRunInput] = useState<Record<string, unknown>>({});
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});

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

  const rfNodes: Node[] = useMemo(() => (dsl?.nodes ?? []).map((n, i) => ({
    id: n.id,
    type: 'neo',
    position: { x: n.x ?? 80 + (i % 4) * 220, y: n.y ?? 60 + Math.floor(i / 4) * 140 },
    data: { node: n },
    selected: n.id === selectedId,
    measured: measured[n.id],
  })), [dsl, selectedId, measured]);

  const rfEdges: Edge[] = useMemo(() => (dsl?.edges ?? []).map((e, i) => ({
    id: `e${i}_${e.from}_${e.to}`,
    source: e.from,
    target: e.to,
    label: e.branch,
    style: { stroke: '#111', strokeWidth: 2 },
    labelStyle: { fontWeight: 700, fontFamily: 'monospace' },
    labelBgStyle: { fill: '#FFDE59', stroke: '#111' },
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
    patch((d) => {
      const src = d.nodes.find((n) => n.id === c.source);
      let branch: string | undefined;
      if (src?.type === 'condition') {
        const existing = d.edges.filter((e) => e.from === c.source);
        branch = existing.some((e) => e.branch === 'true') ? 'false' : 'true';
      } else if (src?.type === 'switch') {
        const used = new Set(d.edges.filter((e) => e.from === c.source).map((e) => e.branch));
        branch = src.cases?.find((cs) => !used.has(cs.value))?.value ?? 'default';
      }
      return { ...d, edges: [...d.edges, { from: c.source!, to: c.target!, branch }] };
    });
  }, [patch]);

  const addNode = (type: NodeType) => {
    patch((d) => {
      let i = 1;
      while (d.nodes.some((n) => n.id === `${type.replace('-', '_')}_${i}`)) i++;
      const n = nodeDefaults(type, `${type.replace('-', '_')}_${i}`);
      n.x = 120 + (d.nodes.length % 4) * 220;
      n.y = 80 + Math.floor(d.nodes.length / 4) * 140;
      return { ...d, nodes: [...d.nodes, n] };
    });
  };

  const selectedNode = dsl?.nodes.find((n) => n.id === selectedId) ?? null;
  const bindingOptions = useBindingOptions(dsl ?? { id: '', name: '', version: 1, nodes: [], edges: [] }, selectedId ?? '', tools as ToolRecord[]);

  const save = async (): Promise<FlowRecord | null> => {
    if (!dsl || !record) return null;
    const found = validateFlow({ ...dsl, name }, tools);
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
    if (validateFlow(saved.dsl, tools).length) return;
    const startNode = saved.dsl.nodes.find((n) => n.type === 'start');
    setRunInput(schemaDefaults(startNode?.inputSchema ?? {}));
    setRunOpen(true);
  };

  const doRun = async () => {
    if (!record || !dsl) return;
    const saved: FlowRecord = { ...record, name, dsl: { ...dsl, name } };
    setRunOpen(false);
    const runId = await startRun(saved, runInput);
    nav(`/run/${runId}`);
  };

  if (!record || !dsl) return <p className="font-mono p-6">加载中…</p>;

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <div className="flex items-center gap-3 px-4 py-2 border-b-2 border-ink bg-paper flex-wrap">
        <NeoInput value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} className="!w-56 font-bold" />
        <NeoBadge tone="ok">v{record.version}{dirty ? ' *' : ''}</NeoBadge>
        <div className="flex-1" />
        <NeoButton color="bg-white" onClick={() => nav('/flows')}>← 返回</NeoButton>
        <NeoButton color="bg-sky" onClick={save}>保存</NeoButton>
        <NeoButton color="bg-lime" onClick={openRun}>▶ 运行</NeoButton>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="w-40 border-r-2 border-ink bg-paper p-2 overflow-auto shrink-0">
          <p className="text-xs font-black uppercase mb-2">添加节点</p>
          {PALETTE.map((p) => (
            <button
              key={p.type}
              onClick={() => addNode(p.type)}
              className="block w-full text-left border-2 border-ink px-2 py-1 mb-1.5 text-xs font-bold shadow-neo-sm hover:shadow-none"
              style={{ background: NODE_COLORS[p.type] }}
            >
              + {p.label}
            </button>
          ))}
          <p className="text-[10px] mt-3 opacity-60">选中节点按 Delete 删除；拖右侧圆点连线</p>
        </div>

        <div className="flex-1 relative">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onEdgesDelete={(es) => patch((d) => ({
              ...d,
              edges: d.edges.filter((e) => !es.some((x) => x.source === e.from && x.target === e.to)),
            }))}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            deleteKeyCode={['Delete', 'Backspace']}
          >
            <Background color="#111" gap={24} size={1} />
            <Controls />
            <MiniMap pannable className="!border-2 !border-ink" />
          </ReactFlow>
          {issues !== null && (
            <div className="absolute bottom-3 left-3 max-w-md border-2 border-ink shadow-neo bg-white p-3 text-xs max-h-48 overflow-auto">
              {issues.length === 0
                ? <p className="font-bold bg-lime inline-block px-2 border-2 border-ink">✓ 校验通过</p>
                : <>
                    <p className="font-bold bg-punch inline-block px-2 border-2 border-ink mb-2">✗ {issues.length} 个问题</p>
                    <ul className="font-mono space-y-1">{issues.map((s, i) => <li key={i}>· {s}</li>)}</ul>
                  </>}
            </div>
          )}
        </div>

        <div className="w-[360px] border-l-2 border-ink bg-paper p-3 overflow-auto shrink-0">
          {selectedNode ? (
            <ConfigPanel
              node={selectedNode}
              dsl={dsl}
              tools={tools}
              flows={flows}
              bindingOptions={bindingOptions}
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

      {runOpen && (
        <NeoModal title="运行流程 · 输入" onClose={() => setRunOpen(false)}>
          <SchemaForm
            schema={dsl.nodes.find((n) => n.type === 'start')?.inputSchema ?? { type: 'object', properties: {} }}
            value={runInput}
            onChange={setRunInput}
            allowBindings={false}
          />
          <div className="mt-4 flex justify-end">
            <NeoButton color="bg-lime" onClick={doRun}>▶ 开始运行</NeoButton>
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
        edges: [{ from: 'start', to: 'end' }],
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
    const blob = new Blob([JSON.stringify(f.dsl, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${f.name}.wtop-flow.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doImport = async () => {
    try {
      const parsed = JSON.parse(importText) as DSL;
      if (!parsed.nodes || !parsed.edges) throw new Error('缺少 nodes/edges');
      const tools = await db.tools.toArray();
      const problems = validateFlow(parsed, tools);
      const schemaBad = problems.filter((p) => !p.includes('未注册') && !p.includes('不存在'));
      if (schemaBad.length) throw new Error(schemaBad[0]);
      const id = `flow_${Date.now().toString(36)}`;
      const dsl = { ...parsed, id, version: 1 };
      await db.flows.put({
        id, name: parsed.name ?? '导入流程', version: 1, dsl,
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
              <NeoButton color="bg-punch" onClick={() => { if (confirm(`删除流程「${f.name}」？`)) void db.flows.delete(f.id); }}>删除</NeoButton>
            </div>
          </div>
        ))}
      </div>

      {importOpen && (
        <NeoModal title="导入流程 JSON" onClose={() => setImportOpen(false)}>
          <Field label="DSL JSON" hint={importErr || undefined}>
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