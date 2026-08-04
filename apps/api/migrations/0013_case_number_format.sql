-- Normalize operational after-sales case numbers to the public CAS-xxxxx-xxxxx format.
-- Internal UUID relationships and immutable sent quote snapshots remain unchanged.
PRAGMA foreign_keys = ON;

UPDATE after_sales_cases
SET case_no = 'CAS-' || upper(substr(hex(randomblob(5)), 1, 5)) || '-' || upper(substr(hex(randomblob(5)), 1, 5))
WHERE case_no NOT GLOB 'CAS-?????-?????';
