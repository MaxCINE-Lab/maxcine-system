# Architecture

## 运行边界

```text
Browser → Cloudflare Pages (apps/web) → /api → Cloudflare Worker (apps/api)
                                                  ├─ D1: transactional business data
                                                  ├─ R2: approved public/download assets
                                                  └─ EmailAdapter: mock now; Resend/SES later
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

`EmailAdapter` 是唯一邮件出口。当前 `MockEmailAdapter` 显式 no-op，不会发送真实邮件。HTML 模板提供订单提交、审核通过/拒绝、已发货、售后创建/更新六种事务消息，使用清晰标题、参考编号和移动端单栏布局。未来 Resend/SES 适配必须增加 provider 密钥、退信处理、发送审计和人工上线批准。
