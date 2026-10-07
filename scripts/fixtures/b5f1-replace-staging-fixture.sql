-- STAGING ONLY. Synthetic Staging replacement execution acceptance data.
-- No physical customer replacement represented. Two separate canonical Assets:
-- an original unit sold through a synthetic order, and an unsold replacement unit.
-- Idempotent: re-running inserts nothing new.
INSERT OR IGNORE INTO assets(id,asset_code,asset_status,product_name_snapshot,version_snapshot,original_sn,current_sn,inventory_status,created_by) VALUES
 ('43000000-0000-4000-8000-0000000b5f01','MC-26-B5F1-000001','active','B-5F1 Synthetic Replace Fixture','Staging only','STG-B5F1-ORIGINAL-000001','STG-B5F1-ORIGINAL-000001','NORMAL','71000000-0000-4000-8000-000000000001'),
 ('43000000-0000-4000-8000-0000000b5f02','MC-26-B5F1-000002','active','B-5F1 Synthetic Replace Fixture','Staging only','STG-B5F1-REPLACEMENT-000002','STG-B5F1-REPLACEMENT-000002','NORMAL','71000000-0000-4000-8000-000000000001');
INSERT OR IGNORE INTO asset_locations(asset_id,warehouse_id,status,custody,updated_by) VALUES
 ('43000000-0000-4000-8000-0000000b5f01','wh-uk','on_hand','WAREHOUSE','71000000-0000-4000-8000-000000000001'),
 ('43000000-0000-4000-8000-0000000b5f02','wh-uk','on_hand','WAREHOUSE','71000000-0000-4000-8000-000000000001');
INSERT OR IGNORE INTO asset_inspection_tasks(id,asset_id,assigned_to,status,result,grade,grade_display,final_qc,notes,started_at,completed_at,created_by) VALUES
 ('46000000-0000-4000-8000-0000000b5f01','43000000-0000-4000-8000-0000000b5f01','71000000-0000-4000-8000-000000000002','completed','PASS','A','A',1,'Synthetic Staging fixture; no physical inspection','2026-10-01 00:00:00','2026-10-01 00:00:00','71000000-0000-4000-8000-000000000001'),
 ('46000000-0000-4000-8000-0000000b5f02','43000000-0000-4000-8000-0000000b5f02','71000000-0000-4000-8000-000000000002','completed','PASS','A','A',1,'Synthetic Staging fixture; no physical inspection','2026-10-01 00:00:00','2026-10-01 00:00:00','71000000-0000-4000-8000-000000000001');
INSERT OR IGNORE INTO asset_certifications(id,asset_id,inspection_task_id,grade,grade_display,inspection_result,final_qc,certification_date,verification_code_hash,created_by) VALUES
 ('47000000-0000-4000-8000-0000000b5f01','43000000-0000-4000-8000-0000000b5f01','46000000-0000-4000-8000-0000000b5f01','A','A','PASS',1,'2026-10-01 00:00:00','staging-synthetic-not-a-real-code','71000000-0000-4000-8000-000000000001'),
 ('47000000-0000-4000-8000-0000000b5f02','43000000-0000-4000-8000-0000000b5f02','46000000-0000-4000-8000-0000000b5f02','A','A','PASS',1,'2026-10-01 00:00:00','staging-synthetic-not-a-real-code','71000000-0000-4000-8000-000000000001');
INSERT OR IGNORE INTO orders(id,order_no,dealer_id,store_id,created_by,status,channel_id,sales_account_id,fulfilment_warehouse_id,external_order_id,currency,total_cents,note) VALUES
 ('42000000-0000-4000-8000-0000000b5f01','STG-B5F1-REPLACE-ORDER-0001','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001',
  'approved','channel-ebay-uk','account-ebay-uk-staging','wh-uk','STG-B5F1-SYNTHETIC-0001','GBP',100,'Synthetic Staging replacement execution acceptance data. No physical customer replacement represented.');

