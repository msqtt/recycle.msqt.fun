import { db } from '../db';
import type { ToolRecord } from '../db/types';
import { getHost } from './hostClient';

const OFFICIAL_SITES = [
  { id: 'official-text', name: '文本工坊', prod: 'https://text.msqt.fun', devPort: 5181, allowSameOrigin: false },
  { id: 'official-image', name: '图像工坊', prod: 'https://image.msqt.fun', devPort: 5182, allowSameOrigin: false },
  { id: 'official-video', name: '视频工坊', prod: 'https://video.msqt.fun', devPort: 5183, allowSameOrigin: true },
  { id: 'official-data', name: '数据仓库', prod: 'https://data.msqt.fun', devPort: 5184, allowSameOrigin: true },
];

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
        displayName: `${s.name}（官方）`,
        health: 'unknown', origins: [new URL(url).origin],
        allowSameOrigin: s.allowSameOrigin, addedAt: now, updatedAt: now,
      };
      await db.tools.put(rec);
    }
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