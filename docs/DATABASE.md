# Database Design

## 表摘要

| 表 | 责任 |
| --- | --- |
| `users` | 账户、PBKDF2 密码哈希、角色、经销商归属和启用状态 |
| `dealers` / `stores` | 渠道主体与店铺；店铺必须归属一个经销商 |
| `products` | SKU、产品名称、规格、经销商价格和订单价格快照来源 |
| `inventory` | 每产品可用库存；初值为零 |
| `inventory_transactions` | 唯一允许改变库存的业务流水：期初、预留、释放、调整、退货 |
| `serial_numbers` | 全局唯一 SN、产品、订单明细和 shipment 绑定状态 |
| `orders` / `order_items` | 订单头、不可变的产品/SKU/单价快照与数量 |
| `shipments` | 每订单一个 shipment、顺丰运单和发货状态 |
| `after_sales_cases` | 经销商归属、店铺/订单/产品/SN 关联、问题类型、联系人和工单状态 |
| `notifications` | 面向用户或经销商的站内事务通知 |
| `audit_logs` | 操作者、对象、前后状态、请求编号和时间 |
| `login_attempts` | 基础登录失败限流，不保存原始邮箱/IP |

## 不变量

1. `serial_numbers.serial_number`、产品 SKU、订单号、工单号、运单号均为唯一值。
2. `serial_numbers` 只有在绑定订单明细后才可为 `allocated`/`shipped`；`shipped` 必须绑定 shipment。
3. `inventory_transactions` 的产品必须匹配 `inventory.product_id`。`inventory_transaction_apply` 触发器应用数量变化，负库存会 `RAISE(ABORT)`，因此回滚整个 D1 batch。
4. 应用代码不直接更新 `inventory.quantity`；所有库存写入走流水接口并由审计记录。`inventory_write_guards` 是仅供触发器使用的短暂守卫记录，`inventory_no_direct_quantity_update` 会拒绝没有该守卫的数量更新；守卫仅在新增库存流水的触发器链内存在。
5. `users` 的 `dealer` 角色必须有经销商归属，非 dealer 角色不得有此归属。
6. 删除策略默认 `RESTRICT`（商业记录）或 `SET NULL`（审计/操作者引用），避免意外删除历史。

## 原子性

审核订单、绑定 SN、打包、发货、库存调整、创建售后和管理员创建操作均以 `D1Database.batch()` 提交。D1 batch 将这些语句作为事务处理；触发器或唯一/外键约束失败会中止整个批次。库存审核在批次中先更新订单再写入预留流水；建议在接入并发集成测试后补充一个数据库级“预留订单状态”断言触发器。
