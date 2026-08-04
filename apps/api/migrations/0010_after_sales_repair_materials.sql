-- Repair-material catalog and engineer damage-assessment details.
-- This migration keeps the 0009 after-sales workflow intact and only adds
-- normalized structures for Mavic 4 Pro service materials and inspection advice.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repair_material_import_batches (
  id TEXT PRIMARY KEY,
  source_filename TEXT NOT NULL,
  source_file_fingerprint TEXT NOT NULL,
  source_sheet TEXT NOT NULL DEFAULT '',
  total_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  warning_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(source_file_fingerprint)
);

CREATE TABLE IF NOT EXISTS repair_materials (
  id TEXT PRIMARY KEY,
  material_code TEXT COLLATE NOCASE,
  material_name TEXT NOT NULL,
  applicable_models TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  out_of_warranty_price_cents INTEGER,
  price_status TEXT NOT NULL DEFAULT 'missing' CHECK (price_status IN ('available','zero','not_applicable','missing','manual_confirm')),
  out_of_warranty_service_fee_cents INTEGER,
  service_fee_status TEXT NOT NULL DEFAULT 'missing' CHECK (service_fee_status IN ('fixed','zero','missing','not_applicable','included','text_rule','version_rule','manual_confirm')),
  service_fee_rule_json TEXT NOT NULL DEFAULT '{}',
  retail_category TEXT NOT NULL DEFAULT '',
  can_replace_as_whole_set INTEGER NOT NULL DEFAULT 0 CHECK (can_replace_as_whole_set IN (0,1)),
  warranty_policy TEXT NOT NULL DEFAULT '',
  warranty_days INTEGER,
  warranty_rule_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  source TEXT NOT NULL DEFAULT '',
  source_row_number INTEGER,
  source_note TEXT NOT NULL DEFAULT '',
  source_raw_json TEXT NOT NULL DEFAULT '{}',
  data_quality_status TEXT NOT NULL DEFAULT 'normal' CHECK (data_quality_status IN ('normal','warning','error')),
  issues_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_materials_code
  ON repair_materials(material_code COLLATE NOCASE)
  WHERE material_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_repair_materials_search ON repair_materials(active, material_code, material_name);
CREATE INDEX IF NOT EXISTS idx_repair_materials_quality ON repair_materials(data_quality_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS repair_material_recommendations (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES repair_materials(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('fault_part','damage_type','derived_symptom','product_model','recommended_action','keyword')),
  trigger_value TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(material_id, trigger_type, trigger_value)
);

ALTER TABLE after_sales_inspections_v2 ADD COLUMN reproduction_status TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_inspections_v2 ADD COLUMN reproduction_condition TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_inspections_v2 ADD COLUMN reproduction_process TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_inspections_v2 ADD COLUMN test_result TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_inspections_v2 ADD COLUMN fault_parts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE after_sales_inspections_v2 ADD COLUMN damage_types_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE after_sales_inspections_v2 ADD COLUMN derived_symptoms_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE after_sales_inspections_v2 ADD COLUMN material_suggested_total_cents INTEGER;

CREATE TABLE IF NOT EXISTS after_sales_fault_chains (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL REFERENCES after_sales_inspections_v2(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  chain_index INTEGER NOT NULL DEFAULT 0,
  fault_part TEXT NOT NULL,
  damage_type TEXT NOT NULL,
  cause_type TEXT NOT NULL,
  derived_symptoms_json TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '',
  related_photo_ids_json TEXT NOT NULL DEFAULT '[]',
  severity TEXT NOT NULL,
  repairability TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  engineer_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_after_sales_fault_chains_inspection ON after_sales_fault_chains(inspection_id, chain_index);

CREATE TABLE IF NOT EXISTS after_sales_inspection_materials (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL REFERENCES after_sales_inspections_v2(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES repair_materials(id) ON DELETE RESTRICT,
  material_code_snapshot TEXT NOT NULL DEFAULT '',
  material_name_snapshot TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  handling_method TEXT NOT NULL,
  use_new INTEGER NOT NULL DEFAULT 1 CHECK (use_new IN (0,1)),
  reuse_existing INTEGER NOT NULL DEFAULT 0 CHECK (reuse_existing IN (0,1)),
  repair_only INTEGER NOT NULL DEFAULT 0 CHECK (repair_only IN (0,1)),
  recommend_charge INTEGER NOT NULL DEFAULT 1 CHECK (recommend_charge IN (0,1)),
  unit_price_cents INTEGER,
  service_fee_cents INTEGER,
  material_subtotal_cents INTEGER,
  service_fee_subtotal_cents INTEGER,
  suggested_total_cents INTEGER,
  price_status TEXT NOT NULL DEFAULT '',
  service_fee_status TEXT NOT NULL DEFAULT '',
  compatibility_status TEXT NOT NULL DEFAULT 'unknown' CHECK (compatibility_status IN ('matched','all','unknown','not_applicable')),
  compatibility_warning TEXT NOT NULL DEFAULT '',
  compatibility_override_reason TEXT NOT NULL DEFAULT '',
  engineer_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_after_sales_inspection_materials_inspection ON after_sales_inspection_materials(inspection_id);
CREATE INDEX IF NOT EXISTS idx_after_sales_inspection_materials_case ON after_sales_inspection_materials(case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS after_sales_admin_damage_reviews (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  inspection_id TEXT NOT NULL REFERENCES after_sales_inspections_v2(id) ON DELETE RESTRICT,
  source_fault_chains_json TEXT NOT NULL DEFAULT '[]',
  final_fault_chains_json TEXT NOT NULL DEFAULT '[]',
  source_materials_json TEXT NOT NULL DEFAULT '[]',
  final_materials_json TEXT NOT NULL DEFAULT '[]',
  final_decision TEXT NOT NULL,
  customer_visible_conclusion TEXT NOT NULL DEFAULT '',
  internal_note TEXT NOT NULL DEFAULT '',
  final_total_cents INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_after_sales_admin_damage_reviews_case ON after_sales_admin_damage_reviews(case_id, created_at DESC);

ALTER TABLE after_sales_quote_items ADD COLUMN material_id TEXT REFERENCES repair_materials(id) ON DELETE SET NULL;
ALTER TABLE after_sales_quote_items ADD COLUMN material_code TEXT NOT NULL DEFAULT '';
ALTER TABLE after_sales_quote_items ADD COLUMN service_fee_cents INTEGER;
ALTER TABLE after_sales_quote_items ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE after_sales_quote_items ADD COLUMN customer_note TEXT NOT NULL DEFAULT '';
