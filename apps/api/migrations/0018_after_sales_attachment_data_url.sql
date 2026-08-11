PRAGMA foreign_keys = ON;

ALTER TABLE after_sales_attachments ADD COLUMN data_url TEXT NOT NULL DEFAULT '';
