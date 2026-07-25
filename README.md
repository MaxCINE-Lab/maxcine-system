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

Web 默认位于 `http://localhost:5173`，Worker 本地端口由 Wrangler 输出。Vite 会把 `/api` 代理到 `http://localhost:8787`。演示数据只用于隔离的本地数据库：`admin@example.test`、`dealer@example.test` 或 `warehouse@example.test`，密码均为 `DemoOnly-ChangeMe-2026`。绝不可在共享环境或生产环境应用该种子数据。

## 环境变量

仅将本地值写入 `apps/api/.dev.vars`，不要提交该文件。

| 变量 | 用途 | 必需 |
| --- | --- | --- |
| `SESSION_SECRET` | 会话 HMAC 密钥；使用长度至少 32 的随机值 | 是 |
| `APP_ORIGIN` | 允许的前端来源，开发时为 `http://localhost:5173` | 是 |
| `EMAIL_PROVIDER` | 当前仅支持 `mock`；Resend/SES 适配必须另行审批 | 是 |
| `VITE_API_BASE_URL` | 可选 API 基础地址；同源路由时留空 | 否 |

Cloudflare 的 D1、R2 和机密变量应通过 Dashboard 或 `wrangler secret put` 为**测试环境**配置；不得写入仓库。

## D1 迁移和 R2

本地 D1：`npm run db:apply:local`，然后可用 `npm run db:seed:local`。演示数据位于 `apps/api/seed/`，故不会随生产迁移执行。远程测试库应先创建独立、免费的测试 D1 数据库，再把实际 `database_id` 填入一个不提交的测试 Wrangler 配置；运行 `wrangler d1 migrations apply <测试库名> --remote` 前需人工确认目标。

`apps/api/wrangler.toml` 中的 D1 ID 与 R2 bucket 名称均为占位符。R2 仅用于产品图、下载资料等非敏感资产；上传必须校验 MIME、大小、对象键命名和授权。请勿使用公共 bucket 存放订单导出或客户材料。

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

详细架构、安全、品牌、数据库和待办事项分别见 [ARCHITECTURE.md](ARCHITECTURE.md)、[SECURITY.md](SECURITY.md)、[BRAND_GUIDELINES.md](BRAND_GUIDELINES.md)、[docs/DATABASE.md](docs/DATABASE.md) 与 [TODO.md](TODO.md)。
