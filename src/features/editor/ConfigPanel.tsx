import { useMemo, useState } from 'react';
import type { FlowNode, DSL } from '../engine/dsl';
import type { ToolRecord, FlowRecord } from '../../db/types';
import type { JSONSchema } from '@wtop/types';
import { SchemaForm, schemaDefaults } from '../../shared/schema-form';
import { NeoInput, NeoSelect, NeoTextarea, Field } from '../../shared/ui';
import { evalExpression } from '../engine/expr';

function JsonField({ label, value, onChange, rows = 6, hint }: {
  label: string; value: unknown; onChange: (v: unknown) => void; rows?: number; hint?: string;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [err, setErr] = useState('');
  return (
    <Field label={label} hint={hint ?? (err || undefined)}>
      <NeoTextarea
        rows={rows}
        value={text}
        className={err ? 'border-punch' : ''}
        onChange={(e) => {
          setText(e.target.value);
          try { onChange(JSON.parse(e.target.value)); setErr(''); } catch { setErr('JSON 不合法'); }
        }}
      />
    </Field>
  );
}

function ExpressionField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [preview, setPreview] = useState('');
  const trial = async () => {
    try {
      const r = await evalExpression(value, { start: { input: {} }, nodes: {}, env: {} });
      setPreview(`= ${JSON.stringify(r)}`);
    } catch (e) {
      setPreview(String(e instanceof Error ? e.message : e));
    }
  };
  return (
    <Field label="表达式（JSONata，基于 context）">
      <div className="flex gap-2">
        <NeoInput value={value} onChange={(e) => onChange(e.target.value)} placeholder="context.nodes.xxx.output.y > 0" />
        <button type="button" onClick={trial} className="border-2 border-ink bg-sky px-3 font-bold shadow-neo-sm hover:shadow-none shrink-0">试算</button>
      </div>
      {preview && <p className="text-xs font-mono mt-1 break-all">{preview}</p>}
    </Field>
  );
}

const FIELD_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'file'] as const;
type FieldType = typeof FIELD_TYPES[number];

interface FieldRow { name: string; type: FieldType; required: boolean; def: string; desc: string }

function schemaToRows(schema: JSONSchema | undefined): FieldRow[] {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema?.required ?? []) as string[]);
  return Object.entries(props).map(([name, p]) => ({
    name,
    type: (p.format === 'wtop-file' ? 'file' : (p.type as FieldType) ?? 'string'),
    required: required.has(name),
    def: p.default === undefined ? '' : typeof p.default === 'string' ? p.default : JSON.stringify(p.default),
    desc: (p.description as string) ?? (p.title as string) ?? '',
  }));
}

function rowsToSchema(rows: FieldRow[]): JSONSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const r of rows) {
    if (!r.name) continue;
    const p: Record<string, unknown> = r.type === 'file'
      ? { type: 'string', format: 'wtop-file' }
      : { type: r.type };
    if (r.desc) p.description = r.desc;
    if (r.def !== '') {
      if (r.type === 'number') { const n = Number(r.def); if (!Number.isNaN(n)) p.default = n; }
      else if (r.type === 'boolean') p.default = r.def === 'true';
      else if (r.type === 'object' || r.type === 'array') { try { p.default = JSON.parse(r.def); } catch { /* 忽略不合法默认值 */ } }
      else if (r.type === 'string') p.default = r.def;
    }
    properties[r.name] = p;
    if (r.required) required.push(r.name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) } as JSONSchema;
}

