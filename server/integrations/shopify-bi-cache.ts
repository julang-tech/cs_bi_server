import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TtlCache } from '../domain/p3/cache.js'
import { bucketLabelForDate, enumerateBuckets } from '../domain/p2/bucket.js'
import type {
  OrderEnrichmentRepository,
  OrderLineContext,
  P3Filters,
  ProductSalesPoint,
  SalesRepository,
  StandardIssueRecord,
  SummaryMetrics,
  TrendPoint,
} from '../domain/p3/models.js'

type ShopifyBiCacheLogger = {
  warn?: (message: string) => void
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function formatSampleOrderNos(orderNos: string[]) {
  const sample = orderNos.slice(0, 20).join(',')
  return orderNos.length > 20 ? `${sample},...` : sample
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

export type ShopifyBiSyncFinancials = {
  orderAmountUsd: number | null
  skuAmountUsd: number | null
  skuRefundAmountUsd: number | null
  orderRefundAmountUsd: number | null
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
  spu_list?: string[]
  skc_list?: string[]
}

type ShopifyBiP2TrendPoint = {
  bucket: string
  value: number
}

type ShopifyBiP2OverviewTrends = {
  order_count: ShopifyBiP2TrendPoint[]
  sales_qty: ShopifyBiP2TrendPoint[]
  refund_order_count: ShopifyBiP2TrendPoint[]
  refund_amount: ShopifyBiP2TrendPoint[]
  gmv: ShopifyBiP2TrendPoint[]
  net_received_amount: ShopifyBiP2TrendPoint[]
  net_revenue_amount: ShopifyBiP2TrendPoint[]
  refund_amount_ratio: ShopifyBiP2TrendPoint[]
}

type ShopifyBiP2SpuTableSkcRow = {
  skc: string
  sales_qty: number
  sales_amount: number
  refund_qty: number
  refund_amount: number
  refund_qty_ratio: number
  refund_amount_ratio: number
}

type ShopifyBiP2SpuTableRow = {
  spu: string
  sales_qty: number
  sales_amount: number
  refund_qty: number
  refund_amount: number
  refund_qty_ratio: number
  refund_amount_ratio: number
  skc_rows: ShopifyBiP2SpuTableSkcRow[]
}

type P3SalesRow = {
  order_no: string
  event_date: string
  sku: string | null
  skc: string | null
  spu: string | null
}

type P3OrderLineRow = {
  order_no: string
  processed_date: string
  sku: string | null
  skc: string | null
  spu: string | null
  quantity: number
}

type P3RefundRow = {
  order_no: string
  sku: string | null
  refund_date: string
}

function toNumber(value: unknown) {
  return Number(value ?? 0)
}

function toText(value: unknown) {
  return String(value ?? '')
}

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : 0
}

function normalizeSku(value: unknown) {
  return String(value ?? '').trim().toUpperCase()
}

function startOfWeekMonday(dateText: string) {
  const date = new Date(`${dateText}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) {
    return dateText
  }
  const day = date.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  date.setUTCDate(date.getUTCDate() + diff)
  return date.toISOString().slice(0, 10)
}

function bucketDate(dateText: string, grain: P3Filters['grain']) {
  if (grain === 'day') {
    return dateText
  }
  if (grain === 'week') {
    return startOfWeekMonday(dateText)
  }
  return dateText.slice(0, 7) + '-01'
}

function uniqueOrderCount(rows: Array<{ order_no: string }>) {
  return new Set(rows.map((row) => row.order_no)).size
}

export class SqliteShopifyBiCacheRepository implements SalesRepository, OrderEnrichmentRepository {
  private readonly summaryCache = new TtlCache<SummaryMetrics>(300_000)
  private readonly trendCache = new TtlCache<TrendPoint[]>(300_000)
  private readonly productSalesCache = new TtlCache<ProductSalesPoint[]>(300_000)
  private readonly db: DatabaseSync

  constructor(
    private readonly dbPath: string,
    private readonly logger?: ShopifyBiCacheLogger,
  ) {
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

  async fetchSummary(filters: P3Filters): Promise<SummaryMetrics> {
    const cacheKey = JSON.stringify(['p3-summary', filters])
    const cached = this.summaryCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const rows = this.listP3SalesRows(filters)
    const result = {
      sales_qty: rows.length,
      order_count: new Set(rows.map((row) => row.order_no)).size,
      complaint_count: 0,
    }
    return this.summaryCache.set(cacheKey, result)
  }

  async fetchTrends(filters: P3Filters): Promise<TrendPoint[]> {
    const cacheKey = JSON.stringify(['p3-trends', filters])
    const cached = this.trendCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const buckets = new Map<string, { sales_qty: number; orders: Set<string> }>()
    for (const row of this.listP3SalesRows(filters)) {
      const bucket = bucketDate(row.event_date, filters.grain)
      const entry = buckets.get(bucket) ?? { sales_qty: 0, orders: new Set<string>() }
      entry.sales_qty += 1
      entry.orders.add(row.order_no)
      buckets.set(bucket, entry)
    }

    const result = [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucket, entry]) => ({
        bucket,
        sales_qty: entry.sales_qty,
        order_count: entry.orders.size,
        complaint_count: 0,
      }))
    return this.trendCache.set(cacheKey, result)
  }

  async fetchProductSales(filters: P3Filters): Promise<ProductSalesPoint[]> {
    const cacheKey = JSON.stringify(['p3-product-sales', filters])
    const cached = this.productSalesCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const grouped = new Map<string, { spu: string; skc: string; sales_qty: number }>()
    for (const row of this.listP3SalesRows(filters)) {
      if (!row.spu || !row.skc) {
        continue
      }
      const key = `${row.spu}\u0000${row.skc}`
      const existing = grouped.get(key)
      if (existing) {
        existing.sales_qty += 1
      } else {
        grouped.set(key, { spu: row.spu, skc: row.skc, sales_qty: 1 })
      }
    }

    const result = [...grouped.values()]
    return this.productSalesCache.set(cacheKey, result)
  }

  async enrichIssues(issues: StandardIssueRecord[]) {
    const orderNos = [...new Set(issues.map((issue) => issue.order_no).filter(Boolean))].sort()
    if (!orderNos.length) {
      return { issues, notes: [] }
    }

    if (!this.hasP3CacheRows()) {
      return {
        issues: issues.map((issue) => ({
          ...issue,
          order_date: issue.order_date ?? issue.record_date ?? null,
        })),
        notes: ['SQLite Shopify BI cache has no Shopify order/refund rows.'],
      }
    }

    const lineRows = this.listP3OrderLinesByOrderNos(orderNos)
    const refundRows = this.listP3RefundEventsByOrderNos(orderNos)
    const lineByOrder = new Map<string, OrderLineContext[]>()
    const orderDateByOrder = new Map<string, string>()
    const refundsByOrder = new Map<string, { earliest: string | null; bySku: Map<string, string> }>()

    for (const row of lineRows) {
      const lineItems = lineByOrder.get(row.order_no) ?? []
      if (row.sku) {
        lineItems.push({
          sku: row.sku,
          quantity: Number(row.quantity ?? 1),
          skc: row.skc,
          spu: row.spu,
        })
      }
      lineByOrder.set(row.order_no, lineItems)
      if (!orderDateByOrder.has(row.order_no) || row.processed_date < orderDateByOrder.get(row.order_no)!) {
        orderDateByOrder.set(row.order_no, row.processed_date)
      }
    }

    for (const row of refundRows) {
      const bucket = refundsByOrder.get(row.order_no) ?? {
        earliest: null,
        bySku: new Map<string, string>(),
      }
      if (!bucket.earliest || row.refund_date < bucket.earliest) {
        bucket.earliest = row.refund_date
      }
      const skuKey = normalizeSku(row.sku)
      if (skuKey) {
        const current = bucket.bySku.get(skuKey)
        if (!current || row.refund_date < current) {
          bucket.bySku.set(skuKey, row.refund_date)
        }
      }
      refundsByOrder.set(row.order_no, bucket)
    }

    const notes: string[] = []
    const missingOrderNos: string[] = []
    const enriched = issues.map((issue) => {
      const lineItems = lineByOrder.get(issue.order_no) ?? []
      const matchedLine = this.matchP3LineItem(issue, lineItems)
      const refundContext = refundsByOrder.get(issue.order_no)

      if (!lineItems.length) {
        missingOrderNos.push(issue.order_no)
      }

      return {
        ...issue,
        order_date: orderDateByOrder.get(issue.order_no) ?? issue.order_date ?? issue.record_date ?? null,
        refund_date: this.resolveP3RefundDate(issue, refundContext) ?? issue.refund_date ?? null,
        order_line_contexts: lineItems.length ? lineItems : issue.order_line_contexts,
        skc: matchedLine?.skc ?? issue.skc ?? null,
        spu: matchedLine?.spu ?? issue.spu ?? null,
      }
    })
    if (missingOrderNos.length) {
      this.logger?.warn?.(
        `P3 Shopify BI cache order enrichment missing ${missingOrderNos.length}/${issues.length} order contexts; fell back to record_date where available. sample_order_nos=${formatSampleOrderNos(missingOrderNos)}`,
      )
    }

    return { issues: enriched, notes }
  }

  /**
   * Returns the list of valid product SKUs for an order from the cache,
   * excluding insurance / price-adjustment / shipping lines. Order is
   * stable (line_key asc) so callers get deterministic per-SKU output.
   */
  listValidSkusByOrderNo(orderNo: string): string[] {
    if (!orderNo) return []
    const rows = this.db
      .prepare(`
        SELECT sku
        FROM shopify_bi_order_lines
        WHERE order_no = ?
          AND is_insurance_item = 0
          AND is_price_adjustment = 0
          AND is_shipping_cost = 0
          AND sku IS NOT NULL
          AND TRIM(sku) != ''
        ORDER BY line_key ASC
      `)
      .all(orderNo) as Array<{ sku: unknown }>
    const seen = new Set<string>()
    const result: string[] = []
    for (const row of rows) {
      const sku = String(row.sku ?? '').trim()
      if (!sku || seen.has(sku)) continue
      seen.add(sku)
      result.push(sku)
    }
    return result
  }

  lookupSyncFinancials(orderNo: string, sku: string | null): ShopifyBiSyncFinancials | null {
    const normalizedOrderNo = String(orderNo ?? '').trim()
    if (!normalizedOrderNo) return null

    const orderRow = this.db
      .prepare(`
        SELECT gmv_usd
        FROM shopify_bi_orders
        WHERE order_no = ?
        ORDER BY processed_date DESC
        LIMIT 1
      `)
      .get(normalizedOrderNo) as { gmv_usd: unknown } | undefined

    const skuKey = normalizeSku(sku)
    let skuAmountUsd: number | null = null
    let skuRefundAmountUsd: number | null = null

    if (skuKey) {
      const skuAmountRow = this.db
        .prepare(`
          SELECT SUM(discounted_total_usd) AS amount
          FROM shopify_bi_order_lines
          WHERE order_no = ?
            AND UPPER(TRIM(COALESCE(sku, ''))) = ?
            AND is_insurance_item = 0
            AND is_price_adjustment = 0
            AND is_shipping_cost = 0
        `)
        .get(normalizedOrderNo, skuKey) as { amount: unknown } | undefined
      skuAmountUsd = skuAmountRow?.amount == null ? null : Number(skuAmountRow.amount)

      const skuRefundRow = this.db
        .prepare(`
          SELECT SUM(refund_subtotal_usd) AS amount
          FROM shopify_bi_refund_events
          WHERE order_no = ?
            AND UPPER(TRIM(COALESCE(sku, ''))) = ?
        `)
        .get(normalizedOrderNo, skuKey) as { amount: unknown } | undefined
      skuRefundAmountUsd = skuRefundRow?.amount == null ? null : Number(skuRefundRow.amount)
    } else {
      const singleLineRow = this.db
        .prepare(`
          SELECT COUNT(*) AS count, SUM(discounted_total_usd) AS amount
          FROM shopify_bi_order_lines
          WHERE order_no = ?
            AND is_insurance_item = 0
            AND is_price_adjustment = 0
            AND is_shipping_cost = 0
        `)
        .get(normalizedOrderNo) as { count: unknown; amount: unknown } | undefined
      if (Number(singleLineRow?.count ?? 0) === 1 && singleLineRow?.amount != null) {
        skuAmountUsd = Number(singleLineRow.amount)
      }
    }

    const orderRefundRow = this.db
      .prepare(`
        SELECT SUM(refund_subtotal_usd) AS amount
        FROM shopify_bi_refund_events
        WHERE order_no = ?
      `)
      .get(normalizedOrderNo) as { amount: unknown } | undefined

    const financials: ShopifyBiSyncFinancials = {
      orderAmountUsd: orderRow?.gmv_usd == null ? null : Number(orderRow.gmv_usd),
      skuAmountUsd,
      skuRefundAmountUsd,
      orderRefundAmountUsd: orderRefundRow?.amount == null ? null : Number(orderRefundRow.amount),
    }
    return Object.values(financials).some((value) => value != null) ? financials : null
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

  queryP2Trends(filters: ShopifyBiP2OverviewFilters) {
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
    const orderRows = this.db
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
        sales_qty_per_day AS (
          SELECT
            o.processed_date AS bucket_date,
            COALESCE(SUM(li.quantity), 0) AS sales_qty
          FROM filtered_orders o
          JOIN shopify_bi_order_lines li ON li.order_id = o.order_id
          WHERE li.is_insurance_item = 0
            AND li.is_price_adjustment = 0
            AND li.is_shipping_cost = 0
          GROUP BY o.processed_date
        )
        SELECT
          o.processed_date AS bucket_date,
          COUNT(DISTINCT o.order_id) AS order_count,
          COALESCE(SUM(o.gmv_usd), 0) AS gmv,
          COALESCE(SUM(o.revenue_usd), 0) AS net_received_amount,
          COALESCE(SUM(o.net_revenue_usd), 0) AS net_revenue_amount,
          COALESCE((SELECT sales_qty FROM sales_qty_per_day s WHERE s.bucket_date = o.processed_date), 0) AS sales_qty
        FROM filtered_orders o
        GROUP BY o.processed_date
      `)
      .all(params) as Array<Record<string, unknown>>

    const refundRows = this.db
      .prepare(`
        SELECT
          re.refund_date AS bucket_date,
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
        GROUP BY re.refund_date
      `)
      .all(params) as Array<Record<string, unknown>>

    type DailySum = {
      order_count: number
      sales_qty: number
      refund_order_count: number
      refund_amount: number
      gmv: number
      net_received_amount: number
      net_revenue_amount: number
    }
    const bucketSums = new Map<string, DailySum>()
    const bucketFor = (dateText: string) => {
      const label = bucketLabelForDate(dateText, filters.grain)
      let entry = bucketSums.get(label)
      if (!entry) {
        entry = {
          order_count: 0,
          sales_qty: 0,
          refund_order_count: 0,
          refund_amount: 0,
          gmv: 0,
          net_received_amount: 0,
          net_revenue_amount: 0,
        }
        bucketSums.set(label, entry)
      }
      return entry
    }

    for (const row of orderRows) {
      const dateText = toText(row.bucket_date)
      if (!dateText) continue
      const entry = bucketFor(dateText)
      entry.order_count += toNumber(row.order_count)
      entry.sales_qty += toNumber(row.sales_qty)
      entry.gmv += toNumber(row.gmv)
      entry.net_received_amount += toNumber(row.net_received_amount)
      entry.net_revenue_amount += toNumber(row.net_revenue_amount)
    }
    for (const row of refundRows) {
      const dateText = toText(row.bucket_date)
      if (!dateText) continue
      const entry = bucketFor(dateText)
      entry.refund_order_count += toNumber(row.refund_order_count)
      entry.refund_amount += toNumber(row.refund_amount)
    }

    const buckets = enumerateBuckets(filters.date_from, filters.date_to, filters.grain)
    const trends: ShopifyBiP2OverviewTrends = {
      order_count: [],
      sales_qty: [],
      refund_order_count: [],
      refund_amount: [],
      gmv: [],
      net_received_amount: [],
      net_revenue_amount: [],
      refund_amount_ratio: [],
    }
    for (const bucket of buckets) {
      const sum = bucketSums.get(bucket) ?? {
        order_count: 0,
        sales_qty: 0,
        refund_order_count: 0,
        refund_amount: 0,
        gmv: 0,
        net_received_amount: 0,
        net_revenue_amount: 0,
      }
      trends.order_count.push({ bucket, value: sum.order_count })
      trends.sales_qty.push({ bucket, value: sum.sales_qty })
      trends.refund_order_count.push({ bucket, value: sum.refund_order_count })
      trends.refund_amount.push({ bucket, value: sum.refund_amount })
      trends.gmv.push({ bucket, value: sum.gmv })
      trends.net_received_amount.push({ bucket, value: sum.net_received_amount })
      trends.net_revenue_amount.push({ bucket, value: sum.net_revenue_amount })
      trends.refund_amount_ratio.push({
        bucket,
        value: sum.net_received_amount ? sum.refund_amount / sum.net_received_amount : 0,
      })
    }

    return { trends }
  }

  queryP2SpuTable(filters: ShopifyBiP2OverviewFilters, topN: number) {
    const params: Record<string, string | number> = {
      date_from: filters.date_from,
      date_to: filters.date_to,
      category: filters.category ?? '',
      channel: filters.channel ?? '',
      listing_date_from: filters.listing_date_from ?? '',
      listing_date_to: filters.listing_date_to ?? '',
      top_n: Math.max(0, Math.trunc(topN)),
    }
    const spuFilter = this.buildProductInFilter(
      params,
      'spu_filter',
      'li.spu',
      filters.spu,
      filters.spu_list,
    )
    const skcFilter = this.buildProductInFilter(
      params,
      'skc_filter',
      'li.skc',
      filters.skc,
      filters.skc_list,
    )

    const rows = this.db
      .prepare(`
        WITH sales_lines AS (
          SELECT
            li.order_id,
            li.skc,
            li.spu,
            COALESCE(li.quantity, 0) AS quantity,
            COALESCE(li.discounted_total_usd, 0) AS sales_amount
          FROM shopify_bi_order_lines li
          JOIN shopify_bi_orders o ON o.order_id = li.order_id
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
            AND ${spuFilter}
            AND ${skcFilter}
        ),
        sales_agg AS (
          SELECT
            spu,
            skc,
            SUM(quantity) AS sales_qty,
            SUM(sales_amount) AS sales_amount
          FROM sales_lines
          GROUP BY spu, skc
        ),
        refund_event_agg AS (
          SELECT
            order_id,
            sku,
            SUM(COALESCE(refund_quantity, 0)) AS refund_qty,
            SUM(COALESCE(refund_subtotal_usd, 0)) AS refund_amount
          FROM shopify_bi_refund_events
          WHERE refund_date BETWEEN @date_from AND @date_to
          GROUP BY order_id, sku
        ),
        refund_line_dim AS (
          SELECT
            li.order_id,
            li.sku,
            MIN(li.skc) AS skc,
            MIN(li.spu) AS spu
          FROM shopify_bi_order_lines li
          JOIN shopify_bi_orders o ON o.order_id = li.order_id
          WHERE o.is_gift_card_order = 0
            AND o.is_regular_order = 1
            AND li.is_insurance_item = 0
            AND li.is_price_adjustment = 0
            AND li.is_shipping_cost = 0
            AND (@category = '' OR o.primary_product_type = @category)
            AND (@channel = '' OR o.shop_domain = @channel)
            AND (@listing_date_from = '' OR o.first_published_at_in_order >= @listing_date_from)
            AND (@listing_date_to = '' OR o.first_published_at_in_order <= @listing_date_to)
            AND ${spuFilter}
            AND ${skcFilter}
          GROUP BY li.order_id, li.sku
        ),
        refund_agg AS (
          SELECT
            d.spu,
            d.skc,
            SUM(r.refund_qty) AS refund_qty,
            SUM(r.refund_amount) AS refund_amount
          FROM refund_event_agg r
          JOIN refund_line_dim d
            ON d.order_id = r.order_id
           AND d.sku = r.sku
          GROUP BY d.spu, d.skc
        ),
        product_keys AS (
          SELECT spu, skc FROM sales_agg
          UNION
          SELECT spu, skc FROM refund_agg
        ),
        product_metrics AS (
          SELECT
            k.spu,
            k.skc,
            COALESCE(sa.sales_qty, 0) AS sales_qty,
            COALESCE(sa.sales_amount, 0) AS sales_amount,
            COALESCE(ra.refund_qty, 0) AS refund_qty,
            COALESCE(ra.refund_amount, 0) AS refund_amount
          FROM product_keys k
          LEFT JOIN sales_agg sa
            ON sa.spu IS k.spu
           AND sa.skc IS k.skc
          LEFT JOIN refund_agg ra
            ON ra.spu IS k.spu
           AND ra.skc IS k.skc
        ),
        spu_rank AS (
          SELECT
            spu,
            SUM(refund_amount) AS refund_amount
          FROM product_metrics
          GROUP BY spu
          ORDER BY refund_amount DESC, spu
          LIMIT @top_n
        )
        SELECT
          'SPU' AS row_type,
          pm.spu,
          NULL AS skc,
          SUM(pm.sales_qty) AS sales_qty,
          SUM(pm.sales_amount) AS sales_amount,
          SUM(pm.refund_qty) AS refund_qty,
          SUM(pm.refund_amount) AS refund_amount
        FROM product_metrics pm
        JOIN spu_rank sr ON sr.spu IS pm.spu
        GROUP BY pm.spu
        UNION ALL
        SELECT
          'SKC' AS row_type,
          pm.spu,
          pm.skc,
          SUM(pm.sales_qty) AS sales_qty,
          SUM(pm.sales_amount) AS sales_amount,
          SUM(pm.refund_qty) AS refund_qty,
          SUM(pm.refund_amount) AS refund_amount
        FROM product_metrics pm
        JOIN spu_rank sr ON sr.spu IS pm.spu
        GROUP BY pm.spu, pm.skc
      `)
      .all(params) as Array<Record<string, unknown>>

    return { rows: this.groupP2SpuTableRows(rows) }
  }

  queryP2SpuSkcOptions(filters: ShopifyBiP2OverviewFilters) {
    const rows = this.db
      .prepare(`
        SELECT DISTINCT
          li.spu,
          li.skc
        FROM shopify_bi_order_lines li
        JOIN shopify_bi_orders o ON o.order_id = li.order_id
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
          AND li.spu IS NOT NULL
          AND TRIM(li.spu) != ''
          AND li.skc IS NOT NULL
          AND TRIM(li.skc) != ''
          AND li.skc != 'UNKNOWN_SKC'
        ORDER BY li.spu, li.skc
      `)
      .all(this.buildP2Params(filters)) as Array<Record<string, unknown>>

    const pairs = rows.map((row) => ({ spu: toText(row.spu), skc: toText(row.skc) }))
    const spus = [...new Set(pairs.map((item) => item.spu))].sort()
    const skcs = [...new Set(pairs.map((item) => item.skc))].sort()

    return { options: { spus, skcs, pairs } }
  }

  private buildP2Params(filters: ShopifyBiP2OverviewFilters) {
    return {
      date_from: filters.date_from,
      date_to: filters.date_to,
      category: filters.category ?? '',
      channel: filters.channel ?? '',
      listing_date_from: filters.listing_date_from ?? '',
      listing_date_to: filters.listing_date_to ?? '',
    }
  }

  private listP3SalesRows(filters: P3Filters): P3SalesRow[] {
    const params = this.buildP3Params(filters)
    const productFilter = this.buildP3ProductFilter()
    return this.db
      .prepare(`
        SELECT DISTINCT
          o.order_no,
          o.processed_date AS event_date,
          li.sku,
          li.skc,
          li.spu
        FROM shopify_bi_orders o
        JOIN shopify_bi_order_lines li ON li.order_id = o.order_id
        WHERE o.processed_date BETWEEN @date_from AND @date_to
          AND li.is_insurance_item = 0
          AND li.is_price_adjustment = 0
          AND li.is_shipping_cost = 0
          AND ${productFilter}
        ORDER BY o.processed_date ASC, o.order_no ASC
      `)
      .all(params) as P3SalesRow[]
  }

  private buildP3Params(filters: P3Filters) {
    return {
      date_from: filters.date_from,
      date_to: filters.date_to,
      sku: filters.sku ?? '',
      skc: filters.skc ?? '',
      spu: filters.spu ?? '',
    }
  }

  private buildP3ProductFilter() {
    return `
      (@sku = '' OR li.sku = @sku)
      AND (@skc = '' OR li.skc = @skc)
      AND (@spu = '' OR li.spu = @spu)
    `
  }

  private listP3OrderLinesByOrderNos(orderNos: string[]): P3OrderLineRow[] {
    if (!orderNos.length) {
      return []
    }

    const placeholders = orderNos.map((_, index) => `?${index + 1}`).join(', ')
    return this.db
      .prepare(`
        SELECT
          li.order_no,
          o.processed_date,
          li.sku,
          li.skc,
          li.spu,
          li.quantity
        FROM shopify_bi_order_lines li
        JOIN shopify_bi_orders o ON o.order_id = li.order_id
        WHERE li.order_no IN (${placeholders})
          AND li.is_insurance_item = 0
          AND li.is_price_adjustment = 0
          AND li.is_shipping_cost = 0
        ORDER BY o.processed_date ASC, li.order_no ASC, li.line_key ASC
      `)
      .all(...orderNos) as P3OrderLineRow[]
  }

  private listP3RefundEventsByOrderNos(orderNos: string[]): P3RefundRow[] {
    if (!orderNos.length) {
      return []
    }

    const placeholders = orderNos.map((_, index) => `?${index + 1}`).join(', ')
    return this.db
      .prepare(`
        SELECT order_no, sku, refund_date
        FROM shopify_bi_refund_events
        WHERE order_no IN (${placeholders})
        ORDER BY refund_date ASC, order_no ASC, sku ASC
      `)
      .all(...orderNos) as P3RefundRow[]
  }

  private hasP3CacheRows() {
    const row = this.db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM shopify_bi_order_lines) AS order_lines,
          (SELECT COUNT(*) FROM shopify_bi_refund_events) AS refund_events
      `)
      .get() as { order_lines: number; refund_events: number }
    return Number(row.order_lines ?? 0) > 0 || Number(row.refund_events ?? 0) > 0
  }

  private resolveP3RefundDate(
    issue: StandardIssueRecord,
    refundContext: { earliest: string | null; bySku: Map<string, string> } | undefined,
  ) {
    if (!refundContext) {
      return null
    }
    if (issue.major_issue_type === 'logistics' || issue.is_order_level_only) {
      return refundContext.earliest
    }
    const skuKey = normalizeSku(issue.sku)
    return (skuKey ? refundContext.bySku.get(skuKey) : null) ?? refundContext.earliest
  }

  private matchP3LineItem(issue: StandardIssueRecord, lineItems: OrderLineContext[]) {
    if (issue.sku) {
      const issueSku = normalizeSku(issue.sku)
      const matched = lineItems.find((lineItem) => normalizeSku(lineItem.sku) === issueSku)
      if (matched) {
        return matched
      }
    }
    return lineItems[0]
  }

  private buildProductInFilter(
    params: Record<string, string | number>,
    prefix: string,
    column: string,
    value: string | undefined,
    values: string[] | undefined,
  ) {
    const filterValues = [...(values ?? []), value ?? '']
      .map((item) => item.trim())
      .filter((item, index, items) => item && items.indexOf(item) === index)
    if (!filterValues.length) {
      return '1 = 1'
    }

    const placeholders = filterValues.map((item, index) => {
      const key = `${prefix}_${index}`
      params[key] = item
      return `@${key}`
    })
    return `${column} IN (${placeholders.join(', ')})`
  }

  private groupP2SpuTableRows(rows: Array<Record<string, unknown>>) {
    const grouped = new Map<string, ShopifyBiP2SpuTableRow>()

    for (const row of rows) {
      const spu = toText(row.spu)
      if (!grouped.has(spu)) {
        grouped.set(spu, {
          spu,
          sales_qty: 0,
          sales_amount: 0,
          refund_qty: 0,
          refund_amount: 0,
          refund_qty_ratio: 0,
          refund_amount_ratio: 0,
          skc_rows: [],
        })
      }

      const current = grouped.get(spu)!
      const salesQty = toNumber(row.sales_qty)
      const salesAmount = toNumber(row.sales_amount)
      const refundQty = toNumber(row.refund_qty)
      const refundAmount = toNumber(row.refund_amount)
      if (toText(row.row_type) === 'SPU') {
        current.sales_qty = salesQty
        current.sales_amount = salesAmount
        current.refund_qty = refundQty
        current.refund_amount = refundAmount
        current.refund_qty_ratio = ratio(refundQty, salesQty)
        current.refund_amount_ratio = ratio(refundAmount, salesAmount)
      } else {
        current.skc_rows.push({
          skc: toText(row.skc),
          sales_qty: salesQty,
          sales_amount: salesAmount,
          refund_qty: refundQty,
          refund_amount: refundAmount,
          refund_qty_ratio: ratio(refundQty, salesQty),
          refund_amount_ratio: ratio(refundAmount, salesAmount),
        })
      }
    }

    for (const item of grouped.values()) {
      item.skc_rows.sort((a, b) => b.refund_amount - a.refund_amount || a.skc.localeCompare(b.skc))
    }

    return [...grouped.values()].sort(
      (a, b) => b.refund_amount - a.refund_amount || a.spu.localeCompare(b.spu),
    )
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
