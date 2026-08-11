CREATE TABLE IF NOT EXISTS mail_center_messages (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  template_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  to_email TEXT NOT NULL COLLATE NOCASE,
  from_email TEXT NOT NULL COLLATE NOCASE,
  from_name TEXT NOT NULL DEFAULT '',
  reply_to_email TEXT NOT NULL COLLATE NOCASE,
  reply_to_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  failure_reason TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT NOT NULL DEFAULT '',
  related_entity_type TEXT NOT NULL DEFAULT '',
  related_entity_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  html_content TEXT NOT NULL DEFAULT '',
  text_content TEXT NOT NULL DEFAULT '',
  sent_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_mail_center_messages_created_at ON mail_center_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_mail_center_messages_template ON mail_center_messages(template_key, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_center_messages_to_email ON mail_center_messages(to_email, created_at);
