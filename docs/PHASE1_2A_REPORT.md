# MaxCINE Phase 1.2A Implementation Report

Date: 2026-10-04
Scope: backend authorization and core international Asset model only. No new frontend pages were developed.

## Git

- Branch: `codex/website-liquid-glass-rework`
- Phase 1 baseline: `9cf6950`
- Core implementation: `1354428` — `feat: harden international phase 1.2a core`
- Transfer role/scope grant: `b7be6e2` — `fix: route transfer roles through warehouse scope`
- Asset Code immutability and reproducible Staging fixtures: `26ab4b2` — `test: lock asset identity and stage phase 1.2a fixtures`
- Existing unrelated `apps/website` and `apps/website-maintenance` changes were not staged, modified, restored, deleted or committed by Phase 1.2A.
- Production was not modified or deployed.

## Migration

### 0030 — `0030_phase1_2a_core.sql`

- Adds `assets.asset_code`.
- Backfills every existing Asset and creates `idx_assets_asset_code` unique index.
- Adds an INSERT trigger requiring Asset Code for every future Asset.
- Rebuilds `marketplace_listings` without lifetime `asset_id UNIQUE`.
- Adds historical Listing timestamps and a partial unique index allowing only one `active`/`reserved` Listing per Asset.
- Rebuilds `international_asset_allocations` with `allocation_id` primary key and historical timestamps.
- Adds a partial unique index allowing only one `reserved` Allocation per Asset.
- Rebuilds `asset_events` with precise international event types while retaining all old domestic event types.
- Converts known Phase 1 Staging international events in place without changing row IDs, titles, descriptions or timestamps.
- Adds `asset_locations.custody` with `WAREHOUSE`, `IN_TRANSIT`, `CUSTOMER`, `SERVICE_CENTER`, `RETURN_TRANSIT`.
- Adds Transfer `carrier`; `TRANSIT` remains seeded for compatibility but new Transfer APIs reject it as a physical warehouse.

Staging applied: 2026-10-04 13:02:11 Singapore time.

### 0031 — `0031_phase1_2a_transfer_role_grants.sql`

- Grants `transfer:manage` to `warehouse_manager` and `uk_fulfilment_operator`.
- This only lets those roles reach the API; Source/Destination Warehouse Scope remains mandatory.

Staging applied: 2026-10-04 13:05:06 Singapore time.

### 0032 — `0032_asset_code_immutable.sql`

- Adds a database trigger preventing Asset Code from being changed, cleared or set to NULL.
- UUID remains the database primary key; SN remains independently mutable.

Staging applied: 2026-10-04 13:09:59 Singapore time. A direct attempted update returned `SQLITE_CONSTRAINT_TRIGGER: asset_code is immutable` and did not change data.

## Data Scope Security

Centralized helpers now cover:

- `requireWorkspace`
- `requireWarehouseScope`
- `requireSalesAccountScope`
- `requireAssetAccess`
- `requireInspectionAssignment`
- `requireOrderAccess`
- `requireRmaAccess`

Enforced server-side:

- Transfer create requires Source Warehouse Scope.
- Transfer ship requires Source Warehouse Scope.
- Transfer receive requires Destination Warehouse Scope.
- Order bind requires Sales Account and Fulfilment Warehouse Scope, plus Asset warehouse/custody match.
- Order ship and deliver reload and validate Order Scope.
- RMA validates Order, Asset, Sales Account, return warehouse and market region.
- Inspection evidence/start/complete validate task assignment.

Staging direct API results:

| Check | Result |
|---|---|
| UK attempts to ship CN-SD→UK Transfer | HTTP 403, warehouse out of scope |
| CN-SD attempts to receive at UK | HTTP 403, warehouse out of scope |
| Certified operator starts another assignee's task | HTTP 403 |
| UK binds an Order from an unauthorized Sales Account | HTTP 403 |
| UK submits RMA to unauthorized CN return warehouse/region | HTTP 403 |
| UK reads delivered customer Asset | HTTP 200, no sensitive purchase/profit fields |

## Asset Code

- Test Asset `MC-P4P-000182` now has permanent Asset Code `MC-26-P4P-000182`.
- Asset Code is separate from current and historical SN.
- New Asset creation paths generate codes from a configurable prefix/product segment plus the immutable UUID identity.
- Database uniqueness, required-on-insert and immutable-on-update constraints are active.
- Automated test confirms changing SN does not change Asset Code.

## Listing History

- One Asset may have multiple Listing rows over its lifetime.
- `sold`, `cancelled`, `expired`, `ended` and other historical rows remain stored.
- Only one `active` or `reserved` Listing can exist for an Asset at a time.
- APIs added for Listing activation and cancellation.
- Staging verified: first Listing activated; second simultaneous activation returned HTTP 409; after cancelling the first, the second activated successfully. Both historical rows remain.
- The original Pocket 4P Listing was preserved and reconciled to `sold` because its historical Allocation was already fulfilled.

## Allocation History

