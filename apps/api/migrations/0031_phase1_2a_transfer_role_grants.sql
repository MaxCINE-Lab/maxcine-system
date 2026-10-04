-- Phase 1.2A transfer execution roles. Permission grants allow the endpoint to
-- reach the warehouse-scope guard; they do not grant access to any warehouse.
PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
SELECT roles.id, permissions.code
FROM roles JOIN permissions
WHERE roles.code IN ('warehouse_manager', 'uk_fulfilment_operator')
  AND permissions.code = 'transfer:manage';
