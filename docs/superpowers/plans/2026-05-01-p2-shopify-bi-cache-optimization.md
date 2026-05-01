# P2 Shopify BI Cache Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing SQLite BigQuery cache into a shared Shopify BI fact cache used by P2 and P3, with safe cloud migration, incremental refresh, BigQuery fallback, and short-lived in-memory response caching.

**Architecture:** Add v2 Shopify fact cache tables in the same SQLite database while keeping existing PR8 tables for compatibility during rollout. The sync worker owns all BigQuery reads and refreshes the cache by replacing date windows transactionally; P2 and P3 read from SQLite first, falling back to BigQuery only when cache coverage is missing. P2 adds a small TTL memory cache keyed by filters plus SQLite cache generation.

**Tech Stack:** Node.js, TypeScript, Fastify, `node:sqlite`, Google BigQuery client, existing `SyncService`, existing P2/P3 service tests.

---

## Rollout Model

Cloud already has `config/data/issues.sqlite`, so this must be an in-place upgrade:

```text
deploy code
  -> app and worker restart
  -> SQLite repositories run idempotent DDL migrations
  -> app can serve P2 through BigQuery fallback while cache is incomplete
  -> worker startup refreshes BI cache window
  -> P2/P3 switch to sqlite source once coverage exists
```

The first deploy must not require deleting `issues.sqlite`. Schema creation and new columns must use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and guarded `ALTER TABLE` or a small `schema_migrations` table.

## Not In Scope

- Rebuilding Feishu target mirror semantics beyond the separate `record_id` conflict fix already identified.
- Changing P2 metric definitions from PR9.
- Building a separate cache service or Redis layer.
- Replacing SQLite with BigQuery materialized views.

---

### Task 1: Add Shared Shopify BI Cache Schema

**Files:**
- Create: `server/integrations/shopify-bi-cache.ts`
- Modify: `server/test/sync.test.ts`

- [ ] **Step 1: Write the failing schema migration test**

Add this test near the existing BigQuery cache tests in `server/test/sync.test.ts`:

```ts
async function testShopifyBiCacheCreatesV2TablesWithoutDroppingLegacyCache() {
  const tmpDir = createTempDir()
  const sqlitePath = path.join(tmpDir, 'data', 'issues.sqlite')
  const legacy = new SqliteMirrorRepository(sqlitePath)
  legacy.replaceBigQueryCacheWindow({
    dateFrom: '2026-04-01',
    dateTo: '2026-04-01',
    orderLines: [{
      order_no: 'LC100',
      processed_date: '2026-04-01',
      sku: 'SKU-1',
      skc: 'SKC-1',
      spu: 'SPU-1',
      quantity: 1,
    }],
    refundEvents: [],
  })
  legacy.close()

  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(sqlitePath)
  cache.close()

  const reopened = new SqliteMirrorRepository(sqlitePath)
  assert.equal(reopened.hasBigQueryCacheRows(), true)
  const tables = reopened
    .unsafeDatabaseForTest()
    .prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'shopify_bi_orders',
          'shopify_bi_order_lines',
          'shopify_bi_refund_events',
          'shopify_bi_cache_runs'
        )
      ORDER BY name
    `)
    .all()
    .map((row) => String((row as { name: unknown }).name))
  assert.deepEqual(tables, [
    'shopify_bi_cache_runs',
    'shopify_bi_order_lines',
    'shopify_bi_orders',
    'shopify_bi_refund_events',
  ])
  reopened.close()
}
```

Also add the function call before the final `console.log`:

```ts
await testShopifyBiCacheCreatesV2TablesWithoutDroppingLegacyCache()
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/sync.test.js
```

Expected: fail because `../integrations/shopify-bi-cache.js` does not exist.

- [ ] **Step 3: Add a test-only SQLite accessor to the existing repository**

Modify `server/integrations/sqlite.ts` inside `SqliteMirrorRepository`:

```ts
  unsafeDatabaseForTest() {
    return this.db
  }
```

This is intentionally named as unsafe and must only be used by tests.

- [ ] **Step 4: Create the v2 cache repository and DDL**

Create `server/integrations/shopify-bi-cache.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

export type ShopifyBiOrder = {
  order_id: string
  order_no: string
  shop_domain: string | null
  processed_date: string
  primary_product_type: string | null
  first_published_at_in_order: string | null
  is_regular_order: boolean
  is_gift_card_order: boolean
  gmv_usd: number
  revenue_usd: number
  net_revenue_usd: number
}

export type ShopifyBiOrderLine = {
  order_id: string
  order_no: string
  line_key: string
  sku: string | null
  skc: string | null
  spu: string | null
  product_id: string | null
  variant_id: string | null
  quantity: number
  discounted_total_usd: number
  is_insurance_item: boolean
  is_price_adjustment: boolean
  is_shipping_cost: boolean
}

export type ShopifyBiRefundEvent = {
  refund_id: string
  order_id: string
  order_no: string
  sku: string | null
  refund_date: string
  refund_quantity: number
  refund_subtotal_usd: number
}

export type ShopifyBiCacheRun = {
  scope: 'shopify_bi_v2'
  date_from: string
  date_to: string
  ok: boolean
  started_at: string
  finished_at: string | null
  error?: string | null
}

export class SqliteShopifyBiCacheRepository {
  private readonly db: DatabaseSync

  constructor(private readonly dbPath: string) {
    ensureParentDir(dbPath)
    this.db = new DatabaseSync(dbPath)
    this.ensureSchema()
  }

  close() {
    this.db.close()
  }

