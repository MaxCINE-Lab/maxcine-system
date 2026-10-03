-- Add the CN-SD warehouse workspace only; the Staging quick-login endpoint is
-- separately environment-gated in the Worker and is never enabled in production.
PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO workspaces (id, code, name, default_route)
VALUES ('ws-warehouse', 'WAREHOUSE', '山东总仓', '/system/warehouse');

-- Existing warehouse managers may read Asset-level international locations, but
-- every request remains restricted by user_workspaces.data_scope_json.
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
SELECT roles.id, permissions.code
FROM roles JOIN permissions
WHERE roles.code = 'warehouse_manager' AND permissions.code IN ('workspace:read', 'warehouse:international-read');
