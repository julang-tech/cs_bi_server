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

export type ShopifyBiCacheSyncStats = {
  orders_upserted: number
  order_lines_upserted: number
  refund_events_upserted: number
}

export type ShopifyBiP2OverviewFilters = {
  date_from: string
  date_to: string
  grain: 'day' | 'week' | 'month'
  category?: string
  spu?: string
  skc?: string
  channel?: string
  listing_date_from?: string
  listing_date_to?: string
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

  replaceWindow(input: {
    dateFrom: string
    dateTo: string
    orders: ShopifyBiOrder[]
    orderLines: ShopifyBiOrderLine[]
    refundEvents: ShopifyBiRefundEvent[]
    startedAt?: string
    finishedAt?: string
  }): ShopifyBiCacheSyncStats {
    const startedAt = input.startedAt ?? new Date().toISOString()
    const finishedAt = input.finishedAt ?? new Date().toISOString()
    const syncedAt = finishedAt
    const deleteOrders = this.db.prepare(
      'DELETE FROM shopify_bi_orders WHERE processed_date BETWEEN ? AND ?',
    )
    const deleteOrphanOrderLines = this.db.prepare(`
      DELETE FROM shopify_bi_order_lines
      WHERE order_id NOT IN (SELECT order_id FROM shopify_bi_orders)
    `)
    const deleteOrderLinesByOrderId = this.db.prepare(
      'DELETE FROM shopify_bi_order_lines WHERE order_id = ?',
    )
    const deleteRefundEvents = this.db.prepare(
      'DELETE FROM shopify_bi_refund_events WHERE refund_date BETWEEN ? AND ?',
    )
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
      ON CONFLICT(order_id) DO UPDATE SET
        order_no = excluded.order_no,
        shop_domain = excluded.shop_domain,
        processed_date = excluded.processed_date,
        primary_product_type = excluded.primary_product_type,
        first_published_at_in_order = excluded.first_published_at_in_order,
        is_regular_order = excluded.is_regular_order,
        is_gift_card_order = excluded.is_gift_card_order,
        gmv_usd = excluded.gmv_usd,
        revenue_usd = excluded.revenue_usd,
        net_revenue_usd = excluded.net_revenue_usd,
        synced_at = excluded.synced_at
    `)
    const insertOrderLine = this.db.prepare(`
      INSERT INTO shopify_bi_order_lines (
        order_id, order_no, line_key, sku, skc, spu, product_id, variant_id,
        quantity, discounted_total_usd, is_insurance_item,
        is_price_adjustment, is_shipping_cost, synced_at
      ) VALUES (
        :order_id, :order_no, :line_key, :sku, :skc, :spu, :product_id, :variant_id,
        :quantity, :discounted_total_usd, :is_insurance_item,
        :is_price_adjustment, :is_shipping_cost, :synced_at
      )
      ON CONFLICT(order_id, line_key) DO UPDATE SET
        order_no = excluded.order_no,
        sku = excluded.sku,
        skc = excluded.skc,
        spu = excluded.spu,
        product_id = excluded.product_id,
        variant_id = excluded.variant_id,
        quantity = excluded.quantity,
        discounted_total_usd = excluded.discounted_total_usd,
        is_insurance_item = excluded.is_insurance_item,
        is_price_adjustment = excluded.is_price_adjustment,
        is_shipping_cost = excluded.is_shipping_cost,
        synced_at = excluded.synced_at
    `)
    const insertRefundEvent = this.db.prepare(`
      INSERT INTO shopify_bi_refund_events (
        refund_id, order_id, order_no, sku, refund_date,
        refund_quantity, refund_subtotal_usd, synced_at
      ) VALUES (
        :refund_id, :order_id, :order_no, :sku, :refund_date,
        :refund_quantity, :refund_subtotal_usd, :synced_at
      )
    `)
    const insertRun = this.db.prepare(`
      INSERT INTO shopify_bi_cache_runs (
        scope, date_from, date_to, ok, started_at, finished_at, error
      ) VALUES ('shopify_bi_v2', ?, ?, 1, ?, ?, NULL)
    `)

    this.db.exec('BEGIN')
    try {
      deleteOrders.run(input.dateFrom, input.dateTo)
      deleteOrphanOrderLines.run()
      deleteRefundEvents.run(input.dateFrom, input.dateTo)

      const affectedOrderIds = new Set<string>()
      for (const order of input.orders) {
        if (order.order_id) {
          affectedOrderIds.add(order.order_id)
        }
      }
      for (const line of input.orderLines) {
        if (line.order_id) {
          affectedOrderIds.add(line.order_id)
        }
      }

      for (const order of input.orders) {
        insertOrder.run({
          order_id: order.order_id,
          order_no: order.order_no,
          shop_domain: order.shop_domain,
          processed_date: order.processed_date,
          primary_product_type: order.primary_product_type,
          first_published_at_in_order: order.first_published_at_in_order,
          is_regular_order: order.is_regular_order ? 1 : 0,
          is_gift_card_order: order.is_gift_card_order ? 1 : 0,
          gmv_usd: order.gmv_usd,
          revenue_usd: order.revenue_usd,
          net_revenue_usd: order.net_revenue_usd,
          synced_at: syncedAt,
        })
      }
      for (const orderId of affectedOrderIds) {
        deleteOrderLinesByOrderId.run(orderId)
      }
      for (const line of input.orderLines) {
        insertOrderLine.run({
          order_id: line.order_id,
          order_no: line.order_no,
          line_key: line.line_key,
          sku: line.sku,
          skc: line.skc,
          spu: line.spu,
          product_id: line.product_id,
          variant_id: line.variant_id,
          quantity: line.quantity,
          discounted_total_usd: line.discounted_total_usd,
          is_insurance_item: line.is_insurance_item ? 1 : 0,
          is_price_adjustment: line.is_price_adjustment ? 1 : 0,
          is_shipping_cost: line.is_shipping_cost ? 1 : 0,
          synced_at: syncedAt,
        })
      }
      for (const refundEvent of input.refundEvents) {
        insertRefundEvent.run({
          refund_id: refundEvent.refund_id,
          order_id: refundEvent.order_id,
          order_no: refundEvent.order_no,
          sku: refundEvent.sku,
          refund_date: refundEvent.refund_date,
          refund_quantity: refundEvent.refund_quantity,
          refund_subtotal_usd: refundEvent.refund_subtotal_usd,
          synced_at: syncedAt,
        })
      }

      insertRun.run(input.dateFrom, input.dateTo, startedAt, finishedAt)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    return {
      orders_upserted: input.orders.length,
      order_lines_upserted: input.orderLines.length,
      refund_events_upserted: input.refundEvents.length,
    }
  }

  hasCoverage(dateFrom: string, dateTo: string) {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM shopify_bi_cache_runs
        WHERE scope = 'shopify_bi_v2'
          AND ok = 1
          AND date_from <= ?
          AND date_to >= ?
      `)
      .get(dateFrom, dateTo) as { count: number } | undefined
    return Number(row?.count ?? 0) > 0
  }

  getGeneration(dateFrom: string, dateTo: string) {
    const row = this.db
      .prepare(`
        SELECT COALESCE(MAX(finished_at), '') AS generation
        FROM shopify_bi_cache_runs
        WHERE scope = 'shopify_bi_v2'
          AND ok = 1
          AND date_from <= ?
          AND date_to >= ?
      `)
      .get(dateFrom, dateTo) as { generation: string } | undefined
    return String(row?.generation ?? '')
  }

  queryP2Overview(filters: ShopifyBiP2OverviewFilters) {
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
    const row = this.db
      .prepare(`
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
          JOIN shopify_bi_orders o ON o.order_id = re.order_id
          WHERE re.refund_date BETWEEN @date_from AND @date_to
            AND o.is_gift_card_order = 0
            AND o.is_regular_order = 1
            AND (@category = '' OR o.primary_product_type = @category)
            AND (@channel = '' OR o.shop_domain = @channel)
            AND (@listing_date_from = '' OR o.first_published_at_in_order >= @listing_date_from)
            AND (@listing_date_to = '' OR o.first_published_at_in_order <= @listing_date_to)
            AND (
              (@skc = '' AND @spu = '')
              OR EXISTS (
                SELECT 1
                FROM shopify_bi_order_lines li
                WHERE li.order_id = re.order_id
                  AND (@skc = '' OR li.skc = @skc)
                  AND (@spu = '' OR li.spu = @spu)
              )
            )
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
      `)
      .get(params) as Record<string, unknown> | undefined

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
