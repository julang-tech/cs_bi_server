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
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_shopify_bi_orders_filters
      ON shopify_bi_orders(shop_domain, primary_product_type, first_published_at_in_order);
    `)

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
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_shopify_bi_order_lines_order
      ON shopify_bi_order_lines(order_id);
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_shopify_bi_order_lines_product
      ON shopify_bi_order_lines(sku, skc, spu);
    `)

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
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_shopify_bi_refund_events_date
      ON shopify_bi_refund_events(refund_date);
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_shopify_bi_refund_events_order
      ON shopify_bi_refund_events(order_id, sku);
    `)

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
    this.ensureCacheRunsScopeIndex()
  }

  private ensureCacheRunsScopeIndex() {
    const expectedColumns = ['scope', 'ok', 'date_from', 'date_to']
    const existingColumns = this.db
      .prepare("PRAGMA index_info('idx_shopify_bi_cache_runs_scope')")
      .all()
      .map((row) => String((row as { name: unknown }).name))

    const hasUnexpectedColumns =
      existingColumns.length > 0 &&
      (existingColumns.length !== expectedColumns.length ||
        existingColumns.some((column, index) => column !== expectedColumns[index]))

    if (hasUnexpectedColumns) {
      this.db.exec('DROP INDEX idx_shopify_bi_cache_runs_scope;')
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_shopify_bi_cache_runs_scope
      ON shopify_bi_cache_runs(scope, ok, date_from, date_to);
    `)
  }
}
