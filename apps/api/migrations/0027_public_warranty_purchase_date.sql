PRAGMA foreign_keys = ON;

ALTER TABLE asset_public_warranties
  ADD COLUMN legacy_public_purchase_date TEXT;
