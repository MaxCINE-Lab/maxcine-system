# MaxCINE Platform

MaxCINE 官网与渠道业务系统第一版。它提供一个适合 Cloudflare Pages 的 React 前端，以及一个运行在 Cloudflare Workers 上、使用 D1 与 R2 绑定的 API。此仓库不包含生产凭据、真实客户资料、DNS 变更或部署配置。

## 技术栈

- **Web：** React 19、TypeScript、Vite。静态产物可直接部署到 Cloudflare Pages。
- **API：** Hono + Cloudflare Workers。体积小，原生兼容 Workers Web API。
- **数据：** Cloudflare D1（SQLite），迁移文件位于 `apps/api/migrations`。
- **文件：** Cloudflare R2 绑定已预留为 `ASSETS`；正式产品图、下载包需通过受控上传流程接入。
- **校验与测试：** Zod、ESLint、TypeScript project references、Vitest。

## 目录结构

```text
apps/
  web/                 官网与内部系统（Cloudflare Pages）
  api/                 Workers API、D1 迁移和邮件适配层
packages/shared/       共享类型、输入校验、权限策略、API 错误类型
tests/                 权限越权和密码校验测试
docs/DATABASE.md       D1 数据模型与业务不变量
```

## 本地启动

需要 Node.js 24+ 和 npm 11+。

```bash
npm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
npm run db:apply:local
npm run db:seed:local
npm run dev
```

`npm run dev` 固定使用 Web `http://localhost:5173` 与 API `http://localhost:8787`，并显示本地 D1 路径 `apps/api/.wrangler/state/v3/d1`。启动前会检测端口；如端口已被占用会给出中文提示，不会偷偷切换端口或终止不明进程。使用以下命令查看或停止**由该脚本启动**的服务：

```bash
npm run dev:status
npm run dev:stop
```

Vite 会把 `/api` 代理到 `http://localhost:8787`。演示数据只用于隔离的本地数据库；本地开发账户的初始化说明仅保留在受控开发流程中，绝不可在共享环境、预发布环境或生产环境应用该种子数据。

本地浏览器始终访问 `http://localhost:5173`，不要直接在页面中使用 Worker 的 `8787` 端口；开发代理会去除 `/api` 前缀并转发请求。登录密码最少 8 位；真实账户与密码不得加入本地种子数据。

## 环境变量

仅将本地值写入 `apps/api/.dev.vars`，不要提交该文件。本地默认使用 `mock` 邮件模式，报价发送会明确记录为失败，不会伪装投递成功。只有人工把 provider 改为 `resend` 并通过 secret 配置密钥后，系统才会尝试真实投递。

| 变量 | 用途 | 必需 |
| --- | --- | --- |
| `SESSION_SECRET` | 会话 HMAC 密钥；使用长度至少 32 的随机值 | 是 |
| `APP_ORIGIN` | 允许的前端来源，开发时为 `http://localhost:5173` | 是 |
| `EMAIL_PROVIDER` | `mock`（不发送）或 `resend`（调用真实 provider） | 否 |
| `RESEND_API_KEY` | Resend 密钥；仅在 `EMAIL_PROVIDER=resend` 时需要，必须使用 secret | 条件必需 |
| `NOTIFICATION_EMAIL_FROM` | 报价自动邮件发件地址，默认 `notification@maxcine.cn` | 否 |
| `NOTIFICATION_EMAIL_NAME` | 报价自动邮件发件名称，默认 `MaxCINE 通知中心` | 否 |
| `SUPPORT_EMAIL_REPLY_TO` | 客户回复地址，默认 `support@maxcine.cn` | 否 |
| `SUPPORT_EMAIL_REPLY_TO_NAME` | 客户回复名称，默认 `MaxCINE 客户支持` | 否 |
| `VITE_API_BASE_URL` | 可选 API 基础地址；同源路由时留空 | 否 |

Cloudflare 的 D1、R2 和机密变量应通过 Dashboard 或 `wrangler secret put` 为**测试环境**配置；不得写入仓库。

## D1 迁移和 R2

本地 D1：`npm run db:apply:local`，然后可用 `npm run db:seed:local`。演示数据位于 `apps/api/seed/`，故不会随生产迁移执行。远程测试库应先创建独立、免费的测试 D1 数据库，再把实际 `database_id` 填入一个不提交的测试 Wrangler 配置；运行 `wrangler d1 migrations apply <测试库名> --remote` 前需人工确认目标。

