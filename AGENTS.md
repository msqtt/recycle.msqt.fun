# 项目约定

## 仓库性质
- 可回收（recycle.msqt.fun）：WTOP 编排站 Host，纯前端 SPA，neobrutalism UI。
- 设计依据：`../kit.msqt.fun` 文档集；配套 SDK：`../wtop-sdk`。
- 远程仓库：https://github.com/msqtt/recycle.msqt.fun（账号 msqtt，私有）。

## 推送方式
- git 未持久化凭据助手，推送用 gh 凭据助手（临时 `-c`，不改全局配置）：
  `git -c credential.helper='!gh auth git-credential' push origin main`
- 默认分支 main，提交信息用中文。
- 推送前需本地验证通过（pnpm test + pnpm build + Chrome 验证），用户已授权验证通过后推送。

## 工程约定
- SDK 以构建产物 vendored 进 `vendor/wtop/`（file: 依赖）；改 SDK 后先 `pnpm sync-sdk` 再 install。
  vendor 产物入库（离线可构建），但不要手改 vendor 内容。
- vitest 通过 test.alias 直接跑 `../wtop-sdk` 源码；引擎测试在 `test/`（E1–E15）。
- 安全不变量：iframe 固定层不 reparent、不用 display:none 隐藏；sandbox 默认 opaque origin，
  allow-same-origin 仅按工具登记开启；密钥只存本机 IndexedDB。
- UI 一律走 `src/shared/ui.tsx` 的 Neo* 组件与 tailwind.config.js 主题色，保持 neobrutalism 风格。
- 表达式/绑定语法：`{{context.*}}`（JSONata）；HTTP headers 密钥引用 `{{secret:名称}}`。