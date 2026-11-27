import { createHost, type Host, type RegistryEntry } from '@wtop/host';
import { db, loadSettings } from '../db';
import type { ToolRecord } from '../db/types';

let host: Host | null = null;
let originsKey = '';
const activeCallIds = new Set<string>();

function layerRoot(): HTMLElement {
  let el = document.getElementById('wtop-layer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wtop-layer';
    document.body.appendChild(el);
  }
  return el;
}

export async function getHost(extraTools: ToolRecord[] = []): Promise<Host> {
  // 快调用可能在 IDB 读取完成前就 finalize，show 必须同步拿到 host 才能赶上保活窗口
  if (host && extraTools.length === 0 && activeCallIds.size > 0) return host;
  const registered = await db.tools.where('type').equals('wtop').toArray();
  // bundle 临时工具：不写库，仅并入白名单与注册表
  const tools = [
    ...registered,
    ...extraTools.filter((t) => t.type === 'wtop' && !registered.some((x) => x.url === t.url)),
  ];
  const origins = [...new Set(tools.map((t) => new URL(t.url).origin))].sort();
  const key = origins.join('|');
  if (host && key === originsKey) return host;
  if (host && activeCallIds.size > 0) return host; // 运行中不重建，避免销毁 iframe
  host?.dispose();
  const settings = await loadSettings();
  host = createHost({
    allowedOrigins: origins,
    layerRoot: layerRoot(),
    maxConcurrent: settings.maxConcurrent,
    defaultTimeoutMs: settings.defaultTimeoutMs,
    humanTimeoutMs: settings.humanTimeoutMs,
    preserveFailedMs: settings.preserveFailedMs,
    largeFileThresholdBytes: settings.maxFileMB * 1024 * 1024,
  });
  originsKey = key;
  const entries: RegistryEntry[] = tools
    .filter((t) => t.manifest && t.manifestHash)
    .map((t) => ({
      url: t.url.replace(/\/+$/, ''), manifest: t.manifest!, hash: t.manifestHash!,
      version: t.manifest!.version, health: t.health === 'unknown' ? 'unknown' : t.health,
      addedAt: t.addedAt, updatedAt: t.updatedAt,
    }));
  host.registry.import(entries);
  host.on('call:state', (p) => {
    const { callId, state } = p as { callId: string; state: string };
    if (['succeeded', 'failed', 'cancelled', 'destroyed'].includes(state)) activeCallIds.delete(callId);
    else activeCallIds.add(callId);
  });
  return host;
}

/** 工具增删后调用：空闲时重建 host 以更新 origin 白名单 */
export async function refreshHost(): Promise<void> {
  originsKey = '';
  await getHost();
}

export async function syncToolHealth(url: string, health: ToolRecord['health']): Promise<void> {
  const tool = await db.tools.where('url').equals(url).first();
  if (tool) await db.tools.update(tool.id, { health, updatedAt: Date.now() });
}