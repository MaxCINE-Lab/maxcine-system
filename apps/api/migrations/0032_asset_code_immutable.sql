-- Asset Code is a permanent business identity. UUID remains the primary key,
-- while SN and other identifiers may continue to change independently.
PRAGMA foreign_keys = ON;

CREATE TRIGGER IF NOT EXISTS trg_assets_asset_code_immutable
BEFORE UPDATE OF asset_code ON assets
WHEN NEW.asset_code IS NULL OR trim(NEW.asset_code) = '' OR NEW.asset_code <> OLD.asset_code
BEGIN
  SELECT RAISE(ABORT, 'asset_code is immutable');
END;
