# International Certified Phase 1

## Scope

This phase extends the existing MaxCINE core. `assets`, `asset_identifiers`,
`serial_numbers`, `asset_events`, `orders`, `shipments`, `after_sales_cases`
and `audit_logs` remain authoritative. It does not create a separate eBay
system, inventory ledger or lifecycle table.

## Migration

`apps/api/migrations/0028_international_certified_v1.sql` is additive. It adds
Workspace membership and JSON data-scope assignment, Certified inspection and
evidence records, Asset-level international locations/transfers, channel/account
and Listing records, plus a one-active-allocation-per-Asset lock.

The migration also adds nullable channel/account/external-order/currency/
fulfilment-warehouse fields to `orders`, and market/RMA/return fields to
`after_sales_cases`. Existing domestic rows retain their current behavior and
use the default `CNY`/`CN` values.

## Staging procedure

1. Back up and inspect the staging schema; apply migration 0028 only to staging.
2. Assign test users to the new roles and workspaces. Store permitted warehouse,
   sales-account and market identifiers in `user_workspaces.data_scope_json`.
3. Create one DJI Pocket 4P Pearl White Asset and its SN; assign it to CN-SD.
4. Run the inspection, evidence, Grade A, Final QC, certification, CN-SD to UK
   transfer, eBay UK Listing, test order allocation, UK shipment, warranty and
   RMA path. Confirm each step appears in the original `asset_events` timeline.
5. Verify a Certified account cannot list orders/prices, and a UK account cannot
   fetch CN/SG data outside its workspace scope. Re-run domestic order, inventory
   and after-sales regression tests before promotion.

## Current V1 guardrails

- Verification codes are returned once on certification issuance; D1 stores only
  a SHA-256 hash.
- `international_asset_allocations.asset_id` is unique, so a reserved Asset
  cannot be sold from a second Listing or order concurrently.
- New lifecycle labels are represented through the existing allowed event types,
  with `source = 'international-v1'` and an explicit Chinese title. This avoids
  rebuilding the production `asset_events` table in Phase 1.