  private ensureSchema() {
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shopify_bi_orders (
        order_id TEXT PRIMARY KEY,
        order_no TEXT NOT NULL,
        shop_domain TEXT,
        processed_date TEXT NOT NULL,
        primary_product_type TEXT,
        first_published_at_in_order TEXT,
        is_regular_order INTEGER NOT NULL,
        is_gift_card_order INTEGER NOT NULL,
        gmv_usd REAL NOT NULL DEFAULT 0,
        revenue_usd REAL NOT NULL DEFAULT 0,
        net_revenue_usd REAL NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL
      );
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_shopify_bi_orders_date ON shopify_bi_orders(processed_date);')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_shopify_bi_orders_no ON shopify_bi_orders(order_no);')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_shopify_bi_orders_filters ON shopify_bi_orders(shop_domain, primary_product_type, first_published_at_in_order);')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shopify_bi_order_lines (
        order_id TEXT NOT NULL,
        order_no TEXT NOT NULL,
        line_key TEXT NOT NULL,
        sku TEXT,
        skc TEXT,
        spu TEXT,
        product_id TEXT,
        variant_id TEXT,
        quantity INTEGER NOT NULL DEFAULT 0,
        discounted_total_usd REAL NOT NULL DEFAULT 0,
        is_insurance_item INTEGER NOT NULL DEFAULT 0,
        is_price_adjustment INTEGER NOT NULL DEFAULT 0,
        is_shipping_cost INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (order_id, line_key)
      );
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_shopify_bi_order_lines_order ON shopify_bi_order_lines(order_id);')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_shopify_bi_order_lines_product ON shopify_bi_order_lines(sku, skc, spu);')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shopify_bi_refund_events (
        refund_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        order_no TEXT NOT NULL,
        sku TEXT,
        refund_date TEXT NOT NULL,
        refund_quantity INTEGER NOT NULL DEFAULT 0,
        refund_subtotal_usd REAL NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL
      );
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_shopify_bi_refund_events_date ON shopify_bi_refund_events(refund_date);')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_shopify_bi_refund_events_order ON shopify_bi_refund_events(order_id, sku);')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shopify_bi_cache_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        date_from TEXT NOT NULL,
        date_to TEXT NOT NULL,
        ok INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
      );
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_shopify_bi_cache_runs_scope ON shopify_bi_cache_runs(scope, ok, date_from, date_to);')
  }
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/sync.test.js
```

Expected: `Sync tests passed`.

- [ ] **Step 6: Commit**

```bash
git add server/integrations/sqlite.ts server/integrations/shopify-bi-cache.ts server/test/sync.test.ts
git commit -m "feat(sync): add shared Shopify BI cache schema"
```

---

### Task 2: Implement Transactional Window Replacement And Coverage Metadata

**Files:**
- Modify: `server/integrations/shopify-bi-cache.ts`
- Modify: `server/test/sync.test.ts`

- [ ] **Step 1: Write the failing replace-window test**

Add this test to `server/test/sync.test.ts`:

```ts
async function testShopifyBiCacheReplacesDateWindowTransactionally() {
  const tmpDir = createTempDir()
  const sqlitePath = path.join(tmpDir, 'data', 'issues.sqlite')
  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(sqlitePath)

  cache.replaceWindow({
    dateFrom: '2026-04-01',
    dateTo: '2026-04-02',
    orders: [{
      order_id: 'order-1',
      order_no: 'LC100',
      shop_domain: '2vnpww-33.myshopify.com',
      processed_date: '2026-04-01',
      primary_product_type: 'Dress',
      first_published_at_in_order: '2026-03-20',
      is_regular_order: true,
      is_gift_card_order: false,
      gmv_usd: 120,
      revenue_usd: 100,
      net_revenue_usd: 90,
    }],
    orderLines: [{
      order_id: 'order-1',
      order_no: 'LC100',
      line_key: 'order-1:SKU-1:0',
      sku: 'SKU-1-M',
      skc: 'SKU-1',
      spu: 'SKU',
      product_id: 'prod-1',
      variant_id: 'var-1',
      quantity: 2,
      discounted_total_usd: 100,
      is_insurance_item: false,
      is_price_adjustment: false,
      is_shipping_cost: false,
    }],
    refundEvents: [{
      refund_id: 'refund-1',
      order_id: 'order-1',
      order_no: 'LC100',
      sku: 'SKU-1-M',
      refund_date: '2026-04-02',
      refund_quantity: 1,
      refund_subtotal_usd: 50,
    }],
  })

  cache.replaceWindow({
    dateFrom: '2026-04-01',
    dateTo: '2026-04-02',
    orders: [],
    orderLines: [],
    refundEvents: [],
  })

  assert.equal(cache.hasCoverage('2026-04-01', '2026-04-02'), true)
  assert.equal(cache.getGeneration('2026-04-01', '2026-04-02').length > 0, true)
  assert.deepEqual(cache.queryP2Overview({
    date_from: '2026-04-01',
    date_to: '2026-04-02',
    grain: 'month',
  }).cards, {
    order_count: 0,
    sales_qty: 0,
    refund_order_count: 0,
    refund_amount: 0,
    gmv: 0,
    net_received_amount: 0,
    net_revenue_amount: 0,
    refund_amount_ratio: 0,
    avg_order_amount: 0,
  })
  cache.close()
}
```

Also call it:

```ts
await testShopifyBiCacheReplacesDateWindowTransactionally()
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/sync.test.js
```

Expected: fail because `replaceWindow`, `hasCoverage`, `getGeneration`, and `queryP2Overview` do not exist.

- [ ] **Step 3: Implement window replacement and metadata**

Add these methods to `SqliteShopifyBiCacheRepository`:

```ts
  replaceWindow(input: {
    dateFrom: string
    dateTo: string
    orders: ShopifyBiOrder[]
    orderLines: ShopifyBiOrderLine[]
    refundEvents: ShopifyBiRefundEvent[]
    startedAt?: string
    finishedAt?: string
  }) {
    const startedAt = input.startedAt ?? new Date().toISOString()
    const finishedAt = input.finishedAt ?? new Date().toISOString()
    const syncedAt = finishedAt

    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM shopify_bi_orders WHERE processed_date BETWEEN ? AND ?').run(input.dateFrom, input.dateTo)
      this.db.prepare(`
        DELETE FROM shopify_bi_order_lines
        WHERE order_id NOT IN (SELECT order_id FROM shopify_bi_orders)
      `).run()
      this.db.prepare('DELETE FROM shopify_bi_refund_events WHERE refund_date BETWEEN ? AND ?').run(input.dateFrom, input.dateTo)

      const insertOrder = this.db.prepare(`
        INSERT INTO shopify_bi_orders (
          order_id, order_no, shop_domain, processed_date, primary_product_type,
          first_published_at_in_order, is_regular_order, is_gift_card_order,
          gmv_usd, revenue_usd, net_revenue_usd, synced_at
        ) VALUES (
          :order_id, :order_no, :shop_domain, :processed_date, :primary_product_type,
          :first_published_at_in_order, :is_regular_order, :is_gift_card_order,
          :gmv_usd, :revenue_usd, :net_revenue_usd, :synced_at
        )
      `)
      const insertLine = this.db.prepare(`
        INSERT INTO shopify_bi_order_lines (
          order_id, order_no, line_key, sku, skc, spu, product_id, variant_id,
          quantity, discounted_total_usd, is_insurance_item,
          is_price_adjustment, is_shipping_cost, synced_at
        ) VALUES (
          :order_id, :order_no, :line_key, :sku, :skc, :spu, :product_id, :variant_id,
          :quantity, :discounted_total_usd, :is_insurance_item,
          :is_price_adjustment, :is_shipping_cost, :synced_at
        )
      `)
      const insertRefund = this.db.prepare(`
        INSERT INTO shopify_bi_refund_events (
          refund_id, order_id, order_no, sku, refund_date,
          refund_quantity, refund_subtotal_usd, synced_at
        ) VALUES (
          :refund_id, :order_id, :order_no, :sku, :refund_date,
          :refund_quantity, :refund_subtotal_usd, :synced_at
        )
      `)

      for (const order of input.orders) {
        insertOrder.run({
          ...order,
          is_regular_order: order.is_regular_order ? 1 : 0,
          is_gift_card_order: order.is_gift_card_order ? 1 : 0,
          synced_at: syncedAt,
        })
      }
      for (const line of input.orderLines) {
        insertLine.run({
          ...line,
          is_insurance_item: line.is_insurance_item ? 1 : 0,
          is_price_adjustment: line.is_price_adjustment ? 1 : 0,
          is_shipping_cost: line.is_shipping_cost ? 1 : 0,
          synced_at: syncedAt,
        })
      }
      for (const refund of input.refundEvents) {
        insertRefund.run({ ...refund, synced_at: syncedAt })
      }

      this.db.prepare(`
        INSERT INTO shopify_bi_cache_runs (
          scope, date_from, date_to, ok, started_at, finished_at, error
        ) VALUES ('shopify_bi_v2', ?, ?, 1, ?, ?, NULL)
      `).run(input.dateFrom, input.dateTo, startedAt, finishedAt)
    })

    tx()
    return {
      orders_upserted: input.orders.length,
      order_lines_upserted: input.orderLines.length,
      refund_events_upserted: input.refundEvents.length,
    }
  }

  hasCoverage(dateFrom: string, dateTo: string) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM shopify_bi_cache_runs
      WHERE scope = 'shopify_bi_v2'
        AND ok = 1
        AND date_from <= ?
        AND date_to >= ?
    `).get(dateFrom, dateTo) as { count: number } | undefined
    return Number(row?.count ?? 0) > 0
  }

  getGeneration(dateFrom: string, dateTo: string) {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(finished_at), '') AS generation
      FROM shopify_bi_cache_runs
      WHERE scope = 'shopify_bi_v2'
        AND ok = 1
        AND date_from <= ?
        AND date_to >= ?
    `).get(dateFrom, dateTo) as { generation: string } | undefined
    return String(row?.generation ?? '')
  }
