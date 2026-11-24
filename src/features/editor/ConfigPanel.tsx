import { useMemo } from 'react';
import type { FlowNode, DSL } from '../engine/dsl';
import type { ToolRecord, FlowRecord } from '../../db/types';
import { SchemaForm, schemaDefaults } from '../../shared/schema-form';
import { NeoInput, NeoSelect, NeoTextarea, Field } from '../../shared/ui';
import { evalExpression } from '../engine/expr';
import { useState } from 'react';

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

export function ConfigPanel({ node, dsl, tools, flows, onChange, bindingOptions }: {
  node: FlowNode;
  dsl: DSL;
  tools: ToolRecord[];
  flows: FlowRecord[];
  onChange: (patch: Partial<FlowNode>) => void;
  bindingOptions: string[];
}) {
  const wtopTools = tools.filter((t) => t.type === 'wtop');
  const httpTools = tools.filter((t) => t.type === 'http');
  const tool = tools.find((t) => t.id === node.toolId);
  const methodDef = tool?.manifest?.methods.find((m) => m.name === node.method);
  const endpoint = tool?.http?.endpoints.find((e) => e.name === node.endpoint);

  const retry = node.retry ?? { max: 0 };

  return (
    <div className="text-sm">
      <div className="flex items-center gap-2 mb-3">
        <span className="font-black uppercase border-2 border-ink bg-lemon px-2 py-0.5">{node.type}</span>
        <span className="font-mono text-xs">{node.id}</span>
      </div>

      {node.type === 'start' && (
        <JsonField label="流程输入 inputSchema" value={node.inputSchema} onChange={(v) => onChange({ inputSchema: v as never })} rows={8} />
      )}
      {node.type === 'end' && (
        <JsonField label="输出映射 outputMapping" value={node.outputMapping} onChange={(v) => onChange({ outputMapping: v as never })}
          hint='如 {"url": "{{context.nodes.upload.output.url}}"}' />
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
            <label className="flex items-center gap-2 mb-3 font-bold text-xs">
              <input type="checkbox" checked={node.preserveScene ?? true}
                onChange={(e) => onChange({ preserveScene: e.target.checked })} />
              失败保留现场
            </label>
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
      } else {
        opts.push(`context.nodes.${id}.output`);
        const tool = tools.find((t) => t.id === n.toolId);
        const outSchema = n.type === 'call-wtop'
          ? tool?.manifest?.methods.find((m) => m.name === n.method)?.output
          : n.type === 'call-http'
            ? tool?.http?.endpoints.find((e) => e.name === n.endpoint)?.output
            : undefined;
        for (const p of Object.keys((outSchema?.properties ?? {}) as object)) {
          opts.push(`context.nodes.${id}.output.${p}`);
        }
      }
    }
    opts.push('context.loop.item', 'context.loop.index');
    return opts;
  }, [dsl, nodeId, tools]);
}