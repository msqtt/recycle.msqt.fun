import Dexie, { type Table } from 'dexie';
import type {
  ToolRecord, FlowRecord, RunRecord, BlobRecord, SettingRecord, SecretRecord, AppSettings,
} from './types';
import { DEFAULT_SETTINGS } from './types';

export class RecycleDB extends Dexie {
  tools!: Table<ToolRecord, string>;
  flows!: Table<FlowRecord, string>;
  runs!: Table<RunRecord, string>;
  blobs!: Table<BlobRecord, string>;
  settings!: Table<SettingRecord, string>;
  secrets!: Table<SecretRecord, string>;

  constructor(name = 'recycle-msqt-fun') {
    super(name);
    this.version(1).stores({
      tools: 'id, type, url, updatedAt',
      flows: 'id, name, updatedAt',
      runs: 'id, flowId, status, startedAt',
      blobs: 'id, runId',
      settings: 'key',
      secrets: 'id, toolId',
    });
  }
}

export const db = new RecycleDB();

export async function loadSettings(): Promise<AppSettings> {
  const rec = await db.settings.get('app');
  return { ...DEFAULT_SETTINGS, ...(rec?.value as Partial<AppSettings> ?? {}) };
}

export async function saveSettings(s: AppSettings): Promise<void> {
  await db.settings.put({ key: 'app', value: s });
}

/** 保留策略：runs 超条数/天数自动清理，级联删 blobs */
export async function applyRetention(s: AppSettings): Promise<void> {
  const cutoff = Date.now() - s.retentionDays * 86400_000;
  const old = await db.runs.where('startedAt').below(cutoff).toArray();
  const all = await db.runs.orderBy('startedAt').reverse().toArray();
  const excess = all.slice(s.retentionRuns);
  const ids = new Set([...old, ...excess].map((r) => r.id));
  for (const id of ids) {
    await db.blobs.where('runId').equals(id).delete();
    await db.runs.delete(id);
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export async function exportAll(): Promise<string> {
  const [tools, flows, runs, settings, secrets, blobs] = await Promise.all([
    db.tools.toArray(), db.flows.toArray(), db.runs.toArray(),
    db.settings.toArray(), db.secrets.toArray(), db.blobs.toArray(),
  ]);
  const blobData = await Promise.all(blobs.map(async (b) => ({
    id: b.id, runId: b.runId, nodeId: b.nodeId, name: b.name, mime: b.mime, size: b.size,
    base64: await blobToBase64(b.data),
  })));
  return JSON.stringify({ version: 1, exportedAt: Date.now(), tools, flows, runs, settings, secrets, blobs: blobData });
}

export async function importAll(json: string): Promise<void> {
  const data = JSON.parse(json);
  if (data.version !== 1) throw new Error('不支持的导出格式版本');
  await db.transaction('rw', [db.tools, db.flows, db.runs, db.settings, db.secrets, db.blobs], async () => {
    await db.tools.bulkPut(data.tools ?? []);
    await db.flows.bulkPut(data.flows ?? []);
    await db.runs.bulkPut(data.runs ?? []);
    await db.settings.bulkPut(data.settings ?? []);
    await db.secrets.bulkPut(data.secrets ?? []);
    for (const b of data.blobs ?? []) {
      await db.blobs.put({ ...b, data: base64ToBlob(b.base64, b.mime), base64: undefined });
    }
  });
}