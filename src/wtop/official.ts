import { db } from '../db';
import type { ToolRecord } from '../db/types';
import { getHost } from './hostClient';

const OFFICIAL_SITES = [
  { id: 'official-text', name: '文本处理', prod: 'https://text.msqt.fun', devPort: 5181, allowSameOrigin: false },
  { id: 'official-image', name: '图像处理', prod: 'https://image.msqt.fun', devPort: 5182, allowSameOrigin: false },
  { id: 'official-video', name: '视频处理', prod: 'https://video.msqt.fun', devPort: 5183, allowSameOrigin: true },
  { id: 'official-data', name: '数据仓库', prod: 'https://data.msqt.fun', devPort: 5184, allowSameOrigin: true },
];

const LEGACY_RENAMES: Record<string, string> = { 文本工坊: '文本处理', 图像工坊: '图像处理', 视频工坊: '视频处理' };

/** 首次启动预置官方工具（只种一次，用户删除后不复活）；缺 manifest 的每次启动补拉 */
export async function seedOfficialTools(): Promise<void> {
  if (!(await db.settings.get('officialSeeded'))) {
    await db.settings.put({ key: 'officialSeeded', value: true });
    const now = Date.now();
    for (const s of OFFICIAL_SITES) {
      if (await db.tools.get(s.id)) continue;
      const url = import.meta.env.DEV ? `http://localhost:${s.devPort}` : s.prod;
      const rec: ToolRecord = {
        id: s.id, type: 'wtop', url,
        displayName: s.name,
        health: 'unknown', origins: [new URL(url).origin],
        allowSameOrigin: s.allowSameOrigin, addedAt: now, updatedAt: now,
      };
      await db.tools.put(rec);
    }
  }
  // 种子只跑一次，存量旧名（含（官方）后缀）在此迁移；自定义名不触碰
  for (const s of OFFICIAL_SITES) {
    const rec = await db.tools.get(s.id);
    if (!rec) continue;
    const base = rec.displayName.replace(/（官方）$/, '');
    const next = LEGACY_RENAMES[base] ?? base;
    if (next !== rec.displayName) await db.tools.update(s.id, { displayName: next, updatedAt: Date.now() });
  }
  void refreshOfficialManifests();
}

async function refreshOfficialManifests(): Promise<void> {
  const host = await getHost();
  const officials = await db.tools.toArray();
  for (const t of officials.filter((x) => x.id.startsWith('official-') && !x.manifest)) {
    try {
      const entry = await host.registry.refresh(t.url);
      await db.tools.update(t.id, {
        manifest: entry.manifest, manifestHash: entry.hash, version: entry.version,
        health: 'ok', updatedAt: Date.now(),
      });
    } catch {
      await db.tools.update(t.id, { health: 'unreachable', updatedAt: Date.now() });
    }
  }
}