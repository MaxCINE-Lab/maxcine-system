// Shared by the queue and the transactional ship guard. Allocation reserves
// ownership; on_hand continues to describe the physical warehouse location.
export const ukShipEligible = `o.fulfilment_warehouse_id = 'wh-uk'
  AND o.status IN ('approved','picking','packed') AND allocation.status = 'reserved'
  AND location.warehouse_id = 'wh-uk' AND location.custody = 'WAREHOUSE' AND location.status = 'on_hand'
  AND asset.asset_status <> 'in_service'
  AND NOT EXISTS (SELECT 1 FROM asset_transfers t WHERE t.asset_id = asset.id AND t.status IN ('created','shipped'))
  AND NOT EXISTS (SELECT 1 FROM after_sales_cases r WHERE r.asset_id = asset.id AND r.status IN ('open','in_progress'))
  AND (SELECT COUNT(*) FROM international_asset_allocations x WHERE x.order_id = o.id AND x.status = 'reserved') = 1`;

export const ukOrderSelect = `SELECT o.id, o.order_no AS orderNo, o.external_order_id AS externalOrderId,
  channel.code AS channel, account.account_name AS salesAccount, o.sales_account_id AS salesAccountId,
  o.currency, o.status, o.shipping_address AS shippingAddress, o.created_at AS createdAt,
  o.fulfillment_carrier AS carrier, o.fulfillment_tracking_number AS trackingNumber, o.fulfillment_updated_at AS shippedAt,
  allocation.allocation_id AS allocationId, allocation.status AS allocationStatus,
  asset.id AS assetId, asset.asset_code AS assetCode, asset.product_name_snapshot AS productName, asset.current_sn AS currentSn,
  COALESCE(cert.grade_display, cert.grade) AS grade, cert.certification_status AS certificationStatus,
  warehouse.code AS warehouseCode, location.custody, location.status AS locationStatus
  FROM orders o JOIN sales_channels channel ON channel.id = o.channel_id JOIN sales_accounts account ON account.id = o.sales_account_id
  JOIN international_asset_allocations allocation ON allocation.order_id = o.id
  JOIN assets asset ON asset.id = allocation.asset_id JOIN asset_locations location ON location.asset_id = asset.id
  LEFT JOIN warehouses warehouse ON warehouse.id = location.warehouse_id
  LEFT JOIN asset_certifications cert ON cert.asset_id = asset.id AND cert.certification_status = 'certified'`;