- `allocation_id` is now the primary key.
- Historical fields: `reserved_at`, `released_at`, `fulfilled_at`, `created_at`.
- Statuses: `reserved`, `released`, `fulfilled`, `cancelled`.
- Only one active reservation per Asset is allowed by partial unique index.
- APIs support reserve, release, fulfilled through ship, and cancellation.
- Staging verified: Reservation 1 was retained as `released`; the Asset was reserved again by Order 2; Reservation 2 was retained as `cancelled`; Asset returned to `WAREHOUSE/on_hand`.
- Existing Pocket 4P Allocation was retained with a generated `allocation_id` and `fulfilled_at`.

## Lifecycle

Phase 1.2A supports machine-readable event types including:

- `asset_received`
- `inspection_assigned`
- `inspection_started`
- `inspection_completed`
- `asset_graded`
- `certification_issued`
- `certification_rejected`
- `transfer_created`
- `transfer_shipped`
- `transfer_received`
- `listing_created`
- `listing_activated`
- `listing_cancelled`
- `asset_reserved`
- `allocation_released`
- `sale_completed`
- `customer_shipped`
- `customer_delivered`
- `warranty_activated`
- `rma_opened`
- `return_received`
- `service_started`
- `service_completed`
- `recertified`
- `refund_completed`

Old domestic event types remain valid. The 14 existing Pocket 4P event rows were preserved; known international rows now use accurate event types instead of inferring semantics from Title.

## Inspection Start

- Creating a task writes `inspection_assigned` and leaves `started_at` NULL.
- `POST /certified/tasks/:id/start` moves `assigned → in_progress`, sets `started_at`, writes `inspection_started` and audits the action.
- Only the assigned operator, International operator, or global administrator may start it.
- A repeated call for an already-started task is idempotent and returns the original `startedAt`.
- Completed/failed/cancelled tasks cannot be restarted.

Staging verified:

- Assigned task start: HTTP 200.
- Repeated start: HTTP 200 with `idempotent: true` and the same timestamp.
- Different assignee: HTTP 403.

## Location / Custody

- Physical warehouses remain CN-SD, SG and UK.
- Transfer create rejects `TRANSIT` as origin or destination.
- Transfer path is `WAREHOUSE/on_hand → WAREHOUSE/reserved → IN_TRANSIT/in_transit → WAREHOUSE/on_hand`.
- Customer shipment uses `IN_TRANSIT`; delivery sets `custody=CUSTOMER`.
- Warehouse inventory queries only include `custody=WAREHOUSE`.
- Delivered Pocket 4P now returns `warehouseCode: null`, `custody: CUSTOMER`; it no longer appears in UK on-hand inventory.
- Last warehouse ID is retained internally for traceability but is not presented as current customer location.

## Automated Tests

New command: `npm run test:phase1-2a`.

Coverage includes:

- Warehouse, Sales Account, Asset, Order, RMA and Inspection Scope 403 behavior.
- Asset Code uniqueness, required value, immutability and SN independence.
- Listing historical coexistence and one-effective-Listing constraint.
- Allocation historical coexistence, release/re-reserve and one-active-reservation constraint.
- Precise Lifecycle CHECK constraint and preservation/conversion of old events.
- Assigned/Started Inspection separation.
- Custody transitions.
- Transfer role grants still requiring Warehouse Scope.

Results:

- Phase 1.2A tests: 9/9 passed.
- TypeScript typecheck: passed.
- Targeted lint for changed Phase 1.2A files: passed.
- Full-repository lint remains blocked by 14 errors in the pre-existing, out-of-scope `apps/website-maintenance/_worker.js` and `apps/website/_worker.js`; Phase 1.2A files have no lint errors.
- Shared/API/Web build: passed; existing Vite large-chunk warning remains.
- Fresh Local migrations 0001–0032: passed.
- Full Staging export replay through 0030 plus `PRAGMA foreign_key_check`: passed with no FK violations.
- Existing security suite: 29/30 passed. The single failure remains the pre-existing, out-of-scope deletion of `apps/website/functions/_middleware.js`; this file was not restored or modified.

## Staging

- API URL: `https://maxcine-api-staging.maxcine-lab.workers.dev`
- Worker version: `c44f1d3a-f094-42aa-b3a1-f63198742df5`
- Worker deployed: 2026-10-04 13:02:35 Singapore time.
- D1: `maxcine-staging-db`, migrations through 0032.
- Pages: unchanged because this phase contains no frontend changes.
- Existing Pages deployment: `1549851c-9046-49f0-8392-33c3815a24fd`.
- Quick Login remains Staging-only and was used for role-level API verification.
- Staging fixture Asset: `MC-26-P12A-000012` / SN `STG-P12A-000012`.

## Production

- No Production Migration.
- No Production Worker deployment.
- No Production Pages deployment.
- No Production D1/R2 writes.
- No Production accounts or International test data.

## Not Included / Remaining

The following were intentionally not started in Phase 1.2A:

- Certified, UK, Transfer or Asset Detail UI.
- Warranty automation or RMA completion workflow/UI.
- Formal eBay integration.
- Login authorization challenge.
- AI.
- Phase 1.2B.

Certification history remains one current Certification per Asset because certification-history redesign was outside this phase. `TRANSIT` seed data is retained for backward compatibility but is rejected by new Transfer business logic.
