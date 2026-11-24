# 可回收 · recycle.msqt.fun

WTOP 编排站（Host）——把纯前端工具（WTOP iframe RPC）与后端 HTTP 服务统一串成可视化流程自动执行。
纯前端 SPA，无后端，数据全部存浏览器 IndexedDB。neobrutalism UI。

设计依据：[`kit.msqt.fun`](https://github.com/msqtt/kit.msqt.fun) 文档集（协议 v0.5 / SDK v0.4 / Host v0.4）。
配套 SDK：[`wtop-sdk`](https://github.com/msqtt/wtop-sdk)。

## 技术栈

Vite + React 18 + TypeScript · Tailwind CSS v3（neobrutalism 主题）· @xyflow/react（流程画布）·
Zustand（运行态）· Dexie（IndexedDB）· ajv 2020（schema 校验）· JSONata（表达式）

## 快速开始

```bash
pnpm sync-sdk     # 从 ../wtop-sdk 构建并同步 vendor/wtop（首次必须）
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # 引擎测试 E1–E15
pnpm build        # tsc 类型检查 + 产物构建
```

本地联调示例工具：`../wtop-sdk/examples/demo-tool`（`pnpm dev`，端口 5180），
在「工具」页登记 `http://localhost:5180` 即可编排。

## 页面

| 路由 | 功能 |
|------|------|
| `/flows` | 流程列表：新建 / 复制 / 导入导出 JSON / 删除 |
| `/flows/:id` | 可视化编辑器：节点面板 + React Flow 画布 + 配置面板（schema 表单 / 常量·绑定切换）+ 校验 + 运行 |
| `/tools` | 工具注册中心：WTOP 工具（拉 manifest）/ HTTP 工具（endpoint 登记）/ 健康刷新 |
| `/run/:runId` | 运行看板：节点状态 / 进度 / 查看现场抽屉 / 人工审批 / 日志 / 取消；同路由复用为历史详情 |
| `/history` | 运行历史（保留策略自动清理） |
| `/settings` | 引擎参数 / env / HTTP 密钥 / 全量数据导入导出 |

## 架构

```
src/
  features/engine/    DSL 类型与 JSON Schema · JSONata 表达式 · 图校验 · DAG 调度引擎 · HTTP 节点
  features/editor/    流程编辑器（画布 + 配置面板）
  features/run/       运行看板 + 历史
  features/tools/     工具注册中心
  features/settings/  设置
  shared/             neobrutalism UI 组件 · schema 表单 · 运行态 store
  wtop/hostClient.ts  @wtop/host 单例（origin 白名单随工具表重建，运行中不重建）
  db/                 Dexie schema（tools/flows/runs/blobs/settings/secrets）+ 保留策略 + 备份
vendor/wtop/          SDK 构建产物（file: 依赖，scripts/sync-sdk.sh 同步）
```

关键实现说明：

- **固定 iframe 层**：`#wtop-layer` 由 hostClient 动态挂在 body 下，永远不在 React 树内；
  查看现场 = `host.show(callId, rect)` 把 iframe 定位到抽屉区域，不 reparent。
- **表达式**：`{{context.start.input.x}}` / `{{context.nodes.<id>.output.y}}` / `{{context.loop.item}}` /
  `{{context.env.*}}`，JSONata 求值；整串绑定保留原始类型，插值转字符串。
- **文件**：运行产物中的 Blob 落 `blobs` 表，context 快照只存 `{$blob: id}` 元数据。
- **测试别名**：vitest 直接跑 `../wtop-sdk` 源码（vite.config.ts test.alias），应用构建走 vendor 产物。

## 部署

静态托管 + SPA fallback。响应头建议（详见设计文档 Host §21）：

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline';
  frame-src https:; connect-src https:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'
Referrer-Policy: no-referrer
```

注：`'unsafe-eval'` 为 ajv 运行时编译 JSON Schema 所需（个人单用户站，权衡后接受）。

工具站需允许被本站 iframe 嵌入（`frame-ancestors https://recycle.msqt.fun`）并对 manifest 开 CORS。
### 线上部署（已配置）

- GitHub：`msqtt/recycle.msqt.fun`（public，Netlify 免部署密钥克隆）
- Netlify 站点：`recycle-msqt`（id `4934dfea-4b32-4303-b1ad-331cb3262846`）
- 域名：Cloudflare CNAME `recycle` → `recycle-msqt.netlify.app`（仅 DNS，不代理，TLS 由 Netlify 签发）
- 自动构建：GitHub Actions（`.github/workflows/deploy.yml`）push main → pnpm build → `scripts/netlify-deploy.mjs` 经 Netlify API 直传发布（账号未装 Netlify GitHub App，原生 git 联动不可用，故走 Actions）
- 线上地址：https://recycle.msqt.fun
