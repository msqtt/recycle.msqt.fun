import { useRef } from 'react';
import type { JSONSchema } from '@wtop/types';
import { NeoInput, NeoSelect, NeoTextarea } from './ui';

type Schema = Record<string, unknown>;

export function schemaDefaults(schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = (schema.properties ?? {}) as Record<string, Schema>;
  for (const [k, v] of Object.entries(props)) {
    if (v.default !== undefined) out[k] = v.default;
  }
  return out;
}

const isBinding = (v: unknown): v is string =>
  typeof v === 'string' && /^\{\{[\s\S]*\}\}$/.test(v);

function FileField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const name = value instanceof Blob
    ? `${(value as File).name ?? 'blob'} (${value.size} B)`
    : value ? '已选择' : '未选择';
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className="border-2 border-ink bg-sky px-3 py-1 text-sm font-bold shadow-neo-sm hover:shadow-none"
      >
        选择文件
      </button>
      <span className="text-xs font-mono">{name}</span>
      <input ref={ref} type="file" className="hidden" onChange={(e) => onChange(e.target.files?.[0] ?? undefined)} />
    </div>
  );
}

function FieldControl({ name, schema, value, onChange }: {
  name: string; schema: Schema; value: unknown; onChange: (v: unknown) => void;
}) {
  const type = schema.type as string | undefined;
  if (schema.format === 'wtop-file') return <FileField value={value} onChange={onChange} />;
  if (Array.isArray(schema.enum)) {
    return (
      <NeoSelect value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {(schema.enum as unknown[]).map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
      </NeoSelect>
    );
  }
  if (type === 'boolean') {
    return (
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`border-2 border-ink px-3 py-1 text-sm font-bold shadow-neo-sm hover:shadow-none ${value ? 'bg-lime' : 'bg-white'}`}
      >
        {value ? 'TRUE' : 'FALSE'}
      </button>
    );
  }
  if (type === 'number' || type === 'integer') {
    return (
      <NeoInput
        type="number"
        data-field={name}
        value={value === undefined || value === null ? '' : String(value)}
        min={schema.minimum as number | undefined}
        max={schema.maximum as number | undefined}
        step={type === 'integer' ? 1 : 'any'}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    );
  }
  if (type === 'object') {
    return (
      <div className="border-2 border-ink/30 p-2">
        <SchemaForm schema={schema} value={(value ?? {}) as Record<string, unknown>} onChange={onChange} allowBindings={false} />
      </div>
    );
  }
  if (type === 'array') {
    return (
      <NeoTextarea
        rows={3}
        placeholder="JSON 数组"
        value={value === undefined ? '' : JSON.stringify(value)}
        onChange={(e) => {
          try { onChange(JSON.parse(e.target.value)); } catch { onChange(e.target.value); }
        }}
      />
    );
  }
  const long = (schema.maxLength as number | undefined) !== undefined && (schema.maxLength as number) > 200;
  if (long) {
    return <NeoTextarea rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <NeoInput
      data-field={name}
      value={value === undefined || value === null ? '' : String(value)}
      placeholder={schema.description as string | undefined ?? name}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function SchemaForm({ schema, value, onChange, bindingOptions = [], allowBindings = true }: {
  schema: JSONSchema;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  bindingOptions?: string[];
  allowBindings?: boolean;
}) {
  const props = (schema.properties ?? {}) as Record<string, Schema>;
  const required = new Set((schema.required ?? []) as string[]);
  const listId = `bindings-${Math.random().toString(36).slice(2, 8)}`;
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });

  return (
    <div>
      {allowBindings && bindingOptions.length > 0 && (
        <datalist id={listId}>
          {bindingOptions.map((p) => <option key={p} value={`{{${p}}}`} />)}
        </datalist>
      )}
      {Object.entries(props).map(([name, sub]) => {
        const v = value[name];
        const bound = isBinding(v);
        const missing = required.has(name) && (v === undefined || v === '');
        return (
          <div key={name} className={`mb-3 border-2 p-2 ${missing ? 'border-punch bg-punch/10' : 'border-ink/20'}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold uppercase">
                {name}{required.has(name) && <span className="text-punch"> *</span>}
                {sub.description ? <span className="ml-2 font-normal normal-case text-ink/60">{String(sub.description)}</span> : null}
              </span>
              {allowBindings && (
                <button
                  type="button"
                  onClick={() => set(name, bound ? schemaDefaults({ properties: { [name]: sub } })[name] : '{{context.}}')}
                  className={`border-2 border-ink px-2 text-[10px] font-bold ${bound ? 'bg-grape' : 'bg-white'}`}
                >
                  {bound ? '绑定' : '常量'}
                </button>
              )}
            </div>
            {bound ? (
              <NeoInput
                list={allowBindings ? listId : undefined}
                value={v as string}
                placeholder="{{context.nodes.xxx.output.yyy}}"
                onChange={(e) => set(name, e.target.value)}
              />
            ) : (
              <FieldControl name={name} schema={sub} value={v} onChange={(x) => set(name, x)} />
            )}
          </div>
        );
      })}
      {Object.keys(props).length === 0 && <p className="text-sm text-ink/60 font-mono">（无字段）</p>}
    </div>
  );
}