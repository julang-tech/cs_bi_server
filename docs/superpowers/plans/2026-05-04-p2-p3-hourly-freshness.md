# P2/P3 Hourly Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make P2/P3 serve current-period day/week/month dashboards from the hourly-refreshed Shopify BI cache and display hour-level freshness.

**Architecture:** Keep SQLite `shopify_bi_*` as the serving layer. Refresh the Shopify BI tail window on regular worker ticks, store a cache `data_as_of` derived from BigQuery mart `_dbt_updated_at`, expose it in P2/P3 API metadata, and switch P2/P3 frontend date defaults to realtime/current-period helpers.

**Tech Stack:** TypeScript, Node `node:sqlite`, BigQuery client, React, Vitest, Node assert tests.

---

## File Structure

- Modify `server/integrations/shopify-bi-cache.ts`: add cache-run `data_as_of` schema, persistence, and read APIs.
- Modify `server/domain/sync/service.ts`: query BigQuery mart freshness and pass it into cache replacement; make Shopify BI due refresh run instead of skipping on date coverage.
- Modify `server/entrypoints/sync-worker.ts`: avoid duplicate Shopify BI refresh on startup/daily while preserving interval refresh.
- Modify `server/domain/p2/service.ts`: include `meta.data_as_of` from SQLite cache and BigQuery fallback.
- Modify `server/domain/p3/models.ts` and `server/domain/p3/compute.ts`: add optional `data_as_of` to dashboard metadata.
- Modify `server/domain/p3/service.ts`: pass SQLite freshness into P3 dashboard payloads.
- Modify `server/domain/sync/cache-status.ts`: expose Shopify BI `data_as_of` for operations.
- Modify `src/api/types.ts`: add `DashboardMeta.data_as_of`.
- Create `src/shared/utils/dataAsOf.ts` and test it: format hour-level freshness timestamps.
- Modify `src/features/p2/P2Dashboard.tsx` and `src/features/p3/P3Dashboard.tsx`: use realtime periods, realtime presets, max date today, dashed current day, and `meta.data_as_of` subtitle.
- Update docs `docs/p2-refund-dashboard-api.md`, `docs/p3-formal-runtime-api.md`, `config/README.md`, and the design spec to reflect existing hourly DWD marts.

## Tasks

### Task 1: Cache Run Freshness Metadata

**Files:**
- Modify: `server/integrations/shopify-bi-cache.ts`
- Test: `server/test/sync.test.ts`
- Test: `server/test/cache-status.test.ts`

- [ ] Write failing tests:
  - `testShopifyBiCacheStoresDataAsOf` should call `replaceWindow({ dataAsOf: '2026-05-04T06:00:00.000Z', ... })`, then assert `cache.getDataAsOf('2026-05-04', '2026-05-04') === '2026-05-04T06:00:00.000Z'`.
  - cache-status test should seed `shopify_bi_cache_runs.data_as_of` and assert `payload.shopify_bi_cache.data_as_of`.
- [ ] Implement:
  - Add `data_as_of?: string | null` to `ShopifyBiCacheRun`.
  - Add `dataAsOf?: string | null` to `replaceWindow`.
  - Migrate `shopify_bi_cache_runs` with `ALTER TABLE ... ADD COLUMN data_as_of TEXT` when missing.
  - Insert `data_as_of` on successful cache runs.
  - Add `getDataAsOf(dateFrom, dateTo): string | null`.
- [ ] Run:
  - `npm run build:server --silent`
  - `node server-dist/server/test/sync.test.js`
  - `node server-dist/server/test/cache-status.test.js`

### Task 2: Sync Freshness From BigQuery

**Files:**
- Modify: `server/domain/sync/service.ts`
- Modify: `server/entrypoints/sync-worker.ts`
- Test: `server/test/sync.test.ts`
- Test: `server/test/sync-worker.test.ts`

- [ ] Write failing tests:
  - Shopify BI cache refresh mock returns `_dbt_updated_at` freshness rows and asserts `shopify_bi_cache.data_as_of`.
  - Old "skips when window covered" test becomes "refreshes even when window covered"; assert BigQuery calls are made and `skipped === false`.
  - Worker interval still calls separate Shopify BI refresh; startup/daily do not double-refresh when `syncTargetToSqlite` already refreshed caches.