```

- [ ] **Step 4: Implement the initial P2 overview SQLite aggregation**

Add this method in the same class:

```ts
  queryP2Overview(filters: {
    date_from: string
    date_to: string
    grain: 'day' | 'week' | 'month'
    category?: string
    spu?: string
    skc?: string
    channel?: string
    listing_date_from?: string
    listing_date_to?: string
  }) {
    const params = {
      date_from: filters.date_from,
      date_to: filters.date_to,
      category: filters.category ?? '',
      spu: filters.spu ?? '',
      skc: filters.skc ?? '',
      channel: filters.channel ?? '',
      listing_date_from: filters.listing_date_from ?? '',
      listing_date_to: filters.listing_date_to ?? '',
    }
    const row = this.db.prepare(`
      WITH filtered_orders AS (
        SELECT DISTINCT o.*
        FROM shopify_bi_orders o
        LEFT JOIN shopify_bi_order_lines li ON li.order_id = o.order_id
        WHERE o.processed_date BETWEEN @date_from AND @date_to
          AND o.is_gift_card_order = 0
          AND o.is_regular_order = 1
          AND (@category = '' OR o.primary_product_type = @category)
          AND (@channel = '' OR o.shop_domain = @channel)
          AND (@listing_date_from = '' OR o.first_published_at_in_order >= @listing_date_from)
          AND (@listing_date_to = '' OR o.first_published_at_in_order <= @listing_date_to)
          AND (@skc = '' OR li.skc = @skc)
          AND (@spu = '' OR li.spu = @spu)
      ),
      sales_qty AS (
        SELECT COALESCE(SUM(li.quantity), 0) AS value
        FROM filtered_orders o
        JOIN shopify_bi_order_lines li ON li.order_id = o.order_id
        WHERE li.is_insurance_item = 0
          AND li.is_price_adjustment = 0
          AND li.is_shipping_cost = 0
      ),
      refunds AS (
        SELECT
          COUNT(DISTINCT re.order_id) AS refund_order_count,
          COALESCE(SUM(re.refund_subtotal_usd), 0) AS refund_amount
        FROM shopify_bi_refund_events re
        JOIN filtered_orders o ON o.order_id = re.order_id
        WHERE re.refund_date BETWEEN @date_from AND @date_to
      )
      SELECT
        COUNT(DISTINCT o.order_id) AS order_count,
        COALESCE((SELECT value FROM sales_qty), 0) AS sales_qty,
        COALESCE(SUM(o.gmv_usd), 0) AS gmv,
        COALESCE(SUM(o.revenue_usd), 0) AS net_received_amount,
        COALESCE(SUM(o.net_revenue_usd), 0) AS net_revenue_amount,
        COALESCE((SELECT refund_order_count FROM refunds), 0) AS refund_order_count,
        COALESCE((SELECT refund_amount FROM refunds), 0) AS refund_amount
      FROM filtered_orders o
    `).get(params) as Record<string, unknown> | undefined

    const orderCount = Number(row?.order_count ?? 0)
    const netReceived = Number(row?.net_received_amount ?? 0)
    const refundAmount = Number(row?.refund_amount ?? 0)
    return {
      cards: {
        order_count: orderCount,
        sales_qty: Number(row?.sales_qty ?? 0),
        refund_order_count: Number(row?.refund_order_count ?? 0),
        refund_amount: refundAmount,
        gmv: Number(row?.gmv ?? 0),
        net_received_amount: netReceived,
        net_revenue_amount: Number(row?.net_revenue_amount ?? 0),
        refund_amount_ratio: netReceived ? refundAmount / netReceived : 0,
        avg_order_amount: orderCount ? netReceived / orderCount : 0,
      },
    }
  }
```

- [ ] **Step 5: Run the test**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/sync.test.js
```

Expected: `Sync tests passed`.

- [ ] **Step 6: Commit**

```bash
git add server/integrations/shopify-bi-cache.ts server/test/sync.test.ts
git commit -m "feat(sync): replace Shopify BI cache windows"
```

---

### Task 3: Refresh Unified Cache From BigQuery In SyncService

**Files:**
- Modify: `server/domain/sync/service.ts`
- Modify: `server/test/sync.test.ts`

- [ ] **Step 1: Write the failing sync test for v2 cache refresh**

Add this test to `server/test/sync.test.ts`:

```ts
async function testSyncRefreshesShopifyBiV2Cache() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const service = new SyncService({
    createClient: () => ({
      listRecords: async () => [],
      listFields: async () => [],
      createRecord: async () => ({ record_id: 'unused' }),
      updateRecord: async () => undefined,
    }),
    createBigQueryClient: () => ({
      async query(options: unknown) {
        const sql = String((options as { query: string }).query)
        if (sql.includes('dwd_orders_fact_usd')) {
          return [[{
            order_id: 'order-1',
            order_no: 'LC100',
            shop_domain: '2vnpww-33.myshopify.com',
            processed_date: '2026-04-01',
            primary_product_type: 'Dress',
            first_published_at_in_order: '2026-03-20',
            is_regular_order: true,
            is_gift_card_order: false,
            gmv_usd: 120,
            revenue_usd: 100,
            net_revenue_usd: 90,
          }]]
        }
        if (sql.includes('int_line_items_classified')) {
          return [[{
            order_id: 'order-1',
            order_no: 'LC100',
            line_key: 'order-1:SKU-1:0',
            sku: 'SKU-1-M',
            skc: 'SKU-1',
            spu: 'SKU',
            product_id: 'prod-1',
            variant_id: 'var-1',
            quantity: 2,
            discounted_total_usd: 100,
            is_insurance_item: false,
            is_price_adjustment: false,
            is_shipping_cost: false,
          }]]
        }
        if (sql.includes('dwd_refund_events')) {
          return [[{
            refund_id: 'refund-1',
            order_id: 'order-1',
            order_no: 'LC100',
            sku: 'SKU-1-M',
            refund_date: '2026-04-02',
            refund_quantity: 1,
            refund_subtotal_usd: 50,
          }]]
        }
        return [[]]
      },
    }),
  })

  const result = await service.syncTargetToSqlite({ config: configPath })
  assert.equal(result.shopify_bi_cache?.enabled, true)
  assert.equal(result.shopify_bi_cache?.ok, true)
  assert.equal(result.shopify_bi_cache?.orders_upserted, 1)
  assert.equal(result.shopify_bi_cache?.order_lines_upserted, 1)
  assert.equal(result.shopify_bi_cache?.refund_events_upserted, 1)
}
```

Call it:

```ts
await testSyncRefreshesShopifyBiV2Cache()
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/sync.test.js
```

Expected: fail because `shopify_bi_cache` does not exist on the sync result.

- [ ] **Step 3: Add v2 cache summary types and imports**

Modify `server/domain/sync/service.ts`:

```ts
import {
  SqliteShopifyBiCacheRepository,
  type ShopifyBiOrder,
  type ShopifyBiOrderLine,
  type ShopifyBiRefundEvent,
} from '../../integrations/shopify-bi-cache.js'
```

Add a summary type:

```ts
type SyncShopifyBiCacheSummary = {
  enabled: boolean
  ok: boolean
  date_from: string
  date_to: string
  orders_upserted: number
  order_lines_upserted: number
  refund_events_upserted: number
  failed: number
  error?: string
}
```

- [ ] **Step 4: Add BigQuery fetchers for v2 facts**

Add methods beside the existing PR8 `fetchBigQueryOrderLines` and `fetchBigQueryRefundEvents`:

```ts
  private async fetchShopifyBiOrders(client: BigQueryLike, dateFrom: string, dateTo: string): Promise<ShopifyBiOrder[]> {
    const rows = extractRows(await client.query({
      query: `
SELECT
  CAST(o.order_id AS STRING) AS order_id,
  CAST(o.order_name AS STRING) AS order_no,
  CAST(o.shop_domain AS STRING) AS shop_domain,
  CAST(o.processed_date AS STRING) AS processed_date,
  CAST(o.primary_product_type AS STRING) AS primary_product_type,
  CAST(DATE(o.first_published_at_in_order) AS STRING) AS first_published_at_in_order,
  COALESCE(o.is_regular_order, FALSE) AS is_regular_order,
  COALESCE(o.is_gift_card_order, FALSE) AS is_gift_card_order,
  COALESCE(o.cs_bi_gmv_usd, 0) AS gmv_usd,
  COALESCE(o.cs_bi_revenue_usd, 0) AS revenue_usd,
  COALESCE(o.cs_bi_net_revenue_usd, 0) AS net_revenue_usd
FROM \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
      `,
      params: { date_from: dateFrom, date_to: dateTo },
    }))

    return rows.map((row) => ({
      order_id: String(row.order_id ?? ''),
      order_no: String(row.order_no ?? ''),
      shop_domain: normalizeNullableText(row.shop_domain),
      processed_date: String(row.processed_date ?? ''),
      primary_product_type: normalizeNullableText(row.primary_product_type),
      first_published_at_in_order: normalizeNullableText(row.first_published_at_in_order),
      is_regular_order: Boolean(row.is_regular_order),
      is_gift_card_order: Boolean(row.is_gift_card_order),
      gmv_usd: Number(row.gmv_usd ?? 0),
      revenue_usd: Number(row.revenue_usd ?? 0),
      net_revenue_usd: Number(row.net_revenue_usd ?? 0),
    })).filter((row) => row.order_id && row.order_no && row.processed_date)
  }
```

Add equivalent methods for order lines and refund events using current P2 SQL sources:

```ts
  private async fetchShopifyBiOrderLines(client: BigQueryLike, dateFrom: string, dateTo: string): Promise<ShopifyBiOrderLine[]> {
    const rows = extractRows(await client.query({
      query: `
SELECT
  CAST(li.order_id AS STRING) AS order_id,
  CAST(o.order_name AS STRING) AS order_no,
  CONCAT(CAST(li.order_id AS STRING), ':', COALESCE(CAST(li.sku AS STRING), ''), ':', CAST(ROW_NUMBER() OVER (PARTITION BY li.order_id ORDER BY li.sku, li.variant_id, li.product_id) AS STRING)) AS line_key,
  CAST(li.sku AS STRING) AS sku,
  CASE
    WHEN li.sku IS NULL OR TRIM(li.sku) = '' THEN 'N/A'
    WHEN STRPOS(TRIM(li.sku), '-') > 0 THEN REGEXP_REPLACE(TRIM(li.sku), r'-[^-]+$', '')
    ELSE TRIM(li.sku)
  END AS skc,
  CAST(li.product_id AS STRING) AS spu,
  CAST(li.product_id AS STRING) AS product_id,
  CAST(li.variant_id AS STRING) AS variant_id,
  COALESCE(li.quantity, 0) AS quantity,
  COALESCE(CAST(li.discounted_total AS NUMERIC) * COALESCE(CAST(o.usd_fx_rate AS NUMERIC), 1), 0) AS discounted_total_usd,
  COALESCE(li.is_insurance_item, FALSE) AS is_insurance_item,
  COALESCE(li.is_price_adjustment, FALSE) AS is_price_adjustment,
  COALESCE(li.is_shipping_cost, FALSE) AS is_shipping_cost
FROM \`julang-dev-database.shopify_intermediate.int_line_items_classified\` li
JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
  ON o.order_id = li.order_id
WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
      `,
      params: { date_from: dateFrom, date_to: dateTo },
    }))

    return rows.map((row) => ({
      order_id: String(row.order_id ?? ''),
      order_no: String(row.order_no ?? ''),
      line_key: String(row.line_key ?? ''),
      sku: normalizeNullableText(row.sku),
      skc: normalizeNullableText(row.skc),
      spu: normalizeNullableText(row.spu),
      product_id: normalizeNullableText(row.product_id),
      variant_id: normalizeNullableText(row.variant_id),
      quantity: Number(row.quantity ?? 0),
      discounted_total_usd: Number(row.discounted_total_usd ?? 0),
      is_insurance_item: Boolean(row.is_insurance_item),
      is_price_adjustment: Boolean(row.is_price_adjustment),
      is_shipping_cost: Boolean(row.is_shipping_cost),
    })).filter((row) => row.order_id && row.order_no && row.line_key)
  }
```

```ts
  private async fetchShopifyBiRefundEvents(client: BigQueryLike, dateFrom: string, dateTo: string): Promise<ShopifyBiRefundEvent[]> {
    const rows = extractRows(await client.query({
      query: `
SELECT
  CONCAT(CAST(re.order_id AS STRING), ':', COALESCE(CAST(re.sku AS STRING), ''), ':', CAST(re.refund_date AS STRING), ':', CAST(ROW_NUMBER() OVER (PARTITION BY re.order_id, re.sku, re.refund_date ORDER BY re.refund_subtotal) AS STRING)) AS refund_id,
  CAST(re.order_id AS STRING) AS order_id,
  CAST(o.order_name AS STRING) AS order_no,
  CAST(re.sku AS STRING) AS sku,
  CAST(re.refund_date AS STRING) AS refund_date,
  COALESCE(re.quantity, 0) AS refund_quantity,
  COALESCE(CAST(re.refund_subtotal AS NUMERIC) * COALESCE(CAST(o.usd_fx_rate AS NUMERIC), 1), 0) AS refund_subtotal_usd
FROM \`julang-dev-database.shopify_dwd.dwd_refund_events\` re
JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
  ON re.order_id = o.order_id
WHERE re.refund_date BETWEEN DATE(@date_from) AND DATE(@date_to)
      `,
      params: { date_from: dateFrom, date_to: dateTo },
    }))

    return rows.map((row) => ({
      refund_id: String(row.refund_id ?? ''),
      order_id: String(row.order_id ?? ''),
      order_no: String(row.order_no ?? ''),
      sku: normalizeNullableText(row.sku),
      refund_date: String(row.refund_date ?? ''),
      refund_quantity: Number(row.refund_quantity ?? 0),
      refund_subtotal_usd: Number(row.refund_subtotal_usd ?? 0),
    })).filter((row) => row.refund_id && row.order_id && row.order_no && row.refund_date)
  }