/** start/input 的友好字段编辑器：增删行即生成 inputSchema */
function SchemaFieldsEditor({ schema, onChange }: { schema: JSONSchema | undefined; onChange: (v: JSONSchema) => void }) {
  const [rows, setRows] = useState<FieldRow[]>(() => schemaToRows(schema));
  const update = (next: FieldRow[]) => { setRows(next); onChange(rowsToSchema(next)); };
  const setRow = (i: number, p: Partial<FieldRow>) => update(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="mb-3">
      <p className="text-xs font-black uppercase mb-1.5">输入字段</p>
      {rows.map((r, i) => (
        <div key={i} className="border-2 border-ink/30 p-2 mb-2">
          <div className="flex gap-1.5 mb-1.5">
            <NeoInput value={r.name} placeholder="字段名" className="!w-28 font-mono"
              onChange={(e) => setRow(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })} />
            <NeoSelect value={r.type} onChange={(e) => setRow(i, { type: e.target.value as FieldType })}>
              {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </NeoSelect>
            <label className="flex items-center gap-1 text-xs font-bold shrink-0">
              <input type="checkbox" checked={r.required} onChange={(e) => setRow(i, { required: e.target.checked })} />必填
            </label>
            <button type="button" onClick={() => update(rows.filter((_, j) => j !== i))}
              className="border-2 border-ink bg-punch px-2 text-xs font-black shrink-0">×</button>
          </div>
          <div className="flex gap-1.5">
            <NeoInput value={r.def} placeholder={r.type === 'boolean' ? 'true / false' : '默认值（可空）'} className="flex-1"
              onChange={(e) => setRow(i, { def: e.target.value })} />
            <NeoInput value={r.desc} placeholder="描述（可空）" className="flex-1"
              onChange={(e) => setRow(i, { desc: e.target.value })} />
          </div>
        </div>
      ))}
      <button type="button" onClick={() => update([...rows, { name: '', type: 'string', required: false, def: '', desc: '' }])}
        className="border-2 border-ink bg-lemon px-2 py-1 text-xs font-bold shadow-neo-sm hover:shadow-none">+ 添加字段</button>
      <details className="mt-2">
        <summary className="text-xs font-bold cursor-pointer opacity-70">高级：直接编辑 JSON</summary>
        <JsonField label="inputSchema" value={rowsToSchema(rows)} onChange={(v) => { onChange(v as JSONSchema); setRows(schemaToRows(v as JSONSchema)); }} rows={8} />
      </details>
    </div>
  );
}

