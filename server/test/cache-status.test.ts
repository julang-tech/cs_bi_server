import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildApp } from '../entrypoints/app.js'

function writeConfig(dir: string, sqlitePath: string) {
  const configPath = path.join(dir, 'sync', 'config.json')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      feishu: { app_id: 'cli_xxx', app_secret: 'secret' },
      source: { app_token: 'source', table_id: 'source_table', view_id: 'source_view' },
      target: { app_token: 'target', table_id: 'target_table', view_id: 'target_view' },
      runtime: {
        state_path: './data/state.json',
        log_path: './logs/sync.log',
        sqlite_path: sqlitePath,
        refresh_interval_minutes: 120,
      },
    }),
  )
  return configPath
}

function seedCacheDatabase(sqlitePath: string) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })
  const db = new DatabaseSync(sqlitePath)
  db.exec(`
    CREATE TABLE feishu_target_records (
      record_id TEXT NOT NULL,
      source_record_id TEXT NOT NULL,
      source_record_index INTEGER NOT NULL,
      synced_at TEXT NOT NULL,
      deleted_at TEXT
    );
    INSERT INTO feishu_target_records VALUES
      ('rec-1', 'rec-1', 0, '2026-05-02T01:00:00.000Z', NULL),
      ('rec-2', 'rec-2', 0, '2026-05-02T01:05:00.000Z', NULL);

    CREATE TABLE shopify_bi_orders (
      order_id TEXT NOT NULL,
      order_no TEXT NOT NULL,
      shop_domain TEXT,
      processed_date TEXT NOT NULL,
      primary_product_type TEXT,
      first_published_at_in_order TEXT,
      is_regular_order INTEGER NOT NULL DEFAULT 1,
      is_gift_card_order INTEGER NOT NULL DEFAULT 0,
      gmv_usd REAL NOT NULL DEFAULT 0,
      revenue_usd REAL NOT NULL DEFAULT 0,
      net_revenue_usd REAL NOT NULL DEFAULT 0
    );
    INSERT INTO shopify_bi_orders VALUES
      ('gid-1', '#1', '2vnpww-33.myshopify.com', '2026-04-30', 'Category', '2026-01-01', 1, 0, 10, 9, 9),
      ('gid-2', '#2', 'lintico-fr.myshopify.com', '2026-05-01', 'Category', '2026-01-02', 1, 0, 20, 18, 18);

    CREATE TABLE shopify_bi_order_lines (
      order_id TEXT NOT NULL,
      order_no TEXT NOT NULL,
      line_key TEXT NOT NULL,
      sku TEXT,
      skc TEXT,
      spu TEXT,
      product_id TEXT,
      variant_id TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      discounted_total_usd REAL NOT NULL DEFAULT 0,
      is_insurance_item INTEGER NOT NULL DEFAULT 0,
      is_price_adjustment INTEGER NOT NULL DEFAULT 0,
      is_shipping_cost INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO shopify_bi_order_lines VALUES
      ('gid-1', '#1', 'line-1', 'SKU-1', 'SKC-1', 'SPU-1', 'product-1', 'variant-1', 1, 10, 0, 0, 0),
      ('gid-2', '#2', 'line-2', 'SKU-2', 'SKC-2', 'SPU-2', 'product-2', 'variant-2', 1, 20, 0, 0, 0);

    CREATE TABLE shopify_bi_refund_events (
      refund_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      order_no TEXT NOT NULL,
      sku TEXT,
      refund_date TEXT NOT NULL,
      refund_quantity INTEGER NOT NULL DEFAULT 1,
      refund_subtotal_usd REAL NOT NULL DEFAULT 0
    );
    INSERT INTO shopify_bi_refund_events VALUES
      ('refund-1', 'gid-2', '#2', 'SKU-1', '2026-05-01', 1, 12.5);

    CREATE TABLE shopify_bi_cache_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      ok INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      data_as_of TEXT,
      error TEXT
    );
    INSERT INTO shopify_bi_cache_runs (
      scope, date_from, date_to, ok, started_at, finished_at, data_as_of, error
    ) VALUES (
      'shopify_bi_v2', '2025-03-28', '2026-05-02', 1,
      '2026-05-02T05:00:00.000Z', '2026-05-02T05:08:00.000Z',
      '2026-05-02T04:55:00.000Z', NULL
    );
  `)
  db.close()
}

async function run() {
  const originalSyncConfigPath = process.env.SYNC_CONFIG_PATH
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bi-cache-status-'))
  const sqlitePath = path.join(tempDir, 'data', 'issues.sqlite')
  const configPath = writeConfig(tempDir, './data/issues.sqlite')
  seedCacheDatabase(sqlitePath)
  process.env.SYNC_CONFIG_PATH = configPath

  const { app } = await buildApp()
  const response = await app.inject({ method: 'GET', url: '/api/bi/cache-status' })
  const payload = response.json()
  assert.equal(response.statusCode, 200)
  assert.equal(payload.sqlite.exists, true)
  assert.equal(payload.feishu_target_records.active_count, 2)
  assert.deepEqual(payload.shopify_bi_cache.latest_success, {
    date_from: '2025-03-28',
    date_to: '2026-05-02',
    finished_at: '2026-05-02T05:08:00.000Z',
  })
  assert.equal(payload.shopify_bi_cache.max_order_date, '2026-05-01')
  assert.equal(payload.shopify_bi_cache.max_refund_date, '2026-05-01')
  assert.equal(payload.shopify_bi_cache.data_as_of, '2026-05-02T04:55:00.000Z')
  assert.equal(payload.shopify_bi_cache.orders_count, 2)
  assert.equal(payload.shopify_bi_cache.refund_events_count, 1)

  await app.close()
  if (originalSyncConfigPath === undefined) {
    delete process.env.SYNC_CONFIG_PATH
  } else {
    process.env.SYNC_CONFIG_PATH = originalSyncConfigPath
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
  console.log('Cache status API tests passed')
}

await run()
