import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db';
import type { ToolRecord } from '../../db/types';
import { getHost, refreshHost } from '../../wtop/hostClient';
import { NeoButton, NeoCard, NeoBadge, NeoInput, NeoModal, PageTitle, Field } from '../../shared/ui';

function AddWtopModal({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [allowSameOrigin, setAllowSameOrigin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const host = await getHost();
      const entry = await host.registry.add(url.trim());
      const id = `tool_${entry.manifest.name}_${crypto.randomUUID().slice(0, 8)}`;
      const rec: ToolRecord = {
        id, type: 'wtop', url: entry.url,
        displayName: name.trim() || entry.manifest.displayName || entry.manifest.name,
        manifest: entry.manifest, manifestHash: entry.hash, version: entry.version,
        health: 'ok', origins: [new URL(entry.url).origin],
        allowSameOrigin, addedAt: Date.now(), updatedAt: Date.now(),
      };
      await db.tools.put(rec);
      await refreshHost();
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <NeoModal title="注册 WTOP 工具" onClose={onClose}>
      <Field label="工具站 URL" hint="将拉取 /.well-known/wtop-manifest.json（需 CORS 允许本站）">
        <NeoInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://tool-a.msqt.fun" />
      </Field>
      <Field label="显示名（可选）">
        <NeoInput value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 mb-3 text-sm font-bold">
        <input type="checkbox" checked={allowSameOrigin} onChange={(e) => setAllowSameOrigin(e.target.checked)} />
        允许 allow-same-origin（工具依赖自身 localStorage/IndexedDB 时勾选）
      </label>
      {error && <p className="text-sm text-punch font-bold mb-3 break-all">{error}</p>}
      <NeoButton onClick={submit} disabled={busy || !url.trim()}>{busy ? '拉取中…' : '注册'}</NeoButton>
      <p className="mt-3 text-xs text-ink/60">
        工具站需配置：CSP frame-ancestors 含本站 origin；manifest 文件 Access-Control-Allow-Origin。
      </p>
    </NeoModal>
  );
}

function ToolDetail({ tool, onClose }: { tool: ToolRecord; onClose: () => void }) {
  return (
    <NeoModal title={tool.displayName} onClose={onClose} wide>
      <p className="font-mono text-sm mb-2 break-all">{tool.url}</p>
      <div className="flex gap-2 mb-4">
        <NeoBadge tone={tool.type}>{tool.type}</NeoBadge>
        <NeoBadge tone={tool.health}>{tool.health}</NeoBadge>
        {tool.version && <NeoBadge>v{tool.version}</NeoBadge>}
      </div>
      {tool.manifest && (
        <div>
          <h3 className="font-bold uppercase mb-2">方法</h3>
          {tool.manifest.methods.map((m) => (
            <NeoCard key={m.name} className="mb-3" color="bg-paper">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-bold font-mono">{m.name}</span>
                <NeoBadge tone="">{m.mode ?? 'hybrid'}</NeoBadge>
                {m.stateless && <NeoBadge tone="ok">stateless</NeoBadge>}
                <span className="text-xs">{m.displayName}</span>
              </div>
              <details>
                <summary className="text-xs font-bold cursor-pointer">input / output schema</summary>
                <pre className="text-xs font-mono overflow-auto mt-1 bg-white border-2 border-ink/20 p-2">
                  {JSON.stringify({ input: m.input, output: m.output }, null, 2)}
                </pre>
              </details>
            </NeoCard>
          ))}
        </div>
      )}
      {tool.http && (
        <div>
          <h3 className="font-bold uppercase mb-2">Endpoints</h3>
          {tool.http.endpoints.map((ep) => (
            <NeoCard key={ep.name} className="mb-3" color="bg-paper">
              <span className="font-bold font-mono">{ep.method} {ep.path}</span>
              <span className="ml-2 text-sm">{ep.displayName}（{ep.name}）</span>
            </NeoCard>
          ))}
        </div>
      )}
    </NeoModal>
  );
}

export function ToolsPage() {
  const tools = useLiveQuery(() => db.tools.orderBy('updatedAt').reverse().toArray(), []) ?? [];
  const [modal, setModal] = useState<'wtop' | null>(null);
  const [detail, setDetail] = useState<ToolRecord | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const refresh = async (t: ToolRecord) => {
    setRefreshing(t.id);
    try {
      const host = await getHost();
      const entry = await host.registry.refresh(t.url);
      await db.tools.update(t.id, {
        manifest: entry.manifest, manifestHash: entry.hash, version: entry.version,
        health: 'ok', updatedAt: Date.now(),
      });
    } catch {
      await db.tools.update(t.id, { health: 'unreachable', updatedAt: Date.now() });
    } finally {
      setRefreshing(null);
    }
  };

  const remove = async (t: ToolRecord) => {
    if (!confirm(`删除工具「${t.displayName}」？`)) return;
    await db.tools.delete(t.id);
    await db.secrets.where('toolId').equals(t.id).delete();
    await refreshHost();
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageTitle sub="WTOP 工具站注册中心；HTTP 请求直接在流程的 HTTP 节点配置，无需注册">工具库</PageTitle>
      <div className="flex gap-3 mb-6">
        <NeoButton color="bg-sky" onClick={() => setModal('wtop')}>+ WTOP 工具</NeoButton>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {tools.map((t) => (
          <NeoCard key={t.id}>
            <div className="flex items-start justify-between mb-2">
              <h3 className="font-bold text-lg">{t.displayName}</h3>
              <NeoBadge tone={t.type}>{t.type}</NeoBadge>
            </div>
            <p className="font-mono text-xs break-all mb-2 text-ink/70">{t.url}</p>
            <div className="flex gap-2 mb-3">
              <NeoBadge tone={t.health}>{t.health}</NeoBadge>
              {t.version && <NeoBadge>v{t.version}</NeoBadge>}
              <NeoBadge>
                {t.type === 'wtop' ? `${t.manifest?.methods.length ?? 0} 方法` : `${t.http?.endpoints.length ?? 0} endpoint`}
              </NeoBadge>
            </div>
            <div className="flex gap-2 flex-wrap">
              <NeoButton className="text-xs px-2 py-1" onClick={() => setDetail(t)}>详情</NeoButton>
              {t.type === 'wtop' && (
                <NeoButton className="text-xs px-2 py-1" color="bg-lime" disabled={refreshing === t.id} onClick={() => refresh(t)}>
                  {refreshing === t.id ? '刷新中' : '刷新'}
                </NeoButton>
              )}
              <NeoButton className="text-xs px-2 py-1" color="bg-punch" onClick={() => remove(t)}>删除</NeoButton>
            </div>
          </NeoCard>
        ))}
        {tools.length === 0 && (
          <NeoCard color="bg-lemon" className="md:col-span-2 xl:col-span-3">
            <p className="font-bold">还没有工具。预置工具站会自动添加；也可注册自己的 WTOP 工具站。</p>
          </NeoCard>
        )}
      </div>
      {modal === 'wtop' && <AddWtopModal onClose={() => setModal(null)} />}
      {detail && <ToolDetail tool={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}