/** end 快速绑定：上游可达输出一键写入 outputMapping */
function EndQuickBind({ bindingOptions, mapping, onChange }: {
  bindingOptions: string[];
  mapping: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const options = bindingOptions.filter((p) => p.startsWith('context.nodes.') || p.startsWith('context.start.input'));
  const keyFor = (path: string): string => {
    if (path === 'context.start.input') return 'input';
    if (path.endsWith('.output')) return path.split('.')[2];
    return path.split('.').pop()!;
  };
  return (
    <div className="mb-3">
      <p className="text-xs font-black uppercase mb-1.5">快速绑定上游输出</p>
      {options.length === 0 && (
        <p className="text-xs font-mono opacity-60">暂无上游节点——先把业务节点接到 end 之前</p>
      )}
      <div className="max-h-48 overflow-auto space-y-1">
        {options.map((path) => {
          const key = keyFor(path);
          const bound = mapping[key] === `{{${path}}}`;
          return (
            <div key={path} className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={bound}
                onClick={() => onChange({ ...mapping, [key]: `{{${path}}}` })}
                className={`border-2 border-ink px-1.5 text-xs font-black shrink-0 ${bound ? 'bg-lime' : 'bg-white hover:bg-lemon'}`}
              >
                {bound ? '✓' : '＋'}
              </button>
              <span className="text-[11px] font-mono truncate" title={path}>{key} ← {path}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ConfigPanel({ node, dsl, tools, flows, onChange, bindingOptions, breakpoint, onToggleBreakpoint }: {
  node: FlowNode;
  dsl: DSL;
  tools: ToolRecord[];
  flows: FlowRecord[];
  onChange: (patch: Partial<FlowNode>) => void;
  bindingOptions: string[];
  breakpoint?: boolean;
  onToggleBreakpoint?: () => void;
}) {
  const wtopTools = tools.filter((t) => t.type === 'wtop');
  const httpTools = tools.filter((t) => t.type === 'http');
  const tool = tools.find((t) => t.id === node.toolId);
  const methodDef = tool?.manifest?.methods.find((m) => m.name === node.method);
  const endpoint = tool?.http?.endpoints.find((e) => e.name === node.endpoint);

  const retry = node.retry ?? { max: 0 };
  const bindListId = `bind-${node.id}`;

  return (
    <div className="text-sm">
      <div className="flex items-center gap-2 mb-3">
        <span className="font-black uppercase border-2 border-ink bg-lemon px-2 py-0.5">{node.type}</span>
        <span className="font-mono text-xs">{node.id}</span>
      </div>

      {node.type !== 'start' && node.type !== 'end' && onToggleBreakpoint && (
        <label className="flex items-center gap-2 mb-3 font-bold text-xs border-2 border-ink/30 p-2">
          <input type="checkbox" checked={breakpoint ?? false} onChange={onToggleBreakpoint} />
          <span className="w-2.5 h-2.5 rounded-full bg-punch border border-ink inline-block" />
          断点（运行到此节点前暂停）
        </label>
      )}

      {node.type === 'start' && (
        <SchemaFieldsEditor schema={node.inputSchema} onChange={(v) => onChange({ inputSchema: v })} />
      )}
      {node.type === 'end' && (
        <>
          {Object.keys(node.outputMapping ?? {}).length === 0 && (
            <p className="border-2 border-ink bg-lemon px-2 py-1.5 text-xs font-bold mb-3">
              ⚠ 输出映射为空 → 流程输出将是 {'{}'}。用下方快速绑定或手动编辑。
            </p>
          )}
          <EndQuickBind
            bindingOptions={bindingOptions}
            mapping={node.outputMapping ?? {}}
            onChange={(v) => onChange({ outputMapping: v })}
          />
          <JsonField label="输出映射 outputMapping" value={node.outputMapping} onChange={(v) => onChange({ outputMapping: v as never })}
            hint='如 {"url": "{{context.nodes.upload.output.url}}"}' />
        </>
      )}

      {node.type === 'const' && (
        <JsonField label="常量值 value（JSON）" value={node.value} onChange={(v) => onChange({ value: v })} rows={8}
          hint='字面量即常量；字符串 "{{表达式}}" 会在运行期求值' />
      )}

      {node.type === 'input' && (
        <>
          <Field label="提示语 prompt">
            <NeoInput value={node.prompt ?? ''} onChange={(e) => onChange({ prompt: e.target.value })} placeholder="请输入…" />
          </Field>
          <SchemaFieldsEditor schema={node.inputSchema} onChange={(v) => onChange({ inputSchema: v })} />
          <p className="text-xs font-mono opacity-60 mb-3">运行到此节点时暂停，看板弹表单等用户提交；无头运行需预置值（wtop run --runtime-input）。</p>
        </>
      )}

      {node.type === 'output' && (
        <>
          <Field label="输出值 value（常量 / 绑定）" hint="透传给下游，可继续绑定 context.nodes.<此节点>.output">
            <datalist id={bindListId}>
              {bindingOptions.map((p) => <option key={p} value={`{{${p}}}`} />)}
            </datalist>
            <NeoInput
              list={bindListId}
              value={typeof node.value === 'string' ? node.value : JSON.stringify(node.value ?? null)}
              placeholder="{{context.nodes.xxx.output.yyy}}"
              onChange={(e) => {
                const t = e.target.value;
                if (t.startsWith('{{') || t === '' || !/^[\[{"]/.test(t.trim())) onChange({ value: t });
                else { try { onChange({ value: JSON.parse(t) }); } catch { onChange({ value: t }); } }
              }}
            />
          </Field>
          <Field label="标题 title（展示用，可空）">
            <NeoInput value={node.title ?? ''} onChange={(e) => onChange({ title: e.target.value || undefined })} />
          </Field>
          <Field label="展示格式 format">
            <NeoSelect value={node.format ?? 'auto'} onChange={(e) => onChange({ format: e.target.value as never })}>
              <option value="auto">auto（按类型）</option>
              <option value="json">json</option>
              <option value="text">text</option>
              <option value="table">table（对象数组）</option>
            </NeoSelect>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="下载文件名（可空）">
              <NeoInput value={node.filename ?? ''} onChange={(e) => onChange({ filename: e.target.value || undefined })} placeholder="result.json" />
            </Field>
            <Field label="MIME（可空）">
              <NeoInput value={node.mime ?? ''} onChange={(e) => onChange({ mime: e.target.value || undefined })} placeholder="text/plain" />
            </Field>
          </div>
          <p className="text-xs font-mono opacity-60 mb-3">看板节点卡片提供 展示 / ⬇ 下载 / 🖨 打印 / 复制。</p>
        </>
      )}

      {(node.type === 'call-wtop' || node.type === 'call-http') && (
        <>
          <Field label="工具">
            <NeoSelect
              className="w-full"
              value={node.toolId ?? ''}
              onChange={(e) => onChange({ toolId: e.target.value, method: undefined, endpoint: undefined, inputMapping: {} })}
            >
              <option value="">选择工具…</option>
              {(node.type === 'call-wtop' ? wtopTools : httpTools).map((t) => (
                <option key={t.id} value={t.id}>{t.displayName}</option>
              ))}
            </NeoSelect>
          </Field>
          {node.type === 'call-wtop' && tool?.manifest && (
            <Field label="方法">
              <NeoSelect
                className="w-full"
                value={node.method ?? ''}
                onChange={(e) => {
                  const m = tool.manifest!.methods.find((x) => x.name === e.target.value);
                  onChange({ method: e.target.value, inputMapping: schemaDefaults(m?.input ?? {}) });
                }}
              >
                <option value="">选择方法…</option>
                {tool.manifest.methods.map((m) => (
                  <option key={m.name} value={m.name}>{m.displayName ?? m.name}（{m.mode ?? 'hybrid'}）</option>
                ))}
              </NeoSelect>
            </Field>
          )}
          {node.type === 'call-http' && tool?.http && (
            <Field label="Endpoint">
              <NeoSelect
                className="w-full"
                value={node.endpoint ?? ''}
                onChange={(e) => {
                  const ep = tool.http!.endpoints.find((x) => x.name === e.target.value);
                  onChange({ endpoint: e.target.value, inputMapping: schemaDefaults(ep?.input ?? {}) });
                }}
              >
                <option value="">选择 endpoint…</option>
                {tool.http.endpoints.map((ep) => (
                  <option key={ep.name} value={ep.name}>{ep.method} {ep.path}（{ep.name}）</option>
                ))}
              </NeoSelect>
            </Field>
          )}
          {((node.type === 'call-wtop' && methodDef) || (node.type === 'call-http' && endpoint)) && (
            <Field label="入参（常量 / 绑定切换）">
              <SchemaForm
                schema={(node.type === 'call-wtop' ? methodDef!.input : endpoint!.input) as never}
                value={node.inputMapping ?? {}}
                onChange={(v) => onChange({ inputMapping: v })}
                bindingOptions={bindingOptions}
              />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label="超时 ms">
              <NeoInput type="number" value={node.timeoutMs ?? ''} placeholder="默认 60000"
                onChange={(e) => onChange({ timeoutMs: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
            <Field label="重试次数">
              <NeoInput type="number" value={retry.max}
                onChange={(e) => onChange({ retry: { ...retry, max: Number(e.target.value) || 0 } })} />
            </Field>
          </div>
          {retry.max > 0 && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="重试错误码（逗号分隔，空=全部）">
                <NeoInput value={(retry.on ?? []).join(',')}
                  onChange={(e) => onChange({ retry: { ...retry, on: e.target.value ? e.target.value.split(',').map((s) => s.trim()) : undefined } })} />
              </Field>
              <Field label="退避 ms">
                <NeoInput type="number" value={retry.backoffMs ?? 500}
                  onChange={(e) => onChange({ retry: { ...retry, backoffMs: Number(e.target.value) || 0 } })} />
              </Field>
            </div>
          )}
          {node.type === 'call-wtop' && (
            <>
              <Field label="模式覆盖（默认跟随方法声明）">
                <NeoSelect className="w-full" value={node.mode ?? ''}
                  onChange={(e) => onChange({ mode: (e.target.value || undefined) as never })}>
                  <option value="">默认（{methodDef?.mode ?? 'hybrid'}）</option>
                  <option value="headless">headless（不弹画面）</option>
                  <option value="hybrid">hybrid（可查看现场）</option>
                  <option value="interactive">interactive（强制交互）</option>
                </NeoSelect>
              </Field>
              <label className="flex items-center gap-2 mb-3 font-bold text-xs">
                <input type="checkbox" checked={node.preserveScene ?? true}
                  onChange={(e) => onChange({ preserveScene: e.target.checked })} />
                失败保留现场
              </label>
            </>
          )}
        </>
      )}

      {(node.type === 'transform' || node.type === 'condition') && (
        <ExpressionField value={node.expression ?? ''} onChange={(v) => onChange({ expression: v })} />
      )}
      {node.type === 'switch' && (
        <JsonField label="cases [{value, expression}]" value={node.cases} onChange={(v) => onChange({ cases: v as never })} rows={6} />
      )}
      {node.type === 'loop' && (
        <>
          <Field label="itemsExpression（数组）">
            <NeoInput value={node.itemsExpression ?? ''} onChange={(e) => onChange({ itemsExpression: e.target.value })}
              placeholder="context.start.input.list" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="并发">
              <NeoInput type="number" value={node.concurrency ?? 1}
                onChange={(e) => onChange({ concurrency: Number(e.target.value) || 1 })} />
            </Field>
            <Field label="item 变量名">
              <NeoInput value={node.itemVar ?? 'item'} onChange={(e) => onChange({ itemVar: e.target.value })} />
            </Field>
          </div>
          <JsonField label="子图 subGraph {nodes, edges}" value={node.subGraph} onChange={(v) => onChange({ subGraph: v as never })} rows={8}
            hint="子图内用 context.loop.item / context.loop.index" />
        </>
      )}
      {node.type === 'merge' && (
        <Field label="汇聚策略">
          <NeoSelect value={node.strategy ?? 'array'} onChange={(e) => onChange({ strategy: e.target.value as never })}>
            <option value="array">array</option>
            <option value="object">object</option>
            <option value="first">first</option>
          </NeoSelect>
        </Field>
      )}
      {node.type === 'approval' && (
        <Field label="确认提示">
          <NeoInput value={node.prompt ?? ''} onChange={(e) => onChange({ prompt: e.target.value })} />
        </Field>
      )}
      {node.type === 'subflow' && (
        <>
          <Field label="子流程">
            <NeoSelect className="w-full" value={node.flowId ?? ''} onChange={(e) => onChange({ flowId: e.target.value })}>
              <option value="">选择流程…</option>
              {flows.filter((f) => f.id !== dsl.id).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </NeoSelect>
          </Field>
          <JsonField label="输入映射 inputMapping" value={node.inputMapping} onChange={(v) => onChange({ inputMapping: v as never })} />
        </>
      )}

      {node.type !== 'start' && node.type !== 'end' && (
        <Field label="失败策略 onError">
          <NeoSelect value={node.onError ?? 'fail'} onChange={(e) => onChange({ onError: e.target.value as never })}>
            <option value="fail">fail（终止）</option>
            <option value="skip">skip（跳过继续）</option>
            <option value="fallback">fallback（走 fallback 出边）</option>
          </NeoSelect>
        </Field>
      )}
    </div>
  );
}

/** 上游可达输出字段 → binding picker 选项 */
export function useBindingOptions(dsl: DSL, nodeId: string, tools: ToolRecord[]): string[] {
  return useMemo(() => {
    const ancestors = new Set<string>();
    const queue = [nodeId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of dsl.edges) {
        if (e.to === cur && !ancestors.has(e.from)) {
          ancestors.add(e.from);
          queue.push(e.from);
        }
      }
    }
    const opts: string[] = [];
    for (const id of ancestors) {
      const n = dsl.nodes.find((x) => x.id === id);
      if (!n) continue;
      if (n.type === 'start') {
        const props = Object.keys((n.inputSchema?.properties ?? {}) as object);
        for (const p of props) opts.push(`context.start.input.${p}`);
        opts.push('context.start.input');
        continue;
      }
      opts.push(`context.nodes.${id}.output`);
      let outProps: object | undefined;
      if (n.type === 'call-wtop' || n.type === 'call-http') {
        const tool = tools.find((t) => t.id === n.toolId);
        const outSchema = n.type === 'call-wtop'
          ? tool?.manifest?.methods.find((m) => m.name === n.method)?.output
          : tool?.http?.endpoints.find((e) => e.name === n.endpoint)?.output;
        outProps = (outSchema?.properties ?? undefined) as object | undefined;
      } else if (n.type === 'input') {
        outProps = (n.inputSchema?.properties ?? undefined) as object | undefined;
      } else if (n.type === 'const' && n.value !== null && typeof n.value === 'object' && !Array.isArray(n.value)) {
        outProps = n.value as object;
      }
      for (const p of Object.keys(outProps ?? {})) {
        opts.push(`context.nodes.${id}.output.${p}`);
      }
    }
    opts.push('context.loop.item', 'context.loop.index');
    return opts;
  }, [dsl, nodeId, tools]);
}