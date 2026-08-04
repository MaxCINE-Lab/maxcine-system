-- Customer Risk Center V2 polish.
-- Adds IP / platform location as a searchable customer contact without creating a separate subsystem.
PRAGMA foreign_keys = OFF;

ALTER TABLE customers ADD COLUMN ip_location TEXT NOT NULL DEFAULT '';

ALTER TABLE customer_contacts RENAME TO customer_contacts_old;

CREATE TABLE customer_contacts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('name','phone','recipient_name','platform_nickname','wechat','qq','telegram','whatsapp','address','city','keyword','ip_location')),
  contact_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (customer_id, contact_type, normalized_value)
);

INSERT INTO customer_contacts (id, customer_id, contact_type, contact_value, normalized_value, first_seen_at, last_seen_at, created_at, created_by)
  SELECT id, customer_id, contact_type, contact_value, normalized_value, created_at, created_at, created_at, created_by
  FROM customer_contacts_old;

DROP TABLE customer_contacts_old;

CREATE INDEX IF NOT EXISTS idx_customer_contacts_lookup ON customer_contacts(contact_type, normalized_value);
CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer ON customer_contacts(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_contacts_ip ON customer_contacts(contact_type, normalized_value, last_seen_at DESC);

DELETE FROM role_permissions
WHERE permission_code = 'customer-risk:update-own'
  AND role_id IN (SELECT id FROM roles WHERE code = 'dealer');

PRAGMA foreign_keys = ON;
