import { db } from '../db';
import type { FlowRecord } from '../db/types';
import type { DSL } from '../features/engine/dsl';

export const SAMPLE_DESCRIPTIONS: Record<string, string> = {
  'sample-text-clean': '多行文本逐行裁剪 → 去空行 → 去重 → 排序，一键整理清单类数据',
  'sample-text-mask': '正则批量打码手机号与邮箱，粘贴通讯录即可脱敏',
  'sample-image-publish': '缩放到 1280 宽 → 加水印 → 转 WebP，产出可直接发布的图片',
  'sample-data-sales': 'CSV 解析入库（按 id 幂等）→ 金额排序查询 → 函数汇总总额/分区统计',
  'sample-video-gif': '截取前 3 秒转 320 宽 GIF，产出可直接分享的小动图',
};

const dsl = (id: string, name: string, nodes: DSL['nodes'], edges: DSL['edges']): DSL => ({ id, name, version: 1, nodes, edges });
const chain = (...ids: string[]) => ids.slice(0, -1).map((from, i) => ({ from, to: ids[i + 1] }));

const FLOWS: DSL[] = [
  dsl('sample-text-clean', '文本清洗与去重排序', [
    { id: 'start', type: 'start', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string', title: '原始文本', default: 'banana\n apple\nbanana\ncherry\n apple\n' } } }, x: 40, y: 120 },
    { id: 'trim', type: 'call-wtop', toolId: 'official-text', method: 'trim', inputMapping: { text: '{{context.start.input.text}}', mode: 'lines' }, x: 300, y: 120 },
    { id: 'blank', type: 'call-wtop', toolId: 'official-text', method: 'trim', inputMapping: { text: '{{context.nodes.trim.output.result}}', mode: 'blank' }, x: 560, y: 120 },
    { id: 'dedupe', type: 'call-wtop', toolId: 'official-text', method: 'lines', inputMapping: { text: '{{context.nodes.blank.output.result}}', op: 'dedupe' }, x: 820, y: 120 },
    { id: 'sort', type: 'call-wtop', toolId: 'official-text', method: 'lines', inputMapping: { text: '{{context.nodes.dedupe.output.result}}', op: 'sort' }, x: 1080, y: 120 },
    { id: 'out', type: 'output', value: '{{context.nodes.sort.output.result}}', title: '清洗结果', format: 'text', filename: 'clean.txt', mime: 'text/plain', x: 1340, y: 120 },
    { id: 'end', type: 'end', outputMapping: { result: '{{context.nodes.sort.output.result}}' }, x: 1600, y: 120 },
  ], chain('start', 'trim', 'blank', 'dedupe', 'sort', 'out', 'end')),

  dsl('sample-text-mask', '手机号与邮箱脱敏', [
    { id: 'start', type: 'start', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string', title: '含敏感信息的文本', default: '联系 13812345678 或 15900001111，邮箱 alice@example.com / bob.smith@mail.co。' } } }, x: 40, y: 120 },
    { id: 'phone', type: 'call-wtop', toolId: 'official-text', method: 'replace', inputMapping: { text: '{{context.start.input.text}}', query: '(1[3-9]\\d)\\d{4}(\\d{4})', replacement: '$1****$2', regex: true, all: true }, x: 300, y: 120 },
    { id: 'email', type: 'call-wtop', toolId: 'official-text', method: 'replace', inputMapping: { text: '{{context.nodes.phone.output.result}}', query: '([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+)', replacement: '$1***@$2', regex: true, all: true }, x: 560, y: 120 },
    { id: 'out', type: 'output', value: '{{context.nodes.email.output.result}}', title: '脱敏结果', format: 'text', filename: 'masked.txt', mime: 'text/plain', x: 820, y: 120 },
    { id: 'end', type: 'end', outputMapping: { result: '{{context.nodes.email.output.result}}' }, x: 1080, y: 120 },
  ], chain('start', 'phone', 'email', 'out', 'end')),

  dsl('sample-image-publish', '图片缩放加水印转 WebP', [
    { id: 'start', type: 'start', inputSchema: { type: 'object', required: ['image'], properties: { image: { type: 'string', format: 'wtop-file', title: '原始图片' } } }, x: 40, y: 120 },
    { id: 'resize', type: 'call-wtop', toolId: 'official-image', method: 'resize', inputMapping: { image: '{{context.start.input.image}}', width: 1280, fit: 'contain' }, x: 300, y: 120 },
    { id: 'mark', type: 'call-wtop', toolId: 'official-image', method: 'watermark', inputMapping: { image: '{{context.nodes.resize.output.image}}', text: '© recycle.msqt.fun', position: 'bottomRight', fontSize: 28, color: '#ffffff', opacity: 0.55, margin: 16 }, x: 560, y: 120 },
    { id: 'webp', type: 'call-wtop', toolId: 'official-image', method: 'convert', inputMapping: { image: '{{context.nodes.mark.output.image}}', format: 'webp', quality: 0.82 }, x: 820, y: 120 },
    { id: 'out', type: 'output', value: '{{context.nodes.webp.output.image}}', title: '发布图', filename: 'publish.webp', mime: 'image/webp', x: 1080, y: 120 },
    { id: 'end', type: 'end', outputMapping: { image: '{{context.nodes.webp.output.image}}' }, x: 1340, y: 120 },
  ], chain('start', 'resize', 'mark', 'webp', 'out', 'end')),

  dsl('sample-data-sales', 'CSV 入库与销售统计', [
    { id: 'start', type: 'start', inputSchema: { type: 'object', required: ['csv'], properties: { csv: { type: 'string', title: '销售 CSV', default: 'id,name,amount,region\nS001,机械键盘,299,华东\nS002,显示器,1299,华北\nS003,鼠标,99,华东\nS004,笔记本,4999,华南\nS005,耳机,199,华北' } } }, x: 40, y: 120 },
    { id: 'parse', type: 'call-wtop', toolId: 'official-data', method: 'csvParse', inputMapping: { csv: '{{context.start.input.csv}}' }, x: 300, y: 120 },
    { id: 'put', type: 'call-wtop', toolId: 'official-data', method: 'put', inputMapping: { collection: 'demo_sales', records: '{{context.nodes.parse.output.records}}', idField: 'id', mode: 'upsert' }, x: 560, y: 120 },
    { id: 'q', type: 'call-wtop', toolId: 'official-data', method: 'query', inputMapping: { collection: 'demo_sales', sort: 'amount', order: 'desc', limit: 100 }, x: 820, y: 120 },
    { id: 'stats', type: 'function', inputMapping: { records: '{{context.nodes.q.output.records}}' }, code: 'const rows = inputs.records ?? [];\nconst total = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);\nconst byRegion = {};\nfor (const r of rows) {\n  const k = r.region ?? "未知";\n  byRegion[k] = (byRegion[k] ?? 0) + Number(r.amount ?? 0);\n}\nreturn { total, count: rows.length, byRegion, top: rows[0] ?? null };', timeoutMs: 30000, x: 1080, y: 120 },
    { id: 'out', type: 'output', value: '{{context.nodes.stats.output}}', title: '销售统计', format: 'json', x: 1340, y: 120 },
    { id: 'end', type: 'end', outputMapping: { stats: '{{context.nodes.stats.output}}', rows: '{{context.nodes.q.output.total}}' }, x: 1600, y: 120 },
  ], chain('start', 'parse', 'put', 'q', 'stats', 'out', 'end')),

  dsl('sample-video-gif', '视频转 GIF 分享', [
    { id: 'start', type: 'start', inputSchema: { type: 'object', required: ['video'], properties: { video: { type: 'string', format: 'wtop-file', title: '视频文件' } } }, x: 40, y: 120 },
    { id: 'gif', type: 'call-wtop', toolId: 'official-video', method: 'gif', timeoutMs: 600000, inputMapping: { video: '{{context.start.input.video}}', duration: 3, fps: 8, width: 320 }, x: 300, y: 120 },
    { id: 'out', type: 'output', value: '{{context.nodes.gif.output.image}}', title: 'GIF 预览', filename: 'share.gif', mime: 'image/gif', x: 560, y: 120 },
    { id: 'end', type: 'end', outputMapping: { image: '{{context.nodes.gif.output.image}}' }, x: 820, y: 120 },
  ], chain('start', 'gif', 'out', 'end')),
];

/** 首次启动预置示范流程（只种一次，用户删除后不复活） */
export async function seedSampleFlows(): Promise<void> {
  if (await db.settings.get('sampleFlowsSeeded')) return;
  await db.settings.put({ key: 'sampleFlowsSeeded', value: true });
  const now = Date.now();
  for (const d of FLOWS) {
    if (await db.flows.get(d.id)) continue;
    const rec: FlowRecord = { id: d.id, name: d.name, version: 1, dsl: d, createdAt: now, updatedAt: now };
    await db.flows.put(rec);
  }
}