-- Public Warranty remains a projection of the existing Asset internal warranty.
ALTER TABLE asset_public_warranties ADD COLUMN projection_policy_code TEXT
  CHECK (projection_policy_code IS NULL OR projection_policy_code = 'MAXCINE_CERTIFIED_STANDARD_12M');
ALTER TABLE asset_public_warranties ADD COLUMN projection_source_order_id TEXT REFERENCES orders(id) ON DELETE RESTRICT;
-- asset_id and (public_warranty_id, entitlement_type) are already UNIQUE.
