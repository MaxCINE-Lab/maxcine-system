-- Allow administrators to create orders for official/dealer channels while
-- keeping store access and inventory validation enforced by the order API.
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT id, 'order:create' FROM roles WHERE code = 'super_admin';
