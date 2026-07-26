# Database Design

## 表摘要

| 表 | 责任 |
| --- | --- |
| `users` | 账户、PBKDF2 密码哈希和启用状态；授权不读取旧单角色兼容列 |
| `roles` / `permissions` / `role_permissions` / `user_roles` | 多角色 RBAC；有效权限仅由用户 ID、角色与权限关系推导 |
| `dealers` / `dealer_user_assignments` | 渠道主体及独立的经销商资格 |
| `service_centers` / `service_center_user_assignments` | 授权服务中心及独立的服务中心资格 |
| `stores` / `store_user_assignments` | 店铺的平台、经销商、负责人、启用状态及用户级数据范围 |
| `products` | SKU、产品名称、规格、经销商价格和订单价格快照来源 |
| `inventory` | 每产品可用库存；初值为零 |
| `inventory_transactions` | 唯一允许改变库存的业务流水：期初、预留、释放、调整、退货 |
| `serial_numbers` | 全局唯一 SN、产品、订单明细和 shipment 绑定状态 |
| `orders` / `order_items` | 订单头、不可变的产品/SKU/单价快照与数量 |
| `shipments` | 每订单一个 shipment、顺丰运单和发货状态 |
| `after_sales_cases` / `after_sales_assignments` / `after_sales_assessments` / `after_sales_recommendations` / `after_sales_approvals` | 售后申请、服务中心分配、定损、处理建议和最终审批的独立记录 |
| `notifications` | 面向用户或店铺范围的站内事务通知 |
| `system_email_accounts` | 仅作为本地功能邮箱配置的记录；不代表可投递 provider |
| `audit_logs` | 操作者、对象、前后状态、请求编号和时间 |
| `login_attempts` | 基础登录失败限流，不保存原始邮箱/IP |

## 不变量

1. `serial_numbers.serial_number`、产品 SKU、订单号、工单号、运单号均为唯一值。
2. `serial_numbers` 只有在绑定订单明细后才可为 `allocated`/`shipped`；`shipped` 必须绑定 shipment。
3. `inventory_transactions` 的产品必须匹配 `inventory.product_id`。`inventory_transaction_apply` 触发器应用数量变化，负库存会 `RAISE(ABORT)`，因此回滚整个 D1 batch。
4. 应用代码不直接更新 `inventory.quantity`；所有库存写入走流水接口并由审计记录。`inventory_write_guards` 是仅供触发器使用的短暂守卫记录，`inventory_no_direct_quantity_update` 会拒绝没有该守卫的数量更新；守卫仅在新增库存流水的触发器链内存在。
5. 授权必须从 `user_roles → role_permissions` 和用户的店铺/服务中心关系计算；不得通过姓名、邮箱或旧兼容列判断权限。
6. 超级管理员具有全局数据权限；经销商只能读取其 `store_user_assignments` 范围内的数据；仓库仅能读取已进入仓库流程的订单。
7. 售后受理、定损、处理建议和最终审批分别需要不同权限；服务中心只能处理分配给自身服务中心的工单，最终审批不授予服务中心角色。
6. 删除策略默认 `RESTRICT`（商业记录）或 `SET NULL`（审计/操作者引用），避免意外删除历史。

## 原子性

审核订单、绑定 SN、打包、发货、库存调整、创建售后和管理员创建操作均以 `D1Database.batch()` 提交。D1 batch 将这些语句作为事务处理；触发器或唯一/外键约束失败会中止整个批次。库存审核在批次中先更新订单再写入预留流水；建议在接入并发集成测试后补充一个数据库级“预留订单状态”断言触发器。
