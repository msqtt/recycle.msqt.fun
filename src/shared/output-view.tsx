import type { BlobRecord } from '../db/types';
import { NeoButton } from './ui';

type Format = 'auto' | 'json' | 'text' | 'table';

function isBlobRef(v: unknown): v is { $blob: string } {
  return v !== null && typeof v === 'object' && '$blob' in v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Blob) && !isBlobRef(v);
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
}

function TableView({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <div className="overflow-auto max-h-80 border-2 border-ink">
      <table className="text-xs font-mono w-full">
        <thead>
          <tr>{cols.map((c) => <th key={c} className="border-b-2 border-r-2 border-ink bg-lemon px-2 py-1 text-left">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i % 2 ? 'bg-paper' : 'bg-white'}>
              {cols.map((c) => (
                <td key={c} className="border-r-2 border-ink/20 px-2 py-1 align-top break-all">
                  {typeof r[c] === 'object' && r[c] !== null ? JSON.stringify(r[c]) : String(r[c] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 输出渲染 + 下载/打印/复制（output 节点、end 输出、节点 I/O 审查共用） */
export function OutputRenderer({ value, blobs = [], format = 'auto', title, filename, mime, name = 'output' }: {
  value: unknown;
  blobs?: BlobRecord[];
  format?: Format;
  title?: string;
  filename?: string;
  mime?: string;
  name?: string;
}) {
  const blobRec = isBlobRef(value) ? blobs.find((b) => b.id === value.$blob) : undefined;
  const blob: Blob | null = value instanceof Blob ? value : blobRec?.data ?? null;
  const blobName = blob ? ((blob as File).name || blobRec?.name || filename || `${name}.bin`) : null;
  const nestedBlobs = isPlainObject(value)
    ? Object.entries(value).filter(([, v]) => v instanceof Blob || isBlobRef(v))
    : [];
  const displayValue = nestedBlobs.length
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        v instanceof Blob || isBlobRef(v)
          ? { $file: k, size: v instanceof Blob ? v.size : blobs.find((b) => b.id === (v as { $blob: string }).$blob)?.size }
          : v,
      ]))
    : value;
  const text = blob ? null : toText(displayValue);
  const isTable = format === 'table'
    || (format === 'auto' && Array.isArray(value) && value.length > 0 && value.every(isPlainObject));

  const download = () => {
    const data = blob ?? new Blob([text ?? ''], {
      type: mime ?? (typeof value === 'string' ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8'),
    });
    const fallback = `${name}.${blob ? 'bin' : typeof value === 'string' ? 'txt' : 'json'}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(data);
    a.download = filename ?? blobName ?? fallback;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const print = () => {
    if (blob && !blob.type.startsWith('text/')) { download(); return; }
    const content = blob ? null : text ?? '';
    if (blob) {
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    }
    const w = window.open('', '_blank', 'width=800,height=600');
    if (!w) return;
    w.document.title = title ?? filename ?? name;
    const pre = w.document.createElement('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.fontFamily = 'monospace';
    pre.textContent = content;
    w.document.body.appendChild(pre);
    w.focus();
    w.print();
  };

  const copy = async () => {
    if (text !== null) await navigator.clipboard.writeText(text);
  };

  return (
    <div data-blob-card={blob ? '' : undefined}>
      {title && <p className="font-black text-sm mb-1">{title}</p>}
      {blob ? (
        <p className="border-2 border-ink bg-sky/40 px-2 py-1 text-xs font-mono inline-block">
          📄 {blobName}（{(blob.size / 1024).toFixed(1)}KB{blob.type ? ` · ${blob.type}` : ''}）
          {isBlobRef(value) && !blobRec && ' · 已清理'}
        </p>
      ) : isTable ? (
        <TableView rows={value as Record<string, unknown>[]} />
      ) : (
        <pre className="border-2 border-ink/30 bg-paper px-2 py-1.5 text-xs font-mono whitespace-pre-wrap break-all max-h-80 overflow-auto">
          {format === 'text' || typeof value === 'string' ? String(value) : JSON.stringify(displayValue, null, 2)}
        </pre>
      )}
      {nestedBlobs.length > 0 && (
        <div className="mt-2 space-y-2">
          {nestedBlobs.map(([k, v]) => (
            <OutputRenderer key={k} value={v} blobs={blobs} name={k} />
          ))}
        </div>
      )}
      <div className="flex gap-1.5 mt-1.5">
        <NeoButton color="bg-sky" className="!px-2 !py-0.5 text-xs" onClick={download}>⬇ 下载</NeoButton>
        <NeoButton color="bg-white" className="!px-2 !py-0.5 text-xs" onClick={print}>🖨 打印</NeoButton>
        {text !== null && (
          <NeoButton color="bg-white" className="!px-2 !py-0.5 text-xs" onClick={() => void copy()}>⧉ 复制</NeoButton>
        )}
      </div>
    </div>
  );
}