```

- [ ] **Step 5: Add `syncShopifyBiCache` and wire it into `syncTargetToSqlite`**

Add:

```ts
  private async syncShopifyBiCache(config: SyncConfig, sqlitePath: string, logger: SyncLogger): Promise<SyncShopifyBiCacheSummary> {
    const { dateFrom, dateTo } = resolveBigQueryCacheWindow()
    const client = this.createBigQueryClient(config, logger)
    if (!client) {
      return {
        enabled: false,
        ok: true,
        date_from: dateFrom,
        date_to: dateTo,
        orders_upserted: 0,
        order_lines_upserted: 0,
        refund_events_upserted: 0,
        failed: 0,
      }
    }

    const startedAt = new Date().toISOString()
    let repository: SqliteShopifyBiCacheRepository | null = null
    try {
      const [orders, orderLines, refundEvents] = await Promise.all([
        this.fetchShopifyBiOrders(client, dateFrom, dateTo),
        this.fetchShopifyBiOrderLines(client, dateFrom, dateTo),
        this.fetchShopifyBiRefundEvents(client, dateFrom, dateTo),
      ])
      repository = new SqliteShopifyBiCacheRepository(sqlitePath)
      const stats = repository.replaceWindow({
        dateFrom,
        dateTo,
        orders,
        orderLines,
        refundEvents,
        startedAt,
        finishedAt: new Date().toISOString(),
      })
      logger.info(`Shopify BI cache synced to ${sqlitePath}: orders=${stats.orders_upserted}, order_lines=${stats.order_lines_upserted}, refund_events=${stats.refund_events_upserted}.`)
      return {
        enabled: true,
        ok: true,
        date_from: dateFrom,
        date_to: dateTo,
        ...stats,
        failed: 0,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Shopify BI cache sync failed: ${message}`)
      return {
        enabled: true,
        ok: false,
        date_from: dateFrom,
        date_to: dateTo,
        orders_upserted: 0,
        order_lines_upserted: 0,
        refund_events_upserted: 0,
        failed: 1,
        error: message,
      }
    } finally {
      repository?.close()
    }
  }
```

In `syncTargetToSqlite`, call both the legacy PR8 cache and the v2 cache for one release:

```ts
const bigqueryCache = await this.syncBigQueryCache(config, sqlitePath, logger)
const shopifyBiCache = await this.syncShopifyBiCache(config, sqlitePath, logger)
if (!shopifyBiCache.ok) {
  failed += 1
}
```

Return `shopify_bi_cache: shopifyBiCache`.

- [ ] **Step 6: Run sync tests**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/sync.test.js
```

Expected: `Sync tests passed`.

- [ ] **Step 7: Commit**

```bash
git add server/domain/sync/service.ts server/test/sync.test.ts
git commit -m "feat(sync): refresh shared Shopify BI cache"
```

---

### Task 4: Split Feishu Interval Refresh From Shopify BI Daily Refresh

**Files:**
- Modify: `server/entrypoints/sync-worker.ts`
- Modify: `server/test/sync-worker.test.ts`
- Modify: `docs/p3-formal-runtime-api.md`

- [ ] **Step 1: Write the failing worker scheduling test**

Add to `server/test/sync-worker.test.ts`:

```ts
async function testWorkerSkipsShopifyBiCacheWhenDailyRefreshAlreadySucceeded() {
  const calls: string[] = []
  const worker = createSyncWorker({
    configPath: createWorkerConfig(),
    intervalMs: 100,
    logger: createMemoryLogger(),
    service: {
      async syncTargetToSqlite() {
        calls.push('feishu')
        return {
          created: 0,
          updated: 0,
          failed: 0,
          sqlite: { ok: true, inserted: 0, updated: 0, deleted: 0, sqlite_failed: 0 },
          bigquery_cache: { enabled: true, ok: true, order_lines_upserted: 0, refund_events_upserted: 0, failed: 0 },
          shopify_bi_cache: { enabled: true, ok: true, orders_upserted: 0, order_lines_upserted: 0, refund_events_upserted: 0, failed: 0 },
        }
      },
      async syncShopifyBiCacheIfDue() {
        calls.push('shopify-bi')
        return { enabled: true, ok: true, skipped: true, failed: 0 }
      },
    },
  })

  await worker.runOnce('interval')
  assert.deepEqual(calls, ['feishu', 'shopify-bi'])
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/sync-worker.test.js
```

Expected: fail because the worker service type does not include `syncShopifyBiCacheIfDue`.

- [ ] **Step 3: Extend worker service contract**

Modify `server/entrypoints/sync-worker.ts`:

```ts
type WorkerService = {
  syncTargetToSqlite: (options: { config: string; refreshBigQueryCache?: boolean }) => Promise<{
    created: number
    updated: number
    failed: number
    sqlite: { ok: boolean; inserted: number; updated: number; deleted: number; sqlite_failed: number }
    bigquery_cache?: { enabled: boolean; ok: boolean; order_lines_upserted: number; refund_events_upserted: number; failed: number }
    shopify_bi_cache?: { enabled: boolean; ok: boolean; orders_upserted: number; order_lines_upserted: number; refund_events_upserted: number; failed: number }
  }>
  syncShopifyBiCacheIfDue?: (options: { config: string }) => Promise<{
    enabled: boolean
    ok: boolean
    skipped?: boolean
    failed: number
  }>
}
```

- [ ] **Step 4: Change worker flow**

In `runOnce`, call Feishu mirror without legacy BigQuery refresh on interval, then call v2 daily due check:

```ts
const result = await service.syncTargetToSqlite({
  config: options.configPath,
  refreshBigQueryCache: trigger === 'startup',
})

const shopifyBi = service.syncShopifyBiCacheIfDue
  ? await service.syncShopifyBiCacheIfDue({ config: options.configPath })
  : undefined
```

Log `shopifyBi.skipped` explicitly so production logs show whether the BI cache ran.

- [ ] **Step 5: Implement `SyncService.syncShopifyBiCacheIfDue`**

Add to `server/domain/sync/service.ts`:

```ts
async syncShopifyBiCacheIfDue(options: { config: string }) {
  const config = loadSyncConfig(options.config)
  const sqlitePath = resolveRuntimePath(options.config, config.runtime.sqlite_path)
  const logger = createLogger(resolveRuntimePath(options.config, config.runtime.log_path))
  const { dateFrom, dateTo } = resolveBigQueryCacheWindow()
  const repository = new SqliteShopifyBiCacheRepository(sqlitePath)
  try {
    if (repository.hasCoverage(dateFrom, dateTo)) {
      logger.info(`Shopify BI cache skipped: existing coverage for ${dateFrom} to ${dateTo}.`)
      return { enabled: true, ok: true, skipped: true, failed: 0 }
    }
  } finally {
    repository.close()
  }
  return this.syncShopifyBiCache(config, sqlitePath, logger)
}
```

- [ ] **Step 6: Document the schedule**

Add to `docs/p3-formal-runtime-api.md`:

```md
### Shopify BI SQLite Cache Refresh

The sync worker maintains two SQLite-backed datasets:

- Feishu target mirror: refreshed on `runtime.refresh_interval_minutes`.
- Shopify BI cache: refreshed by date-window coverage. On worker startup and interval ticks, the worker checks whether the current cache window has a successful `shopify_bi_v2` run. If not, it refreshes the window from BigQuery.

P2 and P3 read Shopify metrics from SQLite when the requested date range is covered. P2 may temporarily fall back to BigQuery while a first deployment backfill is still running.
```

- [ ] **Step 7: Run tests**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/sync-worker.test.js
npm run build:server --silent && node server-dist/server/test/sync.test.js
```

Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add server/entrypoints/sync-worker.ts server/domain/sync/service.ts server/test/sync-worker.test.ts docs/p3-formal-runtime-api.md
git commit -m "feat(worker): refresh Shopify BI cache by coverage"
```

---

### Task 5: Make P2 Read SQLite First With BigQuery Fallback

**Files:**
- Modify: `server/domain/p2/service.ts`
- Modify: `server/entrypoints/app.ts`
- Modify: `server/test/p2.test.ts`

- [ ] **Step 1: Write a failing P2 SQLite-first test**

Add to `server/test/p2.test.ts`:

```ts
async function testOverviewUsesSqliteCacheWhenCovered() {
  const sqliteCalls: string[] = []
  const bigQuery = createClient([[{ order_count: 999 }]])
  const service = new P2Service(bigQuery.client, {
    hasCoverage: () => true,
    getGeneration: () => 'generation-1',
    queryP2Overview: (filters) => {
      sqliteCalls.push(filters.date_from)
      return {
        cards: {
          order_count: 1,
          sales_qty: 2,
          refund_order_count: 1,
          refund_amount: 50,
          gmv: 120,
          net_received_amount: 100,
          net_revenue_amount: 90,
          refund_amount_ratio: 0.5,
          avg_order_amount: 100,
        },
      }
    },
  })

  const payload = await service.getOverview(createFilters())

  assert.deepEqual(sqliteCalls, ['2026-03-31'])
  assert.equal(bigQuery.calls.length, 0)
  assert.equal(payload.cards.order_count, 1)
  assert.equal(payload.meta.source_mode, 'sqlite_shopify_bi_cache')
}
```

Add:

```ts
await testOverviewUsesSqliteCacheWhenCovered()
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/p2.test.js
```

Expected: fail because `P2Service` does not accept a SQLite cache dependency and meta lacks `source_mode`.

- [ ] **Step 3: Add P2 cache interface**

Modify `server/domain/p2/service.ts`:

```ts
type P2CacheRepository = {
  hasCoverage(dateFrom: string, dateTo: string): boolean
  getGeneration(dateFrom: string, dateTo: string): string
  queryP2Overview(filters: P2Filters): {
    cards: {
      order_count: number
      sales_qty: number
      refund_order_count: number
      refund_amount: number
      gmv: number
      net_received_amount: number
      net_revenue_amount: number
      refund_amount_ratio: number
      avg_order_amount: number
    }
  }
}
```

Change constructor:

```ts
export class P2Service {
  constructor(
    private readonly client: BigQueryLike | null,
    private readonly cacheRepository: P2CacheRepository | null = null,
  ) {}
```

- [ ] **Step 4: Use SQLite in `getOverview` before BigQuery**

At the top of `getOverview`, after the missing-client guard is considered, add:

```ts
    if (this.cacheRepository?.hasCoverage(filters.date_from, filters.date_to)) {
      const payload = this.cacheRepository.queryP2Overview(filters)
      return {
        filters,
        cards: payload.cards,
        meta: {
          partial_data: false,
          source_mode: 'sqlite_shopify_bi_cache',
          cache_generation: this.cacheRepository.getGeneration(filters.date_from, filters.date_to),
          notes: [ADR_0007_METRIC_NOTE],
        },
      }
    }
```

When BigQuery is used, include:

```ts
source_mode: 'bigquery_fallback'
```

- [ ] **Step 5: Wire repository creation**

Modify `createP2Service()`:

```ts
export function createP2Service() {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  const hasBigQuery = Boolean(credentialsPath && fs.existsSync(credentialsPath))
  const syncConfigPath = process.env.SYNC_CONFIG_PATH ?? 'config/sync/config.json'
  let cacheRepository: P2CacheRepository | null = null
  try {
    if (fs.existsSync(syncConfigPath)) {
      const { runtime } = loadP3RuntimeConfig(syncConfigPath)
      cacheRepository = new SqliteShopifyBiCacheRepository(runtime.sqlitePath)
    }
  } catch {
    cacheRepository = null
  }
  return new P2Service(hasBigQuery ? new BigQuery() : null, cacheRepository)
}
```

Add the required imports:

```ts
import { SqliteShopifyBiCacheRepository } from '../../integrations/shopify-bi-cache.js'
import { loadP3RuntimeConfig } from '../../integrations/sync-config.js'
```

- [ ] **Step 6: Run P2 tests**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/p2.test.js
```

Expected: `P2 tests passed`.

- [ ] **Step 7: Commit**

```bash
git add server/domain/p2/service.ts server/entrypoints/app.ts server/test/p2.test.ts
git commit -m "feat(p2): read Shopify BI cache before BigQuery"
```

---

### Task 6: Add P2 SPU Table And Options SQLite Queries

**Files:**
- Modify: `server/integrations/shopify-bi-cache.ts`
- Modify: `server/domain/p2/service.ts`
- Modify: `server/test/p2.test.ts`

- [ ] **Step 1: Write failing tests for table and options cache paths**

Add to `server/test/p2.test.ts`:

```ts
async function testSpuTableUsesSqliteCacheWhenCovered() {
  const bigQuery = createClient([[{ row_type: 'SPU', spu: 'BQ', refund_amount: 999 }]])
  const service = new P2Service(bigQuery.client, {
    hasCoverage: () => true,
    getGeneration: () => 'generation-1',
    queryP2Overview: () => { throw new Error('overview not used') },
    queryP2SpuTable: () => ({
      rows: [{
        spu: 'SPU-1',
        sales_qty: 2,
        sales_amount: 100,
        refund_qty: 1,
        refund_amount: 50,
        refund_qty_ratio: 0.5,
        refund_amount_ratio: 0.5,
        skc_rows: [],
      }],
    }),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
  })

  const payload = await service.getSpuTable(createFilters(), 20)
  assert.equal(bigQuery.calls.length, 0)
  assert.equal(payload.rows[0]?.spu, 'SPU-1')
  assert.equal(payload.meta.source_mode, 'sqlite_shopify_bi_cache')
}
```

Add an equivalent `testSpuSkcOptionsUsesSqliteCacheWhenCovered`.

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/p2.test.js
```

Expected: fail because the repository interface lacks these methods.

- [ ] **Step 3: Extend the P2 cache interface**

Add:

```ts
  queryP2SpuTable(filters: P2Filters, topN: number): { rows: Awaited<ReturnType<P2Service['getSpuTable']>>['rows'] }
  queryP2SpuSkcOptions(filters: P2Filters): { options: { spus: string[]; skcs: string[]; pairs: Array<{ spu: string; skc: string }> } }
```

- [ ] **Step 4: Implement SQLite-backed table and options methods**

Implement `queryP2SpuTable` in `server/integrations/shopify-bi-cache.ts` using the current P2 SQL semantics against v2 tables:

```ts
  queryP2SpuTable(filters: P2FiltersLike, topN: number) {
    const rows = this.db.prepare(`
      WITH line_base AS (
        SELECT
          li.order_id,
          li.skc,
          li.spu,
          li.quantity,
          li.discounted_total_usd AS sales_amount,
          COALESCE(re.refund_subtotal_usd, 0) AS refund_amount_line,
          COALESCE(re.refund_quantity, 0) AS refund_qty_line
        FROM shopify_bi_order_lines li
        JOIN shopify_bi_orders o ON o.order_id = li.order_id
        LEFT JOIN shopify_bi_refund_events re ON re.order_id = li.order_id AND re.sku = li.sku
        WHERE o.processed_date BETWEEN @date_from AND @date_to
          AND o.is_gift_card_order = 0
          AND o.is_regular_order = 1
          AND li.is_insurance_item = 0
          AND li.is_price_adjustment = 0
          AND li.is_shipping_cost = 0
          AND (@category = '' OR o.primary_product_type = @category)
          AND (@channel = '' OR o.shop_domain = @channel)
          AND (@listing_date_from = '' OR o.first_published_at_in_order >= @listing_date_from)
          AND (@listing_date_to = '' OR o.first_published_at_in_order <= @listing_date_to)
      ),
      spu_rank AS (
        SELECT spu, SUM(refund_amount_line) AS refund_amount
        FROM line_base
        WHERE (@spu = '' OR spu = @spu)
          AND (@skc = '' OR skc = @skc)
        GROUP BY spu
        ORDER BY refund_amount DESC, spu
        LIMIT @top_n
      )
      SELECT
        'SPU' AS row_type,
        lb.spu,
        NULL AS skc,
        SUM(lb.quantity) AS sales_qty,
        SUM(lb.sales_amount) AS sales_amount,
        SUM(lb.refund_qty_line) AS refund_qty,
        SUM(lb.refund_amount_line) AS refund_amount
      FROM line_base lb
      JOIN spu_rank sr ON sr.spu = lb.spu
      GROUP BY lb.spu
      UNION ALL
      SELECT
        'SKC' AS row_type,
        lb.spu,
        lb.skc,
        SUM(lb.quantity) AS sales_qty,
        SUM(lb.sales_amount) AS sales_amount,
        SUM(lb.refund_qty_line) AS refund_qty,
        SUM(lb.refund_amount_line) AS refund_amount
      FROM line_base lb
      JOIN spu_rank sr ON sr.spu = lb.spu
      GROUP BY lb.spu, lb.skc
    `).all({ ...this.buildP2Params(filters), top_n: topN }) as Array<Record<string, unknown>>

    return { rows: groupP2Rows(rows) }
  }
```

Implement `queryP2SpuSkcOptions` with:

```ts
SELECT DISTINCT li.spu, li.skc
FROM shopify_bi_order_lines li
JOIN shopify_bi_orders o ON o.order_id = li.order_id
WHERE o.processed_date BETWEEN @date_from AND @date_to
  AND o.is_gift_card_order = 0
  AND o.is_regular_order = 1
  AND li.is_insurance_item = 0
  AND li.is_price_adjustment = 0
  AND li.is_shipping_cost = 0
```

- [ ] **Step 5: Route P2 methods to SQLite**

At the top of `getSpuTable` and `getSpuSkcOptions`, use the same coverage check pattern as `getOverview`. Include `source_mode` and `cache_generation` in `meta`.

- [ ] **Step 6: Run tests**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/p2.test.js
```

Expected: `P2 tests passed`.

- [ ] **Step 7: Commit**

```bash
git add server/integrations/shopify-bi-cache.ts server/domain/p2/service.ts server/test/p2.test.ts
git commit -m "feat(p2): serve table and options from SQLite cache"
```

---

### Task 7: Add P2 In-Memory Response Cache

**Files:**
- Modify: `server/domain/p2/service.ts`
- Modify: `server/test/p2.test.ts`

- [ ] **Step 1: Write a failing memory cache test**

Add to `server/test/p2.test.ts`:

```ts
async function testOverviewCachesSqliteResponsesByGeneration() {
  let sqliteCalls = 0
  const service = new P2Service(null, {
    hasCoverage: () => true,
    getGeneration: () => 'generation-1',
    queryP2Overview: () => {
      sqliteCalls += 1
      return {
        cards: {
          order_count: sqliteCalls,
          sales_qty: 0,
          refund_order_count: 0,
          refund_amount: 0,
          gmv: 0,
          net_received_amount: 0,
          net_revenue_amount: 0,
          refund_amount_ratio: 0,
          avg_order_amount: 0,
        },
      }
    },
    queryP2SpuTable: () => ({ rows: [] }),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
  })

  const first = await service.getOverview(createFilters())
  const second = await service.getOverview(createFilters())

  assert.equal(first.cards.order_count, 1)
  assert.equal(second.cards.order_count, 1)
  assert.equal(sqliteCalls, 1)
}
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/p2.test.js
```

Expected: fail because P2 does not cache responses.

- [ ] **Step 3: Import and add TTL caches**

Modify `server/domain/p2/service.ts`:

```ts
import { TtlCache } from '../p3/cache.js'
```

Add fields:

```ts
  private readonly overviewCache = new TtlCache<Awaited<ReturnType<P2Service['getOverview']>>>(300_000)
  private readonly spuTableCache = new TtlCache<Awaited<ReturnType<P2Service['getSpuTable']>>>(300_000)
  private readonly optionsCache = new TtlCache<Awaited<ReturnType<P2Service['getSpuSkcOptions']>>>(300_000)
```

- [ ] **Step 4: Cache SQLite responses by endpoint, filters, and generation**

In each SQLite path:

```ts
const generation = this.cacheRepository.getGeneration(filters.date_from, filters.date_to)
const cacheKey = JSON.stringify(['overview', generation, filters])
const cached = this.overviewCache.get(cacheKey)
if (cached) {
  return cached
}
return this.overviewCache.set(cacheKey, payload)
```

Do the same for `spu-table` and `spu-skc-options`.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/p2.test.js
```

Expected: `P2 tests passed`.

- [ ] **Step 6: Commit**

```bash
git add server/domain/p2/service.ts server/test/p2.test.ts
git commit -m "feat(p2): cache SQLite response payloads"
```

---

### Task 8: Move P3 To The Shared Cache

**Files:**
- Modify: `server/domain/p3/service.ts`
- Modify: `server/integrations/shopify-bi-cache.ts`
- Modify: `server/test/p3.test.ts`

- [ ] **Step 1: Write a P3 shared-cache test**

Modify `server/test/p3.test.ts` so the SQLite BigQuery cache test seeds `SqliteShopifyBiCacheRepository` instead of `SqliteMirrorRepository.replaceBigQueryCacheWindow`:

```ts
const cacheWriter = new SqliteShopifyBiCacheRepository(sqlitePath)
cacheWriter.replaceWindow({
  dateFrom: '2026-04-01',
  dateTo: '2026-04-30',
  orders: [{
    order_id: 'order-1',
    order_no: 'LC100',
    shop_domain: '2vnpww-33.myshopify.com',
    processed_date: '2026-04-01',
    primary_product_type: 'Dress',
    first_published_at_in_order: '2026-03-20',
    is_regular_order: true,
    is_gift_card_order: false,
    gmv_usd: 120,
    revenue_usd: 100,
    net_revenue_usd: 90,
  }],
  orderLines: [{
    order_id: 'order-1',
    order_no: 'LC100',
    line_key: 'line-1',
    sku: 'SKU-1',
    skc: 'SKC-1',
    spu: 'SPU-1',
    product_id: 'SPU-1',
    variant_id: 'VAR-1',
    quantity: 1,
    discounted_total_usd: 100,
    is_insurance_item: false,
    is_price_adjustment: false,
    is_shipping_cost: false,
  }],
  refundEvents: [],
})
cacheWriter.close()
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/p3.test.js
```

Expected: fail because P3 still uses `SqliteP3BigQueryCacheRepository`.

- [ ] **Step 3: Implement P3 repository methods on shared cache**

Have `SqliteShopifyBiCacheRepository` implement the existing P3 `SalesRepository` and `OrderEnrichmentRepository` contracts:

```ts
async fetchSummary(filters: P3Filters): Promise<SummaryMetrics> {
  return {
    sales_qty: uniqueOrderCount(this.listOrderLinesForP3(filters)),
    complaint_count: 0,
  }
}
```

Also implement `fetchTrends`, `fetchProductSales`, and `enrichIssues` using the v2 tables. Keep semantics equivalent to the existing `SqliteP3BigQueryCacheRepository`.

- [ ] **Step 4: Wire P3 service to shared cache**

Modify `server/domain/p3/service.ts`:

```ts
const sqliteCache = new SqliteShopifyBiCacheRepository(runtimeConfig.runtime.sqlitePath)
salesRepository = sqliteCache
enrichmentRepository = sqliteCache
sourceModes.push('sqlite shopify bi cache')
```

Keep the old `SqliteP3BigQueryCacheRepository` exported for one release, but stop using it in `createP3Service`.

- [ ] **Step 5: Run P3 tests**

Run:

```bash
npm run build:server --silent && node server-dist/server/test/p3.test.js
npm run build:server --silent && node server-dist/server/test/integrations.test.js
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add server/domain/p3/service.ts server/integrations/shopify-bi-cache.ts server/test/p3.test.ts server/test/integrations.test.ts
git commit -m "feat(p3): use shared Shopify BI cache"
```

---

### Task 9: API Metadata And Documentation

**Files:**
- Modify: `docs/p2-refund-dashboard-api.md`
- Modify: `docs/p3-formal-runtime-api.md`
- Modify: `server/test/p2-static.test.js`

- [ ] **Step 1: Add metadata expectations to static tests**

Modify `server/test/p2-static.test.js` to assert that P2 service source includes both strings:

```js
assert.match(serviceSource, /sqlite_shopify_bi_cache/)
assert.match(serviceSource, /bigquery_fallback/)
assert.match(serviceSource, /cache_generation/)
```

- [ ] **Step 2: Run and verify failure if docs/code are incomplete**

Run:

```bash
node server/test/p2-static.test.js
```

Expected: pass only after Task 5 adds the metadata.

- [ ] **Step 3: Document P2 metadata**

Add to `docs/p2-refund-dashboard-api.md`:

```md
### Data Source Metadata

Each P2 response includes:

- `meta.source_mode`: `sqlite_shopify_bi_cache` when the requested date range is covered by SQLite; `bigquery_fallback` when cache coverage is missing and BigQuery is used.
- `meta.cache_generation`: the latest successful SQLite cache refresh timestamp for the requested date range when SQLite is used.
- `meta.notes`: ADR-0007 metric note plus any fallback notes.

During the first deployment after cache schema upgrade, `bigquery_fallback` is expected until the worker completes the initial Shopify BI cache refresh.
```

- [ ] **Step 4: Document P3 source mode rename**

Add to `docs/p3-formal-runtime-api.md`:

```md
P3 Shopify metrics now use `sqlite shopify bi cache`, the same SQLite fact cache used by P2. The older `sqlite shopify bigquery cache` source mode refers to the PR8 compatibility tables and should not appear after the shared cache migration is active.
```

- [ ] **Step 5: Run docs/static tests**

Run:

```bash
node server/test/p2-static.test.js
```

Expected: `P2 static tests passed`.

- [ ] **Step 6: Commit**

```bash
git add docs/p2-refund-dashboard-api.md docs/p3-formal-runtime-api.md server/test/p2-static.test.js
git commit -m "docs: describe Shopify BI cache source modes"
```

---

### Task 10: End-To-End Verification And SQL Validation

**Files:**
- No source changes expected.

- [ ] **Step 1: Run full local test suite for touched areas**

Run:

```bash
npm run build:server --silent
npm run test:p2-static --silent
npm run test:p2 --silent
npm run test:p3 --silent
npm run test:sync --silent
npm run test:worker --silent
npm run test:integrations --silent
```

Expected: all pass.

- [ ] **Step 2: Run one local sync against copied credentials**

Run:

```bash
npm run sync:run --silent
```

Expected after the separate Feishu `record_id` conflict fix is included: both SQLite mirror and Shopify BI cache are ok. If that fix is not included, Feishu mirror may still fail, but `shopify_bi_cache.ok` must be `true`.

- [ ] **Step 3: Validate SQLite table counts**

Run:

```bash
node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('config/data/issues.sqlite')
for (const [label, sql] of [
  ['orders', 'SELECT COUNT(*) AS count FROM shopify_bi_orders'],
  ['order_lines', 'SELECT COUNT(*) AS count FROM shopify_bi_order_lines'],
  ['refund_events', 'SELECT COUNT(*) AS count FROM shopify_bi_refund_events'],
  ['latest_run', "SELECT ok, date_from, date_to, finished_at FROM shopify_bi_cache_runs WHERE scope = 'shopify_bi_v2' ORDER BY id DESC LIMIT 1"],
]) {
  console.log(label, db.prepare(sql).get())
}
db.close()
NODE
```

Expected:

```text
orders { count: >0 }
order_lines { count: >0 }
refund_events { count: >0 }
latest_run { ok: 1, date_from: ..., date_to: ..., finished_at: ... }
```

- [ ] **Step 4: Compare P2 API source modes**

Run:

```bash
curl -sS 'http://localhost:8787/api/bi/p2/refund-dashboard/overview?date_from=2026-04-01&date_to=2026-04-30&grain=month&top_n=20' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); console.log(j.meta); console.log(j.cards)})"
```

Expected:

```text
source_mode: 'sqlite_shopify_bi_cache'
cache_generation: non-empty timestamp
```

- [ ] **Step 5: Compare P2 and direct SQLite numbers**

Run:

```bash
node --input-type=module - <<'NODE'
import { SqliteShopifyBiCacheRepository } from './server-dist/server/integrations/shopify-bi-cache.js'
const repo = new SqliteShopifyBiCacheRepository('config/data/issues.sqlite')
const result = repo.queryP2Overview({
  date_from: '2026-04-01',
  date_to: '2026-04-30',
  grain: 'month',
})
console.log(JSON.stringify(result.cards, null, 2))
repo.close()
NODE
```

Expected: values match the API `cards` output for the same filters.

- [ ] **Step 6: Commit verification notes if docs changed**

If verification uncovers doc gaps, update the docs and commit:

```bash
git add docs/p2-refund-dashboard-api.md docs/p3-formal-runtime-api.md
git commit -m "docs: add Shopify BI cache verification notes"
```

If no docs change is needed, do not create an empty commit.

---

## Deployment Checklist

- [ ] Merge code with v2 schema migration before relying on P2 SQLite cache.
- [ ] Restart app and worker.
- [ ] Confirm worker logs include `Shopify BI cache synced`.
- [ ] Confirm SQLite counts are non-zero on the server.
- [ ] Confirm P2 API returns `meta.source_mode = "sqlite_shopify_bi_cache"`.
- [ ] Keep BigQuery fallback enabled for the first production release.
- [ ] After one stable release, decide whether to remove legacy PR8 tables or keep them as compatibility data.

## Risk Controls

- The new tables are additive; existing PR8 cache tables are preserved.
- P2 fallback prevents first deployment backfill from causing empty dashboards.
- Cache generation is included in the in-memory cache key, so worker refreshes naturally invalidate P2 memory cache.
- Window replacement is transactional to avoid half-updated cache reads.
- P3 migration happens after P2 v2 tables are proven, reducing blast radius.
