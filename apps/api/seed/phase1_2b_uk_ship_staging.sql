-- STAGING ONLY: create the minimum order header using existing valid dealer,
-- store, user and sales-account relations. Reserve the Asset through the API.
-- Never overwrite an existing shipment, allocation or Asset location.
INSERT OR IGNORE INTO orders (
  id, order_no, dealer_id, store_id, status, note, total_cents, created_by,
  channel_id, sales_account_id, external_order_id, currency, fulfilment_warehouse_id, shipping_address
)
SELECT '44000000-0000-4000-8000-000000000003', 'STG-B3-UK-SHIP-0003', dealer_id, store_id,
  'approved', 'Phase 1.2B-3 Staging customer shipment fixture', 0,
  (SELECT id FROM users WHERE email = 'stg.phase1.admin@maxcine.test'),
  'channel-ebay-uk', 'account-ebay-uk-staging', 'STG-B3-EXTERNAL-0003', 'GBP', 'wh-uk',
  'Staging Test Buyer | 1 Test Street, London, UK (test fixture only)'
FROM orders WHERE id = '42000000-0000-4000-8000-000000000001';
