# Architecture

## 运行边界

```text
Browser → Cloudflare Pages (apps/web) → /api → Cloudflare Worker (apps/api)
                                                  ├─ D1: transactional business data
                                                  ├─ R2: approved public/download assets
                                                  └─ Email delivery: disabled for this local-only release
```

前端只负责呈现和体验；所有业务权限在 Worker 中再次验证。共享的类型、Zod 输入校验和权限策略位于 `packages/shared`，避免前后端的角色、状态枚举漂移。

## API 约定

成功请求返回业务对象。失败统一返回：

```json
{"error":{"code":"FORBIDDEN","message":"...","requestId":"...","details":{"field":["..."]}}}
```

`requestId` 会返回在 `X-Request-ID`，并写入关键操作的 `audit_logs`。可预期错误包括 `UNAUTHENTICATED`、`FORBIDDEN`、`NOT_FOUND`、`CONFLICT`、`VALIDATION_ERROR`、`RATE_LIMITED`。

## 订单状态机

```text
draft → submitted → approved → picking → packed → shipped → delivered
             └→ rejected
draft / approved → cancelled (admin flow only)
```

- dealer：创建/提交自己的订单。
- admin：审核；通过时在同一 D1 batch 中保留库存、更新订单、写通知和审计。
- warehouse：仅看已获批及之后的订单；拣货、绑定 SN、打包、录入运单、确认发货。

首版的 `delivered` 状态等待承运商回调适配器；该适配器尚未启用。

## 邮件设计

邮件投递在本轮完全禁用，API 不会实例化或调用邮件适配器，也不连接真实 provider。功能邮箱作为小写的本地配置数据保存：`support@maxcine.cn` 用于客户支持与人工回复，`notifications@maxcine.cn` 用于业务状态通知，`noreply@maxcine.cn` 用于验证码和密码重置且不接受回复。未来若要启用投递，必须另行完成 provider 密钥、退信处理、发送审计、环境隔离和人工上线批准。
