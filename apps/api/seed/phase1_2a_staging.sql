-- STAGING ONLY. This file contains no passwords and does not create users.
-- It records the explicit scopes required by the existing Phase 1 test personas
-- after Phase 1.2A makes sales-account and market-region authorization strict.
UPDATE user_workspaces
SET data_scope_json = '{"warehouseIds":["wh-cn-sd","wh-sg","wh-uk"],"salesAccountIds":["account-ebay-uk-staging"],"marketRegions":["CN","SG","UK"]}'
WHERE user_id = (SELECT id FROM users WHERE email = 'stg.phase1.international@maxcine.test')
  AND workspace_id = 'ws-international';

UPDATE user_workspaces
SET data_scope_json = '{"warehouseIds":["wh-uk"],"salesAccountIds":["account-ebay-uk-staging"],"marketRegions":["UK"]}'
WHERE user_id = (SELECT id FROM users WHERE email = 'stg.phase1.uk@maxcine.test')
  AND workspace_id = 'ws-uk-fulfilment';

UPDATE user_workspaces
SET data_scope_json = '{"warehouseIds":["wh-cn-sd"],"marketRegions":["CN"]}'
WHERE user_id = (SELECT id FROM users WHERE email = 'stg.phase1.warehouse@maxcine.test')
  AND workspace_id = 'ws-warehouse';
