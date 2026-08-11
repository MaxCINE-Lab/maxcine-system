CREATE TABLE IF NOT EXISTS mail_center_templates (
  template_key TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  html_content TEXT NOT NULL,
  text_content TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mail_center_templates_updated_at ON mail_center_templates(updated_at);