- [ ] Implement:
  - Add `fetchShopifyBiDataAsOf(client)` using `MIN(MAX(_dbt_updated_at))` across `dwd_orders_fact_usd` and `dwd_refund_events`.
  - Pass `dataAsOf` into `SqliteShopifyBiCacheRepository.replaceWindow`.
  - Return `data_as_of` in `SyncShopifyBiCacheSummary`.
  - Change `syncShopifyBiCacheIfDue` to refresh the tail window instead of skipping on date coverage.
  - In the worker, call the separate Shopify BI refresh only for interval ticks, or when startup explicitly needs cache refresh but `syncTargetToSqlite` did not run it.
- [ ] Run:
  - `npm run build:server --silent`
  - `node server-dist/server/test/sync.test.js`
  - `node server-dist/server/test/sync-worker.test.js`

### Task 3: API Metadata

**Files:**
- Modify: `server/domain/p2/service.ts`
- Modify: `server/domain/p3/models.ts`
- Modify: `server/domain/p3/compute.ts`
- Modify: `server/domain/p3/service.ts`
- Test: `server/test/p2.test.ts`
- Test: `server/test/p3-api.test.ts` if present, otherwise add assertions to existing P3 tests.

- [ ] Write failing tests that assert P2 and P3 dashboard `meta.data_as_of` is populated from SQLite cache.
- [ ] Implement:
  - Extend P2 cache repository interface with `getDataAsOf`.
  - Add `data_as_of` to P2 SQLite metadata and BigQuery fallback metadata where available.
  - Extend P3 dashboard meta with optional `data_as_of`.
  - In `P3Service`, read `salesRepository.getDataAsOf?.(filters.date_from, filters.date_to)` and pass it to `buildDashboardPayload`.
- [ ] Run:
  - `npm run build:server --silent`
  - relevant server tests.

### Task 4: Frontend Current-Period Defaults

**Files:**
- Create: `src/shared/utils/dataAsOf.ts`
- Create: `src/shared/utils/dataAsOf.test.ts`
- Modify: `src/api/types.ts`
- Modify: `src/features/p2/P2Dashboard.tsx`
- Modify: `src/features/p2/P2Dashboard.metrics.test.ts`
- Modify: `src/features/p3/P3Dashboard.tsx`
- Modify: `src/features/p3/P3Dashboard.metrics.test.ts`

- [ ] Write failing tests:
  - `formatDataAsOf('2026-05-04T06:07:00.000Z')` returns a minute-level local display string.
  - P2 source test contains `getRealtimeCurrentPeriod`, `getRealtimeDefaultHistoryRange`, `getRealtimeCurrentPeriodLabel`, `currentDayIsIncomplete: true`, and no T-1 `getCurrentPeriod(grain)`.
  - P3 source test has the same realtime requirements.
- [ ] Implement:
  - Add optional `data_as_of` to `DashboardMeta`.
  - Use realtime date helpers in P2/P3.
  - Pass `maxDate={today}` and realtime preset builders to `FilterBar`.
  - Pass `{ currentDayIsIncomplete: true }` to P2/P3 `buildFocusTrend`.
  - Use `formatDataAsOf(current?.meta?.data_as_of) ?? currentPeriod.date_to` in the current section subtitle.
- [ ] Run:
  - `npm test -- --run src/shared/utils/dataAsOf.test.ts src/features/p2/P2Dashboard.metrics.test.ts src/features/p3/P3Dashboard.metrics.test.ts`

### Task 5: Docs And Final Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-05-04-p2-p3-hourly-freshness-design.md`
- Modify: `docs/p2-refund-dashboard-api.md`
- Modify: `docs/p3-formal-runtime-api.md`
- Modify: `config/README.md`

- [ ] Update docs to say existing DWD marts are hourly-refreshed and `_dbt_updated_at` drives `data_as_of`.
- [ ] Run full verification:
  - `npm run typecheck --silent`
  - `npm run build:server --silent`
  - `npm test -- --run`
  - `node server-dist/server/test/sync.test.js`
  - `node server-dist/server/test/sync-worker.test.js`
  - `node server-dist/server/test/cache-status.test.js`
  - `git diff --check`
- [ ] Commit implementation changes in logical commits.