-- B-5F1 hardening (0045): replacement compatibility now requires a non-null,
-- equal canonical product_id on both units. The first pair above has no
-- product_id and stays as completed history. This second synthetic pair uses
-- an explicit, inactive synthetic product record (hidden from the catalog).
INSERT OR IGNORE INTO products(id,sku,name,description,product_version,unit_price_cents,is_active,created_by,updated_by) VALUES
 ('48000000-0000-4000-8000-0000000b5f01','STG-B5F1-SYNTHETIC-PRODUCT','B-5F1 Synthetic Replace Fixture','Synthetic Staging product record for replacement acceptance only','Staging only',0,0,
  '71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001');
INSERT OR IGNORE INTO assets(id,asset_code,asset_status,product_id,product_name_snapshot,version_snapshot,original_sn,current_sn,inventory_status,created_by) VALUES
 ('43000000-0000-4000-8000-0000000b5f03','MC-26-B5F1-000003','active','48000000-0000-4000-8000-0000000b5f01','B-5F1 Synthetic Replace Fixture','Staging only','STG-B5F1-ORIGINAL-000003','STG-B5F1-ORIGINAL-000003','NORMAL','71000000-0000-4000-8000-000000000001'),
 ('43000000-0000-4000-8000-0000000b5f04','MC-26-B5F1-000004','active','48000000-0000-4000-8000-0000000b5f01','B-5F1 Synthetic Replace Fixture','Staging only','STG-B5F1-REPLACEMENT-000004','STG-B5F1-REPLACEMENT-000004','NORMAL','71000000-0000-4000-8000-000000000001');
INSERT OR IGNORE INTO asset_locations(asset_id,warehouse_id,status,custody,updated_by) VALUES
 ('43000000-0000-4000-8000-0000000b5f03','wh-uk','on_hand','WAREHOUSE','71000000-0000-4000-8000-000000000001'),
 ('43000000-0000-4000-8000-0000000b5f04','wh-uk','on_hand','WAREHOUSE','71000000-0000-4000-8000-000000000001');
INSERT OR IGNORE INTO asset_inspection_tasks(id,asset_id,assigned_to,status,result,grade,grade_display,final_qc,notes,started_at,completed_at,created_by) VALUES
 ('46000000-0000-4000-8000-0000000b5f03','43000000-0000-4000-8000-0000000b5f03','71000000-0000-4000-8000-000000000002','completed','PASS','A','A',1,'Synthetic Staging fixture; no physical inspection','2026-10-01 00:00:00','2026-10-01 00:00:00','71000000-0000-4000-8000-000000000001'),
 ('46000000-0000-4000-8000-0000000b5f04','43000000-0000-4000-8000-0000000b5f04','71000000-0000-4000-8000-000000000002','completed','PASS','A','A',1,'Synthetic Staging fixture; no physical inspection','2026-10-01 00:00:00','2026-10-01 00:00:00','71000000-0000-4000-8000-000000000001');
INSERT OR IGNORE INTO asset_certifications(id,asset_id,inspection_task_id,grade,grade_display,inspection_result,final_qc,certification_date,verification_code_hash,created_by) VALUES
 ('47000000-0000-4000-8000-0000000b5f03','43000000-0000-4000-8000-0000000b5f03','46000000-0000-4000-8000-0000000b5f03','A','A','PASS',1,'2026-10-01 00:00:00','staging-synthetic-not-a-real-code','71000000-0000-4000-8000-000000000001'),
 ('47000000-0000-4000-8000-0000000b5f04','43000000-0000-4000-8000-0000000b5f04','46000000-0000-4000-8000-0000000b5f04','A','A','PASS',1,'2026-10-01 00:00:00','staging-synthetic-not-a-real-code','71000000-0000-4000-8000-000000000001');
INSERT OR IGNORE INTO orders(id,order_no,dealer_id,store_id,created_by,status,channel_id,sales_account_id,fulfilment_warehouse_id,external_order_id,currency,total_cents,note) VALUES
 ('42000000-0000-4000-8000-0000000b5f02','STG-B5F1-REPLACE-ORDER-0002','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001',
  'approved','channel-ebay-uk','account-ebay-uk-staging','wh-uk','STG-B5F1-SYNTHETIC-0002','GBP',100,'Synthetic Staging replacement execution acceptance data. No physical customer replacement represented.');
