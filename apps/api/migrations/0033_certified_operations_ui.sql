-- Phase 1.2B-1: Certified operations UI support.
-- This migration is strictly additive because inspection Evidence and existing
-- certifications already reference the live task table in Staging.

ALTER TABLE asset_inspection_tasks ADD COLUMN grade_display TEXT
  CHECK (grade_display IS NULL OR grade_display IN ('A+','A','B+','B','Parts / Repair'));

ALTER TABLE asset_certifications ADD COLUMN grade_display TEXT
  CHECK (grade_display IS NULL OR grade_display IN ('A+','A','B+','B','Parts / Repair'));

UPDATE asset_inspection_tasks SET grade_display = grade WHERE grade_display IS NULL AND grade IN ('A','B');
UPDATE asset_inspection_tasks SET grade_display = 'B' WHERE grade_display IS NULL AND grade = 'C';
UPDATE asset_inspection_tasks SET grade_display = 'Parts / Repair' WHERE grade_display IS NULL AND grade = 'D';

UPDATE asset_certifications SET grade_display = grade WHERE grade_display IS NULL AND grade IN ('A','B');
UPDATE asset_certifications SET grade_display = 'B' WHERE grade_display IS NULL AND grade = 'C';
UPDATE asset_certifications SET grade_display = 'Parts / Repair' WHERE grade_display IS NULL AND grade = 'D';

INSERT OR IGNORE INTO permissions (code, name, description) VALUES
  ('certified:final-qc', 'Certified 最终审核', '复核已完成检测并签发 MaxCINE Certified');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
SELECT roles.id, 'certified:final-qc' FROM roles
WHERE roles.code = 'international_operator';