`apps/api/wrangler.toml` 中的 D1 ID 与 R2 bucket 名称均为占位符。R2 仅用于产品图、下载资料等非敏感资产；上传必须校验 MIME、大小、对象键命名和授权。请勿使用公共 bucket 存放订单导出或客户材料。

## 经销商业务系统（本地第一版）

已接入本地 D1 的经销商页面包括：仪表盘、共享库存、库存详情、授权店铺、新建订单、草稿编辑、订单筛选/分页/详情、站内通知及已读状态、售后工单列表/详情/新建申请。后端根据用户 ID 的角色、权限、店铺授权及服务中心授权强制数据隔离；不以姓名或邮箱判断权限。

本地种子数据包括功能邮箱、六个指定演示账户、经销商、授权服务中心和店铺归属。报价自动邮件固定使用 `notification@maxcine.cn`，客户回复进入 `support@maxcine.cn`。所有邮箱均以小写保存和显示；种子不含真实密码、手机号、身份证号、地址或客户资料。产品示例为 W101、W102、W103、W124 四个 MaxCINE MAVIC 4 Pro 增广镜套装，仅用于本机验证。

## GSX 资产与保修中心（本地第一版）

超级管理员可在“资产与保修 → 历史数据导入”上传历史保修 `.xlsx`，系统会先预检查、展示每行的警告或错误，再由人工确认导入。预检查不创建资产。相同文件可安全地重复预检查或确认；导入键由文件指纹和源文件行号组成，不会重复生成资产、事件或备注。

导入文件必须保留现有列标题：`序号`、`销售渠道`、`版本`、`购买日期`、`购买价格`、`SN`、`保修状态`、`发出单号`、`发货仓库`、`用户画像`、`到账状态`、`保修开始`、`保修结束`、`维修记录1～4`、`备注1～5`。上传前请脱敏；原始行快照只保存于 D1 以供超级管理员追溯，绝不提交到 Git。

GSX 支持以当前 SN、原 SN/旧标签、错误标签、顺丰单号、订单号或工单号查询。资产详情显示生命周期、保修与售后、标识历史、订单与物流、内部备注和审计记录。完整字段映射、权限范围及 ER 图见 [docs/DATABASE.md](docs/DATABASE.md)。

## Cloudflare 测试环境部署

不执行生产部署。建议人工步骤：

1. 创建独立的 Pages 测试项目和 Workers 测试项目，均使用免费计划与测试账户。
2. 为 Worker 创建测试 D1/R2 资源，并在测试配置中设置真实绑定 ID；设置 `SESSION_SECRET` 为测试 secret。
3. 运行 `npm run build`，再以人工命令部署：`wrangler pages deploy apps/web/dist --project-name <测试项目>` 和 `wrangler deploy --env staging --config apps/api/wrangler.toml`。
4. 将 Pages `/api/*` 路由到 Worker（或在测试前端设置 `VITE_API_BASE_URL`），并将 Worker 的 `APP_ORIGIN` 固定为该测试 Pages URL。
5. 使用非真实的测试账户执行订单、SN、运单和权限验证。

## 正式域名接入（仅作操作说明）

`maxcine.cn` 尚未接入，本仓库不会修改腾讯云 DNS。待拥有正式授权并完成安全验收后：

1. 在 Cloudflare 添加并验证域名；按 Cloudflare 给出的名称服务器信息由域名管理员变更 DNS。
2. 在 Pages 绑定 `maxcine.cn`（和必要的 `www` 策略），在 Worker 绑定受限的 API 路由或 `api.maxcine.cn`。
3. 将生产 `APP_ORIGIN`、D1/R2 绑定和密钥分别配置到生产环境，**不复用**测试环境。
4. 完成 TLS、CORS、会话、备份、审计、隐私文本和回滚演练后，才允许发布。

## 质量检查

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

浏览器端验收使用隔离临时 D1，不会改写日常本地演示数据。为避免把测试密码写入仓库，运行时由本机环境变量提供：

```bash
E2E_PASSWORD='<仅限本机的演示密码>' npm run test:e2e
```

该脚本固定使用 `5175`（Web）和 `8791`（API）；任一端口被占用时会停止并提示，不会切换到其他端口。

详细架构、安全、品牌、数据库和待办事项分别见 [ARCHITECTURE.md](ARCHITECTURE.md)、[SECURITY.md](SECURITY.md)、[BRAND_GUIDELINES.md](BRAND_GUIDELINES.md)、[docs/DATABASE.md](docs/DATABASE.md) 与 [TODO.md](TODO.md)。
