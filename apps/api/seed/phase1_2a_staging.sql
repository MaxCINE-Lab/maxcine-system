-- STAGING ONLY. This file contains no passwords and does not create users.
-- It records the explicit scopes required by the existing Phase 1 test personas
-- after Phase 1.2A makes sales-account and market-region authorization strict.
UPDATE user_workspaces
SET data_scope_json = '{"warehouseIds":["wh-cn-sd","wh-sg","wh-uk"],"salesAccountIds":["account-ebay-uk-staging"],"marketRegions":["CN","SG","UK"]}'
WHERE user_id = (SELECT id FROM users WHERE email = 'stg.phase1.international@maxcine.test')
  AND workspace_id = 'ws-international';

UPDATE user_workspaces
SET data_scope_json = '{"warehouseIds":["wh-uk"],"salesAccountIds":["account-ebay-uk-staging"],"marketRegions":["UK"]}'
WHERE user_id = (SELECT id FROM users WHERE email = 'stg.phase1.uk@maxcine.test')
  AND workspace_id = 'ws-uk-fulfilment';

UPDATE user_workspaces
SET data_scope_json = '{"warehouseIds":["wh-cn-sd"],"marketRegions":["CN"]}'
WHERE user_id = (SELECT id FROM users WHERE email = 'stg.phase1.warehouse@maxcine.test')
  AND workspace_id = 'ws-warehouse';

INSERT OR IGNORE INTO assets (
  id, asset_code, current_sn, original_sn, product_name_snapshot, version_snapshot,
  asset_status, warranty_policy, source_channel, shipping_warehouse, created_by, updated_by
) VALUES (
  '43000000-0000-4000-8000-000000000012', 'MC-26-P12A-000012', 'STG-P12A-000012', 'STG-P12A-000012',
  'Phase 1.2A Authorization Fixture', 'Staging only', 'active', 'unknown', 'phase1.2a-staging', 'CN-SD',
  (SELECT id FROM users WHERE email = 'stg.phase1.admin@maxcine.test'),
  (SELECT id FROM users WHERE email = 'stg.phase1.admin@maxcine.test')
);

INSERT OR IGNORE INTO asset_identifiers (
  id, asset_id, identifier_type, identifier_value, is_current, source, created_by
) VALUES (
  '43000000-0000-4000-8001-000000000012', '43000000-0000-4000-8000-000000000012',
  'current_sn', 'STG-P12A-000012', 1, 'phase1.2a-staging',
  (SELECT id FROM users WHERE email = 'stg.phase1.admin@maxcine.test')
);

INSERT OR IGNORE INTO asset_locations (asset_id, warehouse_id, status, custody, updated_by)
VALUES (
  '43000000-0000-4000-8000-000000000012', 'wh-cn-sd', 'on_hand', 'WAREHOUSE',
  (SELECT id FROM users WHERE email = 'stg.phase1.admin@maxcine.test')
);

INSERT OR IGNORE INTO asset_events (
  id, asset_id, event_type, occurred_at, title, description, operator_user_id, visibility, source
) VALUES (
  '43000000-0000-4000-8002-000000000012', '43000000-0000-4000-8000-000000000012',
  'asset_received', CURRENT_TIMESTAMP, 'Phase 1.2A Staging 测试资产收货',
  '仅用于授权与 Inspection Start 验收。',
  (SELECT id FROM users WHERE email = 'stg.phase1.admin@maxcine.test'), 'admin_private', 'phase1.2a-staging'
);

INSERT OR IGNORE INTO sales_accounts (
  id, channel_id, account_name, market_region, external_account_id, is_active
) VALUES (
  'account-phase12a-unauthorized', 'channel-ebay-uk', 'Phase 1.2A Unauthorized Fixture', 'UK', 'STG-NOT-IN-PERSONA-SCOPE', 1
);

INSERT OR IGNORE INTO orders (
  id, order_no, dealer_id, store_id, status, note, total_cents, created_by,
  channel_id, sales_account_id, external_order_id, currency, fulfilment_warehouse_id
)
SELECT
  '43000000-0000-4000-8003-000000000012', 'STG-P12A-SCOPE-ORDER', dealer_id, store_id,
  'approved', 'Phase 1.2A unauthorized sales-account fixture', 0,
  (SELECT id FROM users WHERE email = 'stg.phase1.admin@maxcine.test'),
  'channel-ebay-uk', 'account-phase12a-unauthorized', 'STG-P12A-SCOPE-ORDER', 'GBP', 'wh-uk'
FROM orders
WHERE id = '42000000-0000-4000-8000-000000000001';

INSERT OR IGNORE INTO orders (
  id, order_no, dealer_id, store_id, status, note, total_cents, created_by,
  channel_id, sales_account_id, external_order_id, currency, fulfilment_warehouse_id
)
SELECT
  '43000000-0000-4000-8004-000000000012', 'STG-P12A-ALLOC-ORDER-1', dealer_id, store_id,
  'approved', 'Phase 1.2A first allocation history fixture', 0,
  (SELECT id FROM users WHERE email = 'stg.phase1.admin@maxcine.test'),
  'channel-ebay-uk', 'account-ebay-uk-staging', 'STG-P12A-ALLOC-ORDER-1', 'GBP', 'wh-cn-sd'
FROM orders
WHERE id = '42000000-0000-4000-8000-000000000001';

INSERT OR IGNORE INTO orders (
  id, order_no, dealer_id, store_id, status, note, total_cents, created_by,
  channel_id, sales_account_id, external_order_id, currency, fulfilment_warehouse_id
)
SELECT
  '43000000-0000-4000-8005-000000000012', 'STG-P12A-ALLOC-ORDER-2', dealer_id, store_id,
  'approved', 'Phase 1.2A second allocation history fixture', 0,
  (SELECT id FROM users WHERE email = 'stg.phase1.admin@maxcine.test'),
  'channel-ebay-uk', 'account-ebay-uk-staging', 'STG-P12A-ALLOC-ORDER-2', 'GBP', 'wh-cn-sd'
FROM orders
WHERE id = '42000000-0000-4000-8000-000000000001';
