-- Extend the existing Asset internal warranty; no Public Warranty writes.
ALTER TABLE assets ADD COLUMN certified_warranty_policy_code TEXT
  CHECK (certified_warranty_policy_code IS NULL OR certified_warranty_policy_code = 'MAXCINE_CERTIFIED_STANDARD_12M');
ALTER TABLE assets ADD COLUMN warranty_source_order_id TEXT REFERENCES orders(id) ON DELETE RESTRICT;
ALTER TABLE assets ADD COLUMN warranty_market_region TEXT CHECK (warranty_market_region IN ('CN','SG','UK'));
ALTER TABLE assets ADD COLUMN warranty_activation_source TEXT CHECK (warranty_activation_source = 'sale_delivery');
ALTER TABLE assets ADD COLUMN warranty_activated_at TEXT
  CHECK (certified_warranty_policy_code IS NULL OR
    (warranty_source_order_id IS NOT NULL AND warranty_market_region IS NOT NULL
     AND warranty_activation_source IS NOT NULL AND warranty_activated_at IS NOT NULL
     AND warranty_start_at IS NOT NULL AND warranty_end_at IS NOT NULL));
CREATE UNIQUE INDEX idx_assets_certified_warranty_order ON assets(warranty_source_order_id)
  WHERE warranty_source_order_id IS NOT NULL;
ALTER TABLE orders ADD COLUMN certified_warranty_eligibility TEXT
  CHECK (certified_warranty_eligibility IN ('activated','not_certified','invalid_certification','existing_warranty','warranty_restricted'));
CREATE UNIQUE INDEX idx_certified_warranty_activation_event ON asset_events(related_order_id)
  WHERE event_type = 'warranty_activated' AND source = 'certified-sale-delivery' AND related_order_id IS NOT NULL;
