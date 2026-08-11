-- Production base seed: RBAC and system mail accounts only.
-- This file intentionally does not insert demo users, products, SNs, orders,
-- customers, customer-risk data, service cases, or historical Excel data.
PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO system_email_accounts (address, purpose, accepts_replies, environment) VALUES
  ('support@maxcine.cn', '客户支持、售后申请和人工回复', 1, 'production'),
  ('notification@maxcine.cn', '订单审核、发货、库存提醒、售后状态和报价通知', 0, 'production');

INSERT OR IGNORE INTO permissions (code, name, description) VALUES
  ('data:read:all', '查看全部数据', '跨全部业务范围读取数据'),
  ('system:manage', '管理系统设置', '管理本地系统设置'),
  ('user:manage', '管理用户', '管理用户、角色和授权关系'),
  ('dealer:manage', '管理经销商', '管理经销商主体'),
  ('service-center:manage', '管理授权服务中心', '管理授权服务中心主体'),
  ('store:manage', '管理店铺', '管理店铺及店铺授权'),
  ('catalog:read', '查看产品资料', '查看产品与价格资料'),
  ('knowledge:read', '查看知识库', '查看产品知识库'),
  ('consultation:reply', '回复产品咨询', '回复专业产品咨询'),
  ('order:read', '查看授权订单', '查看授权店铺订单'),
  ('order:create', '创建订单', '创建授权店铺订单'),
  ('order:submit', '提交订单审核', '提交授权店铺草稿订单'),
  ('order:review', '审核订单', '审核订单和取消已通过订单'),
  ('order:warehouse-read', '查看仓库流程订单', '仅查看已进入仓库流程的订单'),
  ('order:fulfill', '仓库履约', '配货、SN、运单和确认发货'),
  ('inventory:read', '查看库存', '查看库存及库存状态'),
  ('inventory:manage', '管理库存', '调整库存和补货阈值'),
  ('inventory:warehouse-manage', '处理仓库库存流水', '处理仓库流水和退货重新入库'),
  ('audit:read', '查看审计记录', '查看全部审计记录'),
  ('notifications:read', '查看通知', '查看授权范围通知'),
  ('after-sales:create', '提交售后申请', '提交授权店铺售后申请'),
  ('after-sales:read', '查看售后工单', '查看授权店铺或受分配服务中心工单'),
  ('after-sales:assign', '分配售后任务', '向授权服务中心分配售后工单'),
  ('after-sales:receive', '受理售后', '受理分配给本服务中心的售后工单'),
  ('after-sales:damage-assess', '提交定损结果', '提交分配工单的检测和定损结果'),
  ('after-sales:recommend', '提交售后建议', '提交维修、换货或其他处理建议'),
  ('after-sales:approve', '最终审批售后', '进行售后最终审批'),
  ('asset:read', '查看资产与保修', '查看授权范围内的资产、保修和生命周期信息'),
  ('asset:manage', '管理资产与保修', '处理保修人工覆盖和资产数据异常'),
  ('asset:import', '导入历史保修数据', '预检查并导入历史保修数据'),
  ('asset:warehouse-read', '查看仓库资产信息', '查看履约所需的产品、SN 和仓库信息'),
  ('customer-risk:read', '查询客户风控', '查询共享客户风险档案和咨询历史'),
  ('customer-risk:create', '登记客户风控', '新增客户风险记录和咨询记录'),
  ('customer-risk:update-own', '编辑本人风控记录', '编辑本人创建的客户风险咨询记录'),
  ('customer-risk:manage', '管理客户风控', '管理全部客户风控档案和记录');

INSERT OR IGNORE INTO roles (id, code, name, description) VALUES
  ('21000000-0000-4000-8000-000000000001', 'super_admin', '管理员', '管理全部业务范围和系统设置'),
  ('21000000-0000-4000-8000-000000000002', 'warehouse_manager', '仓库管理员', '处理已进入仓库流程的订单和库存流水'),
  ('21000000-0000-4000-8000-000000000003', 'dealer', '经销商', '销售、授权店铺订单和售后申请'),
  ('21000000-0000-4000-8000-000000000004', 'authorized_service_center', '授权服务中心', '售后受理、检测、定损和处理建议'),
  ('21000000-0000-4000-8000-000000000005', 'online_product_consultant', '线上产品顾问', '产品咨询和专业光学问题解答');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT '21000000-0000-4000-8000-000000000001', code FROM permissions;

INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES
  ('21000000-0000-4000-8000-000000000002', 'order:warehouse-read'),
  ('21000000-0000-4000-8000-000000000002', 'order:fulfill'),
  ('21000000-0000-4000-8000-000000000002', 'inventory:read'),
  ('21000000-0000-4000-8000-000000000002', 'inventory:warehouse-manage'),
  ('21000000-0000-4000-8000-000000000002', 'asset:warehouse-read'),
  ('21000000-0000-4000-8000-000000000002', 'notifications:read'),
  ('21000000-0000-4000-8000-000000000003', 'catalog:read'),
  ('21000000-0000-4000-8000-000000000003', 'order:read'),
  ('21000000-0000-4000-8000-000000000003', 'order:create'),
  ('21000000-0000-4000-8000-000000000003', 'order:submit'),
  ('21000000-0000-4000-8000-000000000003', 'notifications:read'),
  ('21000000-0000-4000-8000-000000000003', 'after-sales:create'),
  ('21000000-0000-4000-8000-000000000003', 'after-sales:read'),
  ('21000000-0000-4000-8000-000000000003', 'asset:read'),
  ('21000000-0000-4000-8000-000000000003', 'customer-risk:read'),
  ('21000000-0000-4000-8000-000000000003', 'customer-risk:create'),
  ('21000000-0000-4000-8000-000000000003', 'customer-risk:update-own'),
  ('21000000-0000-4000-8000-000000000004', 'after-sales:read'),
  ('21000000-0000-4000-8000-000000000004', 'asset:read'),
  ('21000000-0000-4000-8000-000000000004', 'after-sales:receive'),
  ('21000000-0000-4000-8000-000000000004', 'after-sales:damage-assess'),
  ('21000000-0000-4000-8000-000000000004', 'after-sales:recommend'),
  ('21000000-0000-4000-8000-000000000005', 'catalog:read'),
  ('21000000-0000-4000-8000-000000000005', 'knowledge:read'),
  ('21000000-0000-4000-8000-000000000005', 'consultation:reply');
