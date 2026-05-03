import fs from 'node:fs'
import { BigQuery } from '@google-cloud/bigquery'
import { SqliteShopifyBiCacheRepository } from '../../integrations/shopify-bi-cache.js'
import { loadP3RuntimeConfig } from '../../integrations/sync-config.js'
import { TtlCache } from '../p3/cache.js'
import { bucketLabelForDate, enumerateBuckets } from './bucket.js'

export type P2Filters = {
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

type BigQueryLike = {
  query(options: unknown): Promise<unknown>
}

type BigQueryRows = Array<Record<string, unknown>>

type P2OverviewCards = {
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

export type P2TrendPoint = {
  bucket: string
  value: number
}

export type P2OverviewTrends = {
  order_count: P2TrendPoint[]
  sales_qty: P2TrendPoint[]
  refund_order_count: P2TrendPoint[]
  refund_amount: P2TrendPoint[]
  gmv: P2TrendPoint[]
  net_received_amount: P2TrendPoint[]
  net_revenue_amount: P2TrendPoint[]
  refund_amount_ratio: P2TrendPoint[]
}

export type P2SpuTableSkcRow = {
  skc: string
  sales_qty: number
  sales_amount: number
  refund_qty: number
  refund_amount: number
  refund_qty_ratio: number
  refund_amount_ratio: number
}

export type P2SpuTableRow = {
  spu: string
  sales_qty: number
  sales_amount: number
  refund_qty: number
  refund_amount: number
  refund_qty_ratio: number
  refund_amount_ratio: number
  skc_rows: P2SpuTableSkcRow[]
}

export type P2SpuSkcOptions = {
  spus: string[]
  skcs: string[]
  pairs: Array<{ spu: string; skc: string }>
}

type P2Meta = {
  partial_data: boolean
  source_mode?: 'sqlite_shopify_bi_cache' | 'bigquery_fallback'
  cache_generation?: string
  notes: string[]
}

type P2OverviewPayload = {
  filters: P2Filters
  cards: P2OverviewCards
  trends: P2OverviewTrends
  meta: P2Meta
}

type P2SpuTablePayload = {
  filters: P2Filters
  rows: P2SpuTableRow[]
  meta: P2Meta
}

type P2SpuSkcOptionsPayload = {
  filters: P2Filters
  options: P2SpuSkcOptions
  meta: P2Meta
}

export type P2CacheRepository = {
  hasCoverage(dateFrom: string, dateTo: string): boolean
  getGeneration(dateFrom: string, dateTo: string): string
  queryP2Overview(filters: P2Filters): {
    cards: P2OverviewCards
  }
  queryP2Trends(filters: P2Filters): {
    trends: P2OverviewTrends
  }
  queryP2SpuTable(filters: P2Filters, topN: number): { rows: P2SpuTableRow[] }
  queryP2SpuSkcOptions(filters: P2Filters): { options: P2SpuSkcOptions }
  close?: () => void
}

function extractRows(result: unknown): BigQueryRows {
  if (!Array.isArray(result)) {
    return []
  }
  const [rows] = result as [unknown, ...unknown[]]
  return Array.isArray(rows) ? (rows as BigQueryRows) : []
}

function toNumber(value: unknown) {
  return Number(value ?? 0)
}

function toText(value: unknown) {
  return String(value ?? '')
}

const ADR_0007_METRIC_NOTE =
  'Metric definitions aligned with finance team per dwd ADR-0007 (2026-04-30): GMV/revenue include shipping; refund_amount is now refund-flow (events in window) not cohort (orders in window). See lintico-data-warehouse/shopify_data_sync/docs/decisions/0007-dwd-align-with-cs-bi-finance.md'

function emptyTrends(): P2OverviewTrends {
  return {
    order_count: [],
    sales_qty: [],
    refund_order_count: [],
    refund_amount: [],
    gmv: [],
    net_received_amount: [],
    net_revenue_amount: [],
    refund_amount_ratio: [],
  }
}

type P2DailyAccumulator = {
  order_count: number
  sales_qty: number
  refund_order_count: number
  refund_amount: number
  gmv: number
  net_received_amount: number
  net_revenue_amount: number
}

function emptyDailyAccumulator(): P2DailyAccumulator {
  return {
    order_count: 0,
    sales_qty: 0,
    refund_order_count: 0,
    refund_amount: 0,
    gmv: 0,
    net_received_amount: 0,
    net_revenue_amount: 0,
  }
}

export function buildP2TrendsFromBuckets(
  filters: P2Filters,
  bucketSums: Map<string, P2DailyAccumulator>,
): P2OverviewTrends {
  const buckets = enumerateBuckets(filters.date_from, filters.date_to, filters.grain)
  const trends = emptyTrends()
  for (const bucket of buckets) {
    const sum = bucketSums.get(bucket) ?? emptyDailyAccumulator()
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
  return trends
}

function buildSqliteResponseCacheKey(
  endpoint: 'overview' | 'spu-table' | 'spu-skc-options',
  generation: string,
  filters: P2Filters,
  topN?: number,
) {
  return topN === undefined
    ? JSON.stringify([endpoint, 'sqlite', generation, filters])
    : JSON.stringify([endpoint, 'sqlite', generation, filters, topN])
}

function buildBigQueryFallbackCacheKey(
  endpoint: 'overview' | 'spu-table' | 'spu-skc-options',
  filters: P2Filters,
  topN?: number,
) {
  return topN === undefined
    ? JSON.stringify([endpoint, 'bigquery_fallback', filters])
    : JSON.stringify([endpoint, 'bigquery_fallback', filters, topN])
}

export class P2Service {
  private readonly overviewCache = new TtlCache<P2OverviewPayload>(300_000)
  private readonly spuTableCache = new TtlCache<P2SpuTablePayload>(300_000)
  private readonly optionsCache = new TtlCache<P2SpuSkcOptionsPayload>(300_000)

  constructor(
    private readonly client: BigQueryLike | null,
    private readonly cacheRepository: P2CacheRepository | null = null,
  ) {}

  close() {
    this.cacheRepository?.close?.()
  }

  async getOverview(filters: P2Filters): Promise<P2OverviewPayload> {
    let cacheUnavailableMessage: string | null = null
    try {
      if (this.cacheRepository?.hasCoverage(filters.date_from, filters.date_to)) {
        const generation = this.cacheRepository.getGeneration(filters.date_from, filters.date_to)
        const cacheKey = buildSqliteResponseCacheKey('overview', generation, filters)
        const cached = this.overviewCache.get(cacheKey)
        if (cached) {
          return cached
        }
        const payload = this.cacheRepository.queryP2Overview(filters)
        const trendsPayload = this.cacheRepository.queryP2Trends(filters)
        return this.overviewCache.set(cacheKey, {
          filters,
          cards: payload.cards,
          trends: trendsPayload.trends,
          meta: {
            partial_data: false,
            source_mode: 'sqlite_shopify_bi_cache',
            cache_generation: generation,
            notes: [ADR_0007_METRIC_NOTE],
          },
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      cacheUnavailableMessage = message
    }

    if (!this.client) {
      return {
        filters,
        cards: {
          order_count: 0,
          sales_qty: 0,
          refund_order_count: 0,
          refund_amount: 0,
          gmv: 0,
          net_received_amount: 0,
          net_revenue_amount: 0,
          refund_amount_ratio: 0,
          avg_order_amount: 0,
        },
        trends: emptyTrends(),
        meta: {
          partial_data: true,
          notes: [
            ...(cacheUnavailableMessage
              ? [`SQLite Shopify BI cache unavailable: ${cacheUnavailableMessage}`]
              : []),
            'BigQuery credentials not found; returning empty overview.',
          ],
        },
      }
    }

    const fallbackCacheKey = buildBigQueryFallbackCacheKey('overview', filters)
    const cachedFallback = this.overviewCache.get(fallbackCacheKey)
    if (cachedFallback) {
      return cachedFallback
    }

    const [orderMetricsResult, salesQtyResult, dailyOrderResult, dailySalesQtyResult, dailyRefundResult] = await Promise.all([
      this.client.query({
        query: `
WITH order_metrics AS (
  SELECT
    COUNT(DISTINCT IF(COALESCE(o.is_regular_order, FALSE), o.order_id, NULL)) AS order_count,
    COUNT(DISTINCT IF(COALESCE(o.is_regular_order, FALSE), o.order_id, NULL)) AS regular_order_count,
    COUNT(DISTINCT IF(NOT COALESCE(o.is_regular_order, FALSE), o.order_id, NULL)) AS non_regular_order_count,
    SUM(COALESCE(o.cs_bi_gmv_usd, 0)) AS gmv,
    SUM(COALESCE(o.cs_bi_revenue_usd, 0)) AS net_received_amount,
    SUM(COALESCE(o.cs_bi_net_revenue_usd, 0)) AS net_revenue_amount,
    SUM(IF(COALESCE(o.is_regular_order, FALSE), COALESCE(o.cs_bi_revenue_usd, 0), 0)) AS regular_received_amount,
    SUM(IF(NOT COALESCE(o.is_regular_order, FALSE), COALESCE(o.cs_bi_revenue_usd, 0), 0)) AS non_regular_received_amount
  FROM \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
  WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
    AND NOT COALESCE(o.is_gift_card_order, FALSE)
    AND COALESCE(o.is_regular_order, FALSE) = TRUE
    AND (@category = '' OR o.primary_product_type = @category)
    AND (@channel = '' OR o.shop_domain = @channel)
    AND (@listing_date_from = '' OR DATE(o.first_published_at_in_order) >= DATE(@listing_date_from))
    AND (@listing_date_to = '' OR DATE(o.first_published_at_in_order) <= DATE(@listing_date_to))
    ${this.buildSkuDerivedProductFilterSql('o')}
),
refund_metrics AS (
  SELECT
    COUNT(DISTINCT re.order_id) AS refund_order_count,
    SUM(CAST(re.refund_subtotal AS NUMERIC) * COALESCE(CAST(o.usd_fx_rate AS NUMERIC), 1)) AS refund_amount
  FROM \`julang-dev-database.shopify_dwd.dwd_refund_events\` re
  JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o ON re.order_id = o.order_id
  WHERE re.refund_date BETWEEN DATE(@date_from) AND DATE(@date_to)
    AND NOT COALESCE(o.is_gift_card_order, FALSE)
    AND COALESCE(o.is_regular_order, FALSE) = TRUE
    AND (@category = '' OR o.primary_product_type = @category)
    AND (@channel = '' OR o.shop_domain = @channel)
    AND (@listing_date_from = '' OR DATE(o.first_published_at_in_order) >= DATE(@listing_date_from))
    AND (@listing_date_to = '' OR DATE(o.first_published_at_in_order) <= DATE(@listing_date_to))
    ${this.buildSkuDerivedProductFilterSql('o')}
)
SELECT
  om.order_count,
  om.regular_order_count,
  om.non_regular_order_count,
  om.gmv,
  om.net_received_amount,
  om.net_revenue_amount,
  om.regular_received_amount,
  om.non_regular_received_amount,
  rm.refund_order_count,
  rm.refund_amount
FROM order_metrics om
CROSS JOIN refund_metrics rm
        `,
        params: {
          ...this.buildParams(filters),
        },
      }),
      this.client.query({
        query: `
SELECT
  COALESCE(SUM(COALESCE(li.quantity, 0)), 0) AS sales_qty
FROM \`julang-dev-database.shopify_intermediate.int_line_items_classified\` li
JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
  ON o.order_id = li.order_id
WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
  AND NOT COALESCE(o.is_gift_card_order, FALSE)
  AND COALESCE(o.is_regular_order, FALSE) = TRUE
  AND (@category = '' OR o.primary_product_type = @category)
  AND (@channel = '' OR o.shop_domain = @channel)
  AND (
    @listing_date_from = ''
    OR DATE(o.first_published_at_in_order) >= DATE(@listing_date_from)
  )
  AND (
    @listing_date_to = ''
    OR DATE(o.first_published_at_in_order) <= DATE(@listing_date_to)
  )
  ${this.buildSkuDerivedProductFilterSql('o')}
  AND NOT COALESCE(li.is_insurance_item, FALSE)
  AND NOT COALESCE(li.is_price_adjustment, FALSE)
  AND NOT COALESCE(li.is_shipping_cost, FALSE)
        `,
        params: {
          ...this.buildParams(filters),
        },
      }),
      this.client.query({
        query: `
SELECT
  FORMAT_DATE('%Y-%m-%d', o.processed_date) AS bucket_date,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(COALESCE(o.cs_bi_gmv_usd, 0)) AS gmv,
  SUM(COALESCE(o.cs_bi_revenue_usd, 0)) AS net_received_amount,
  SUM(COALESCE(o.cs_bi_net_revenue_usd, 0)) AS net_revenue_amount
FROM \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
  AND NOT COALESCE(o.is_gift_card_order, FALSE)
  AND COALESCE(o.is_regular_order, FALSE) = TRUE
  AND (@category = '' OR o.primary_product_type = @category)
  AND (@channel = '' OR o.shop_domain = @channel)
  AND (@listing_date_from = '' OR DATE(o.first_published_at_in_order) >= DATE(@listing_date_from))
  AND (@listing_date_to = '' OR DATE(o.first_published_at_in_order) <= DATE(@listing_date_to))
  ${this.buildSkuDerivedProductFilterSql('o')}
GROUP BY bucket_date
        `,
        params: {
          ...this.buildParams(filters),
        },
      }),
      this.client.query({
        query: `
SELECT
  FORMAT_DATE('%Y-%m-%d', o.processed_date) AS bucket_date,
  COALESCE(SUM(COALESCE(li.quantity, 0)), 0) AS sales_qty
FROM \`julang-dev-database.shopify_intermediate.int_line_items_classified\` li
JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
  ON o.order_id = li.order_id
WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
  AND NOT COALESCE(o.is_gift_card_order, FALSE)
  AND COALESCE(o.is_regular_order, FALSE) = TRUE
  AND (@category = '' OR o.primary_product_type = @category)
  AND (@channel = '' OR o.shop_domain = @channel)
  AND (@listing_date_from = '' OR DATE(o.first_published_at_in_order) >= DATE(@listing_date_from))
  AND (@listing_date_to = '' OR DATE(o.first_published_at_in_order) <= DATE(@listing_date_to))
  ${this.buildSkuDerivedProductFilterSql('o')}
  AND NOT COALESCE(li.is_insurance_item, FALSE)
  AND NOT COALESCE(li.is_price_adjustment, FALSE)
  AND NOT COALESCE(li.is_shipping_cost, FALSE)
GROUP BY bucket_date
        `,
        params: {
          ...this.buildParams(filters),
        },
      }),
      this.client.query({
        query: `
SELECT
  FORMAT_DATE('%Y-%m-%d', re.refund_date) AS bucket_date,
  COUNT(DISTINCT re.order_id) AS refund_order_count,
  SUM(CAST(re.refund_subtotal AS NUMERIC) * COALESCE(CAST(o.usd_fx_rate AS NUMERIC), 1)) AS refund_amount
FROM \`julang-dev-database.shopify_dwd.dwd_refund_events\` re
JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o ON re.order_id = o.order_id
WHERE re.refund_date BETWEEN DATE(@date_from) AND DATE(@date_to)
  AND NOT COALESCE(o.is_gift_card_order, FALSE)
  AND COALESCE(o.is_regular_order, FALSE) = TRUE
  AND (@category = '' OR o.primary_product_type = @category)
  AND (@channel = '' OR o.shop_domain = @channel)
  AND (@listing_date_from = '' OR DATE(o.first_published_at_in_order) >= DATE(@listing_date_from))
  AND (@listing_date_to = '' OR DATE(o.first_published_at_in_order) <= DATE(@listing_date_to))
  ${this.buildSkuDerivedProductFilterSql('o')}
GROUP BY bucket_date
        `,
        params: {
          ...this.buildParams(filters),
        },
      }),
    ])

    const rows = extractRows(orderMetricsResult)
    const row = rows[0] ?? {}
    const salesQtyRows = extractRows(salesQtyResult)
    const bucketSums = new Map<string, P2DailyAccumulator>()
    function bucketFor(dateText: string) {
      const label = bucketLabelForDate(dateText, filters.grain)
      let entry = bucketSums.get(label)
      if (!entry) {
        entry = emptyDailyAccumulator()
        bucketSums.set(label, entry)
      }
      return entry
    }
    for (const dailyRow of extractRows(dailyOrderResult)) {
      const dateText = toText(dailyRow.bucket_date)
      if (!dateText) continue
      const entry = bucketFor(dateText)
      entry.order_count += toNumber(dailyRow.order_count)
      entry.gmv += toNumber(dailyRow.gmv)
      entry.net_received_amount += toNumber(dailyRow.net_received_amount)
      entry.net_revenue_amount += toNumber(dailyRow.net_revenue_amount)
    }
    for (const dailyRow of extractRows(dailySalesQtyResult)) {
      const dateText = toText(dailyRow.bucket_date)
      if (!dateText) continue
      const entry = bucketFor(dateText)
      entry.sales_qty += toNumber(dailyRow.sales_qty)
    }
    for (const dailyRow of extractRows(dailyRefundResult)) {
      const dateText = toText(dailyRow.bucket_date)
      if (!dateText) continue
      const entry = bucketFor(dateText)
      entry.refund_order_count += toNumber(dailyRow.refund_order_count)
      entry.refund_amount += toNumber(dailyRow.refund_amount)
    }
    const trends = buildP2TrendsFromBuckets(filters, bucketSums)

    const orderCount = toNumber(row.order_count)
    const netReceived = toNumber(row.net_received_amount)
    const refundOrderCount = toNumber(row.refund_order_count)
    const refundAmount = toNumber(row.refund_amount)

    return this.overviewCache.set(fallbackCacheKey, {
      filters,
      cards: {
        order_count: orderCount,
        sales_qty: toNumber(salesQtyRows[0]?.sales_qty),
        refund_order_count: refundOrderCount,
        refund_amount: refundAmount,
        gmv: toNumber(row.gmv),
        net_received_amount: netReceived,
        net_revenue_amount: toNumber(row.net_revenue_amount),
        refund_amount_ratio: netReceived ? refundAmount / netReceived : 0,
        avg_order_amount: orderCount ? netReceived / orderCount : 0,
      },
      trends,
      meta: {
        partial_data: false,
        source_mode: 'bigquery_fallback',
        notes: [
          ADR_0007_METRIC_NOTE,
          ...(cacheUnavailableMessage
            ? [
                `SQLite Shopify BI cache unavailable; fell back to BigQuery: ${cacheUnavailableMessage}`,
              ]
            : []),
        ],
      },
    })
  }

  async getSpuTable(filters: P2Filters, topN: number): Promise<P2SpuTablePayload> {
    let cacheUnavailableMessage: string | null = null
    try {
      if (this.cacheRepository?.hasCoverage(filters.date_from, filters.date_to)) {
        const generation = this.cacheRepository.getGeneration(filters.date_from, filters.date_to)
        const cacheKey = buildSqliteResponseCacheKey('spu-table', generation, filters, topN)
        const cached = this.spuTableCache.get(cacheKey)
        if (cached) {
          return cached
        }
        const payload = this.cacheRepository.queryP2SpuTable(filters, topN)
        return this.spuTableCache.set(cacheKey, {
          filters,
          rows: payload.rows,
          meta: {
            partial_data: false,
            source_mode: 'sqlite_shopify_bi_cache',
            cache_generation: generation,
            notes: [],
          },
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      cacheUnavailableMessage = message
    }

    if (!this.client) {
      return {
        filters,
        rows: [],
        meta: {
          partial_data: true,
          notes: [
            ...(cacheUnavailableMessage
              ? [`SQLite Shopify BI cache unavailable: ${cacheUnavailableMessage}`]
              : []),
            'BigQuery credentials not found; returning empty table.',
          ],
        },
      }
    }

    const fallbackCacheKey = buildBigQueryFallbackCacheKey('spu-table', filters, topN)
    const cachedFallback = this.spuTableCache.get(fallbackCacheKey)
    if (cachedFallback) {
      return cachedFallback
    }

    const effectiveSpuList = filters.spu_list?.length
      ? filters.spu_list
      : filters.spu
        ? [filters.spu]
        : ['__ALL__']
    const effectiveSkcList = filters.skc_list?.length
      ? filters.skc_list
      : filters.skc
        ? [filters.skc]
        : ['__ALL__']
    const spuFilterOn = Boolean(filters.spu_list?.length || filters.spu)
    const skcFilterOn = Boolean(filters.skc_list?.length || filters.skc)

    const rows = extractRows(
      await this.client.query({
        query: `
WITH parsed_lines AS (
  SELECT
    li.order_id,
    li.sku,
    li.quantity,
    li.discounted_total,
    o.processed_date,
    o.usd_fx_rate,
    CASE
      WHEN li.sku IS NULL OR TRIM(li.sku) = '' THEN 'N/A'
      WHEN STRPOS(TRIM(li.sku), '-') > 0 THEN REGEXP_REPLACE(TRIM(li.sku), r'-[^-]+$', '')
      ELSE TRIM(li.sku)
    END AS parsed_skc
  FROM \`julang-dev-database.shopify_intermediate.int_line_items_classified\` li
  JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
    ON o.order_id = li.order_id
  WHERE NOT COALESCE(o.is_gift_card_order, FALSE)
    AND COALESCE(o.is_regular_order, FALSE) = TRUE
    AND NOT COALESCE(li.is_insurance_item, FALSE)
    AND NOT COALESCE(li.is_price_adjustment, FALSE)
    AND NOT COALESCE(li.is_shipping_cost, FALSE)
    AND (@category = '' OR o.primary_product_type = @category)
    AND (@channel = '' OR o.shop_domain = @channel)
    AND (
      @listing_date_from = ''
      OR DATE(o.first_published_at_in_order) >= DATE(@listing_date_from)
    )
    AND (
      @listing_date_to = ''
      OR DATE(o.first_published_at_in_order) <= DATE(@listing_date_to)
    )
),
line_dim AS (
  SELECT
    *,
    CASE
      WHEN parsed_skc = 'N/A' THEN 'N/A'
      WHEN REGEXP_CONTAINS(REGEXP_EXTRACT(parsed_skc, r'([^-]+)$'), r'\\d') THEN
        CASE
          WHEN (
            CASE
              WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
              ELSE ''
            END
          ) != '' THEN CONCAT(
            CASE
              WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
              ELSE ''
            END,
            '-',
            COALESCE(
              REGEXP_EXTRACT(REGEXP_EXTRACT(parsed_skc, r'([^-]+)$'), r'^([a-zA-Z]*\\d+)'),
              REGEXP_EXTRACT(parsed_skc, r'([^-]+)$')
            )
          )
          ELSE COALESCE(
            REGEXP_EXTRACT(REGEXP_EXTRACT(parsed_skc, r'([^-]+)$'), r'^([a-zA-Z]*\\d+)'),
            REGEXP_EXTRACT(parsed_skc, r'([^-]+)$')
          )
        END
      ELSE
        CASE
          WHEN (
            CASE
              WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
              ELSE ''
            END
          ) != '' THEN
            CASE
              WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
              ELSE ''
            END
          ELSE REGEXP_EXTRACT(parsed_skc, r'([^-]+)$')
        END
    END AS parsed_spu
  FROM parsed_lines
),
sales_lines AS (
  SELECT
    order_id,
    parsed_skc,
    parsed_spu,
    parsed_skc AS skc,
    COALESCE(quantity, 0) AS quantity,
    COALESCE(CAST(discounted_total AS NUMERIC) * COALESCE(CAST(usd_fx_rate AS NUMERIC), 1), 0) AS sales_amount
  FROM line_dim
  WHERE processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
    AND (@skc_filter_on = 0 OR parsed_skc IN UNNEST(@skc_list))
    AND (@spu_filter_on = 0 OR parsed_spu IN UNNEST(@spu_list))
),
sales_agg AS (
  SELECT
    parsed_spu AS spu,
    skc,
    SUM(quantity) AS sales_qty,
    SUM(sales_amount) AS sales_amount
  FROM sales_lines
  GROUP BY 1, 2
),
refund_event_agg AS (
  SELECT
    re.order_id,
    re.sku,
    SUM(COALESCE(re.quantity, 0)) AS refund_qty,
    SUM(CAST(re.refund_subtotal AS NUMERIC) * COALESCE(CAST(o.usd_fx_rate AS NUMERIC), 1)) AS refund_amount
  FROM \`julang-dev-database.shopify_dwd.dwd_refund_events\` re
  JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
    ON o.order_id = re.order_id
  WHERE re.refund_date BETWEEN DATE(@date_from) AND DATE(@date_to)
  GROUP BY 1, 2
),
refund_line_dim AS (
  SELECT
    order_id,
    sku,
    MIN(parsed_skc) AS skc,
    MIN(parsed_spu) AS spu
  FROM line_dim
  WHERE (@skc_filter_on = 0 OR parsed_skc IN UNNEST(@skc_list))
    AND (@spu_filter_on = 0 OR parsed_spu IN UNNEST(@spu_list))
  GROUP BY 1, 2
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
  GROUP BY 1, 2
),
product_keys AS (
  SELECT spu, skc FROM sales_agg
  UNION DISTINCT
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
    ON sa.spu = k.spu
   AND sa.skc = k.skc
  LEFT JOIN refund_agg ra
    ON ra.spu = k.spu
   AND ra.skc = k.skc
),
spu_rank AS (
  SELECT
    spu,
    SUM(refund_amount) AS refund_amount
  FROM product_metrics
  GROUP BY 1
  QUALIFY ROW_NUMBER() OVER (ORDER BY refund_amount DESC, spu) <= @top_n
),
spu_agg AS (
  SELECT
    pm.spu,
    SUM(pm.sales_qty) AS sales_qty,
    SUM(pm.sales_amount) AS sales_amount,
    SUM(pm.refund_qty) AS refund_qty,
    SUM(pm.refund_amount) AS refund_amount
  FROM product_metrics pm
  JOIN spu_rank sr ON sr.spu = pm.spu
  GROUP BY 1
),
skc_agg AS (
  SELECT
    pm.spu,
    pm.skc,
    SUM(pm.sales_qty) AS sales_qty,
    SUM(pm.sales_amount) AS sales_amount,
    SUM(pm.refund_qty) AS refund_qty,
    SUM(pm.refund_amount) AS refund_amount
  FROM product_metrics pm
  JOIN spu_rank sr ON sr.spu = pm.spu
  GROUP BY 1, 2
)
SELECT
  'SPU' AS row_type,
  sa.spu,
  CAST(NULL AS STRING) AS skc,
  sa.sales_qty,
  sa.sales_amount,
  sa.refund_qty,
  sa.refund_amount,
  SAFE_DIVIDE(sa.refund_qty, sa.sales_qty) AS refund_qty_ratio,
  SAFE_DIVIDE(sa.refund_amount, sa.sales_amount) AS refund_amount_ratio
FROM spu_agg sa
UNION ALL
SELECT
  'SKC' AS row_type,
  ka.spu,
  ka.skc,
  ka.sales_qty,
  ka.sales_amount,
  ka.refund_qty,
  ka.refund_amount,
  SAFE_DIVIDE(ka.refund_qty, ka.sales_qty) AS refund_qty_ratio,
  SAFE_DIVIDE(ka.refund_amount, ka.sales_amount) AS refund_amount_ratio
FROM skc_agg ka
ORDER BY spu, row_type DESC, refund_amount DESC
        `,
        params: {
          ...this.buildParams(filters),
          spu_filter_on: spuFilterOn ? 1 : 0,
          skc_filter_on: skcFilterOn ? 1 : 0,
          spu_list: effectiveSpuList,
          skc_list: effectiveSkcList,
          top_n: topN,
        },
      }),
    )

    const grouped = new Map<
      string,
      {
        spu: string
        sales_qty: number
        sales_amount: number
        refund_qty: number
        refund_amount: number
        refund_qty_ratio: number
        refund_amount_ratio: number
        skc_rows: Array<{
          skc: string
          sales_qty: number
          sales_amount: number
          refund_qty: number
          refund_amount: number
          refund_qty_ratio: number
          refund_amount_ratio: number
        }>
      }
    >()

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
      if (toText(row.row_type) === 'SPU') {
        current.sales_qty = toNumber(row.sales_qty)
        current.sales_amount = toNumber(row.sales_amount)
        current.refund_qty = toNumber(row.refund_qty)
        current.refund_amount = toNumber(row.refund_amount)
        current.refund_qty_ratio = toNumber(row.refund_qty_ratio)
        current.refund_amount_ratio = toNumber(row.refund_amount_ratio)
      } else {
        current.skc_rows.push({
          skc: toText(row.skc),
          sales_qty: toNumber(row.sales_qty),
          sales_amount: toNumber(row.sales_amount),
          refund_qty: toNumber(row.refund_qty),
          refund_amount: toNumber(row.refund_amount),
          refund_qty_ratio: toNumber(row.refund_qty_ratio),
          refund_amount_ratio: toNumber(row.refund_amount_ratio),
        })
      }
    }

    for (const item of grouped.values()) {
      item.skc_rows.sort((a, b) => b.refund_amount - a.refund_amount)
    }

    return this.spuTableCache.set(fallbackCacheKey, {
      filters,
      rows: [...grouped.values()].sort((a, b) => b.refund_amount - a.refund_amount),
      meta: {
        partial_data: false,
        source_mode: 'bigquery_fallback',
        notes: [
          ...(cacheUnavailableMessage
            ? [
                `SQLite Shopify BI cache unavailable; fell back to BigQuery: ${cacheUnavailableMessage}`,
              ]
            : []),
        ],
      },
    })
  }

  async getSpuSkcOptions(filters: P2Filters): Promise<P2SpuSkcOptionsPayload> {
    let cacheUnavailableMessage: string | null = null
    try {
      if (this.cacheRepository?.hasCoverage(filters.date_from, filters.date_to)) {
        const generation = this.cacheRepository.getGeneration(filters.date_from, filters.date_to)
        const cacheKey = buildSqliteResponseCacheKey('spu-skc-options', generation, filters)
        const cached = this.optionsCache.get(cacheKey)
        if (cached) {
          return cached
        }
        const payload = this.cacheRepository.queryP2SpuSkcOptions(filters)
        return this.optionsCache.set(cacheKey, {
          filters,
          options: payload.options,
          meta: {
            partial_data: false,
            source_mode: 'sqlite_shopify_bi_cache',
            cache_generation: generation,
            notes: [],
          },
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      cacheUnavailableMessage = message
    }

    if (!this.client) {
      return {
        filters,
        options: { spus: [], skcs: [], pairs: [] },
        meta: {
          partial_data: true,
          notes: [
            ...(cacheUnavailableMessage
              ? [`SQLite Shopify BI cache unavailable: ${cacheUnavailableMessage}`]
              : []),
            'BigQuery credentials not found; returning empty options.',
          ],
        },
      }
    }

    const fallbackCacheKey = buildBigQueryFallbackCacheKey('spu-skc-options', filters)
    const cachedFallback = this.optionsCache.get(fallbackCacheKey)
    if (cachedFallback) {
      return cachedFallback
    }

    const rows = extractRows(
      await this.client.query({
        query: `
WITH parsed AS (
  SELECT
    CASE
      WHEN li.sku IS NULL OR TRIM(li.sku) = '' THEN 'N/A'
      WHEN STRPOS(TRIM(li.sku), '-') > 0 THEN REGEXP_REPLACE(TRIM(li.sku), r'-[^-]+$', '')
      ELSE TRIM(li.sku)
    END AS parsed_skc
  FROM \`julang-dev-database.shopify_intermediate.int_line_items_classified\` li
  JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
    ON o.order_id = li.order_id
  WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
    AND NOT COALESCE(o.is_gift_card_order, FALSE)
    AND COALESCE(o.is_regular_order, FALSE) = TRUE
    AND NOT COALESCE(li.is_insurance_item, FALSE)
    AND NOT COALESCE(li.is_price_adjustment, FALSE)
    AND NOT COALESCE(li.is_shipping_cost, FALSE)
    AND (@category = '' OR o.primary_product_type = @category)
    AND (@channel = '' OR o.shop_domain = @channel)
    AND (
      @listing_date_from = ''
      OR DATE(o.first_published_at_in_order) >= DATE(@listing_date_from)
    )
    AND (
      @listing_date_to = ''
      OR DATE(o.first_published_at_in_order) <= DATE(@listing_date_to)
    )
),
parsed2 AS (
  SELECT
    parsed_skc,
    REGEXP_EXTRACT(parsed_skc, r'([^-]+)$') AS skc_last_segment,
    CASE
      WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
      ELSE ''
    END AS skc_prefix
  FROM parsed
)
SELECT DISTINCT
  CASE
    WHEN parsed_skc = 'N/A' THEN 'N/A'
    WHEN REGEXP_CONTAINS(skc_last_segment, r'\\d') THEN
      CASE
        WHEN skc_prefix != '' THEN CONCAT(
          skc_prefix,
          '-',
          COALESCE(
            REGEXP_EXTRACT(skc_last_segment, r'^([a-zA-Z]*\\d+)'),
            skc_last_segment
          )
        )
        ELSE COALESCE(
          REGEXP_EXTRACT(skc_last_segment, r'^([a-zA-Z]*\\d+)'),
          skc_last_segment
        )
      END
    ELSE
      CASE
        WHEN skc_prefix != '' THEN skc_prefix
        ELSE skc_last_segment
      END
  END AS spu,
  parsed_skc AS skc
FROM parsed2
WHERE parsed_skc IS NOT NULL
        `,
        params: { ...this.buildParams(filters) },
      }),
    )

    const pairs = rows
      .map((row) => ({ spu: toText(row.spu), skc: toText(row.skc) }))
      .filter((item) => item.spu && item.skc && item.skc !== 'UNKNOWN_SKC')
    const spus = [...new Set(pairs.map((item) => item.spu))].sort()
    const skcs = [...new Set(pairs.map((item) => item.skc))].sort()

    return this.optionsCache.set(fallbackCacheKey, {
      filters,
      options: { spus, skcs, pairs },
      meta: {
        partial_data: false,
        source_mode: 'bigquery_fallback',
        notes: [
          ...(cacheUnavailableMessage
            ? [
                `SQLite Shopify BI cache unavailable; fell back to BigQuery: ${cacheUnavailableMessage}`,
              ]
            : []),
        ],
      },
    })
  }

  private buildParams(filters: P2Filters) {
    return {
      date_from: filters.date_from,
      date_to: filters.date_to,
      category: filters.category ?? '',
      spu: filters.spu ?? '',
      skc: filters.skc ?? '',
      channel: filters.channel ?? '',
      listing_date_from: filters.listing_date_from ?? '',
      listing_date_to: filters.listing_date_to ?? '',
    }
  }

  private buildSkuDerivedProductFilterSql(orderAlias: string) {
    return `
    AND (
      (@skc = '' AND @spu = '')
      OR EXISTS (
        SELECT 1
        FROM (
          SELECT
            parsed_skc,
            CASE
              WHEN parsed_skc = 'N/A' THEN 'N/A'
              WHEN REGEXP_CONTAINS(REGEXP_EXTRACT(parsed_skc, r'([^-]+)$'), r'\\d') THEN
                CASE
                  WHEN (
                    CASE
                      WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
                      ELSE ''
                    END
                  ) != '' THEN CONCAT(
                    CASE
                      WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
                      ELSE ''
                    END,
                    '-',
                    COALESCE(
                      REGEXP_EXTRACT(REGEXP_EXTRACT(parsed_skc, r'([^-]+)$'), r'^([a-zA-Z]*\\d+)'),
                      REGEXP_EXTRACT(parsed_skc, r'([^-]+)$')
                    )
                  )
                  ELSE COALESCE(
                    REGEXP_EXTRACT(REGEXP_EXTRACT(parsed_skc, r'([^-]+)$'), r'^([a-zA-Z]*\\d+)'),
                    REGEXP_EXTRACT(parsed_skc, r'([^-]+)$')
                  )
                END
              ELSE
                CASE
                  WHEN (
                    CASE
                      WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
                      ELSE ''
                    END
                  ) != '' THEN
                    CASE
                      WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
                      ELSE ''
                    END
                  ELSE REGEXP_EXTRACT(parsed_skc, r'([^-]+)$')
                END
            END AS parsed_spu
          FROM (
            SELECT
              CASE
                WHEN li_filter.sku IS NULL OR TRIM(li_filter.sku) = '' THEN 'N/A'
                WHEN STRPOS(TRIM(li_filter.sku), '-') > 0 THEN REGEXP_REPLACE(TRIM(li_filter.sku), r'-[^-]+$', '')
                ELSE TRIM(li_filter.sku)
              END AS parsed_skc
            FROM \`julang-dev-database.shopify_intermediate.int_line_items_classified\` li_filter
            WHERE li_filter.order_id = ${orderAlias}.order_id
              AND NOT COALESCE(li_filter.is_insurance_item, FALSE)
              AND NOT COALESCE(li_filter.is_price_adjustment, FALSE)
              AND NOT COALESCE(li_filter.is_shipping_cost, FALSE)
          )
        ) product_filter
        WHERE (@skc = '' OR product_filter.parsed_skc = @skc)
          AND (@spu = '' OR product_filter.parsed_spu = @spu)
      )
    )`
  }
}

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
