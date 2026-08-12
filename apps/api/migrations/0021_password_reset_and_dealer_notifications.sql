ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1));

ALTER TABLE dealers ADD COLUMN notification_email TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_dealers_notification_email ON dealers(notification_email);
