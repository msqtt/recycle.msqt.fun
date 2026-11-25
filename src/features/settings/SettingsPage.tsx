import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, loadSettings, saveSettings, exportAll, importAll } from '../../db';
import { DEFAULT_SETTINGS, type AppSettings } from '../../db/types';
import { refreshHost } from '../../wtop/hostClient';
import { NeoButton, NeoCard, NeoInput, PageTitle, Field } from '../../shared/ui';
import { CodeField } from '../../shared/code-field';

const NUM_FIELDS: { key: keyof AppSettings; label: string; hint: string }[] = [
  { key: 'maxConcurrent', label: 'WTOP 最大并发', hint: '超出的调用排队（FIFO）' },
  { key: 'httpConcurrency', label: 'HTTP 并发上限', hint: 'call-http 节点并发' },
  { key: 'defaultTimeoutMs', label: '默认执行超时 ms', hint: '节点未单独设置时生效' },
  { key: 'humanTimeoutMs', label: '人工等待超时 ms', hint: 'requestHuman / approval 独立计时' },
  { key: 'preserveFailedMs', label: '失败现场保留 ms', hint: '失败后 iframe 限期保留供查看' },
  { key: 'retentionRuns', label: '历史保留条数', hint: '超出自动清理最旧记录' },
  { key: 'retentionDays', label: '历史保留天数', hint: '超期自动清理' },
  { key: 'maxFileMB', label: '文件输入上限 MB', hint: 'WTOP 调用输入文件大小限制（输出不限）' },
];

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [envText, setEnvText] = useState('{}');
  const [envErr, setEnvErr] = useState('');
  const tools = useLiveQuery(() => db.tools.toArray(), []) ?? [];
  const secrets = useLiveQuery(() => db.secrets.toArray(), []) ?? [];
  const [secName, setSecName] = useState('');
  const [secValue, setSecValue] = useState('');
  const [importErr, setImportErr] = useState('');

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setEnvText(JSON.stringify(s.env, null, 2));
    });
  }, []);

  const save = async () => {
    let env: Record<string, string>;
    try {
      env = JSON.parse(envText);
      setEnvErr('');
    } catch {
      setEnvErr('env 不是合法 JSON');
      return;
    }
    const next = { ...settings, env };
    await saveSettings(next);
    setSettings(next);
    await refreshHost();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const addSecret = async () => {
    if (!secName || !secValue) return;
    await db.secrets.put({ id: `:${secName}`, toolId: '', name: secName, value: secValue });
    setSecName('');
    setSecValue('');
  };

  const doExport = async () => {
    const json = await exportAll();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `recycle-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doImport = async (file: File) => {
    try {
      await importAll(await file.text());
      await refreshHost();
      setImportErr('');
      alert('导入完成');
    } catch (e) {
      setImportErr(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageTitle sub="全部数据仅存于本机浏览器 IndexedDB">设置</PageTitle>

      <NeoCard className="mb-6" color="bg-white">
        <h2 className="font-black uppercase mb-4 bg-lemon inline-block border-2 border-ink px-2">引擎参数</h2>
        <div className="grid md:grid-cols-2 gap-x-6">
          {NUM_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <NeoInput
                type="number"
                value={settings[f.key] as number}
                onChange={(e) => setSettings({ ...settings, [f.key]: Number(e.target.value) || 0 })}
              />
            </Field>
          ))}
        </div>
        <Field label="环境变量 env（JSON，表达式 context.env.* 可用）" hint={envErr || undefined}>
          <CodeField value={envText} language="json" rows={5} error={!!envErr} onChange={setEnvText} />
        </Field>
        <div className="flex items-center gap-3">
          <NeoButton color="bg-lime" onClick={save}>保存设置</NeoButton>
          {saved && <span className="font-bold text-sm bg-lime border-2 border-ink px-2">✓ 已保存</span>}
        </div>
      </NeoCard>

      <NeoCard className="mb-6" color="bg-white">
        <h2 className="font-black uppercase mb-2 bg-grape inline-block border-2 border-ink px-2">HTTP 密钥</h2>
        <p className="text-xs font-mono opacity-60 mb-4">HTTP 节点 headers 中用 {'{{secret:名称}}'} 引用（全局按名称）；明文存于本机 IndexedDB，勿存高敏凭据</p>
        <div className="flex gap-2 mb-4 flex-wrap">
          <NeoInput placeholder="名称" value={secName} onChange={(e) => setSecName(e.target.value)} className="!w-36" />
          <NeoInput placeholder="值" type="password" value={secValue} onChange={(e) => setSecValue(e.target.value)} className="!w-48" />
          <NeoButton color="bg-lemon" onClick={addSecret}>添加</NeoButton>
        </div>
        <div className="space-y-2">
          {secrets.map((s) => (
            <div key={s.id} className="flex items-center gap-2 border-2 border-ink px-3 py-1.5 text-sm">
              <span className="font-mono font-bold">{s.name}</span>
              {s.toolId && <span className="text-xs opacity-60">{tools.find((t) => t.id === s.toolId)?.displayName ?? s.toolId}</span>}
              <span className="font-mono opacity-50">••••••</span>
              <div className="flex-1" />
              <NeoButton color="bg-punch" className="!px-2 !py-0.5 text-xs" onClick={() => void db.secrets.delete(s.id)}>删除</NeoButton>
            </div>
          ))}
          {secrets.length === 0 && <p className="text-xs font-mono opacity-50">暂无密钥</p>}
        </div>
      </NeoCard>

      <NeoCard color="bg-white">
        <h2 className="font-black uppercase mb-4 bg-sky inline-block border-2 border-ink px-2">数据备份</h2>
        <div className="flex gap-3 items-center flex-wrap">
          <NeoButton color="bg-sky" onClick={doExport}>导出全部数据</NeoButton>
          <label className="border-2 border-ink bg-white px-4 py-1.5 font-bold shadow-neo-sm hover:shadow-none cursor-pointer">
            导入备份
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); }}
            />
          </label>
          {importErr && <span className="text-xs font-mono text-punch">{importErr}</span>}
        </div>
        <p className="text-xs font-mono opacity-60 mt-3">含工具 / 流程 / 历史 / 产物 / 设置 / 密钥；导入为覆盖合并</p>
      </NeoCard>
    </div>
  );
}