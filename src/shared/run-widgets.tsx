import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../db/types';
import type { JSONSchema } from '@wtop/types';
import { getHost } from '../wtop/hostClient';
import { NeoButton, NeoModal } from './ui';
import { SchemaForm, schemaDefaults } from './schema-form';

export function LogPanel({ logs, className = 'h-56' }: { logs: LogEntry[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [logs.length]);
  return (
    <div ref={ref} className={`border-2 border-ink bg-ink text-lime font-mono text-xs p-3 overflow-auto ${className}`}>
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
export function ViewDrawer({ callId, onClose }: { callId: string; onClose: () => void }) {
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

export function InputModal({ request, onSubmit, onCancel }: {
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