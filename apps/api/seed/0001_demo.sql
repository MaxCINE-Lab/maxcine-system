-- Synthetic local data only. Password for all demo accounts: DemoOnly-ChangeMe-2026
-- This predictable password is strictly for an isolated local D1 database; never apply this seed in a shared environment.
INSERT OR IGNORE INTO dealers (id, code, name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'DEMO-EAST', 'Demo East Dealer');

INSERT OR IGNORE INTO users (id, email, password_hash, name, role, dealer_id) VALUES
  ('20000000-0000-4000-8000-000000000001', 'admin@example.test', 'pbkdf2$210000$bWF4Y2luZS1kZW1vLXNlZWQtc2FsdC0yMDI2$xNoUJwieXoerbu4oSePzgxrbxlz4-y0Fvn8IU1q5wuU', 'Demo Administrator', 'admin', NULL),
  ('20000000-0000-4000-8000-000000000002', 'dealer@example.test', 'pbkdf2$210000$bWF4Y2luZS1kZW1vLXNlZWQtc2FsdC0yMDI2$xNoUJwieXoerbu4oSePzgxrbxlz4-y0Fvn8IU1q5wuU', 'Demo Dealer', 'dealer', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000003', 'warehouse@example.test', 'pbkdf2$210000$bWF4Y2luZS1kZW1vLXNlZWQtc2FsdC0yMDI2$xNoUJwieXoerbu4oSePzgxrbxlz4-y0Fvn8IU1q5wuU', 'Demo Warehouse', 'warehouse', NULL);

INSERT OR IGNORE INTO stores (id, dealer_id, code, name) VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'DEMO-SH', 'Demo Shanghai Store');

INSERT OR IGNORE INTO products (id, sku, name, description, unit_price_cents) VALUES
  ('40000000-0000-4000-8000-000000000001', 'MC-REFERENCE-01', 'MaxCINE Reference Display', 'Synthetic local development product.', 0);

INSERT OR IGNORE INTO inventory (id, product_id, quantity, reorder_level) VALUES
  ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 0, 2);
