import fs from 'node:fs'
import { BigQuery } from '@google-cloud/bigquery'
import { SqliteShopifyBiCacheRepository } from '../../integrations/shopify-bi-cache.js'
import { loadP3RuntimeConfig } from '../../integrations/sync-config.js'

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

export type P2CacheRepository = {
  hasCoverage(dateFrom: string, dateTo: string): boolean
  getGeneration(dateFrom: string, dateTo: string): string
  queryP2Overview(filters: P2Filters): {
    cards: P2OverviewCards
  }
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

export class P2Service {
  constructor(
    private readonly client: BigQueryLike | null,
    private readonly cacheRepository: P2CacheRepository | null = null,
  ) {}

  async getOverview(filters: P2Filters) {
    let cacheFallbackNote: string | null = null
    try {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      cacheFallbackNote = `SQLite Shopify BI cache unavailable; fell back to BigQuery: ${message}`
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
        meta: {
          partial_data: true,
          notes: [
            ...(cacheFallbackNote ? [cacheFallbackNote] : []),
            'BigQuery credentials not found; returning empty overview.',
          ],
        },
      }
    }

    const rows = extractRows(
      await this.client.query({
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
    AND (@skc = '' OR @skc IN UNNEST(IFNULL(o.skcs, [])))
    AND (@spu = '' OR @spu IN UNNEST(IFNULL(o.product_ids, [])))
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
    AND (@skc = '' OR @skc IN UNNEST(IFNULL(o.skcs, [])))
    AND (@spu = '' OR @spu IN UNNEST(IFNULL(o.product_ids, [])))
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
    )

    const row = rows[0] ?? {}
    const salesQtyRows = extractRows(
      await this.client.query({
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
  AND (@skc = '' OR @skc IN UNNEST(IFNULL(o.skcs, [])))
  AND (@spu = '' OR @spu IN UNNEST(IFNULL(o.product_ids, [])))
  AND NOT COALESCE(li.is_insurance_item, FALSE)
  AND NOT COALESCE(li.is_price_adjustment, FALSE)
  AND NOT COALESCE(li.is_shipping_cost, FALSE)
        `,
        params: {
          ...this.buildParams(filters),
        },
      }),
    )

    const orderCount = toNumber(row.order_count)
    const netReceived = toNumber(row.net_received_amount)
    const refundOrderCount = toNumber(row.refund_order_count)
    const refundAmount = toNumber(row.refund_amount)

    return {
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
      meta: {
        partial_data: false,
        source_mode: 'bigquery_fallback',
        notes: [
          ADR_0007_METRIC_NOTE,
          ...(cacheFallbackNote ? [cacheFallbackNote] : []),
        ],
      },
    }
  }

  async getSpuTable(filters: P2Filters, topN: number) {
    if (!this.client) {
      return {
        filters,
        rows: [],
        meta: {
          partial_data: true,
          notes: ['BigQuery credentials not found; returning empty table.'],
        },
      }
    }

    const rows = extractRows(
      await this.client.query({
        query: `
WITH line_base AS (
  WITH parsed AS (
    SELECT
      li.order_id,
      li.sku,
      li.variant_id,
      li.product_id,
      li.quantity,
      li.discounted_total,
      re.refund_subtotal,
      re.quantity AS refund_quantity,
      o.processed_date,
      o.is_gift_card_order,
      o.usd_fx_rate,
      o.primary_product_type,
      o.shop_domain,
      o.first_published_at_in_order,
      CASE
        WHEN li.sku IS NULL OR TRIM(li.sku) = '' THEN 'N/A'
        WHEN STRPOS(TRIM(li.sku), '-') > 0 THEN REGEXP_REPLACE(TRIM(li.sku), r'-[^-]+$', '')
        ELSE TRIM(li.sku)
      END AS parsed_skc
    FROM \`julang-dev-database.shopify_intermediate.int_line_items_classified\` li
    JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
      ON o.order_id = li.order_id
    LEFT JOIN \`julang-dev-database.shopify_dwd.dwd_refund_events\` re
      ON re.order_id = li.order_id
     AND re.sku = li.sku
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
      *,
      SPLIT(parsed_skc, '-') AS skc_parts,
      REGEXP_EXTRACT(parsed_skc, r'([^-]+)$') AS skc_last_segment,
      CASE
        WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
        ELSE ''
      END AS skc_prefix,
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
    FROM parsed
  )
  SELECT
    order_id,
    parsed_skc,
    parsed_spu,
    parsed_skc AS skc,
    COALESCE(quantity, 0) AS quantity,
    COALESCE(CAST(discounted_total AS NUMERIC) * COALESCE(CAST(usd_fx_rate AS NUMERIC), 1), 0) AS sales_amount,
    COALESCE(CAST(refund_subtotal AS NUMERIC) * COALESCE(CAST(usd_fx_rate AS NUMERIC), 1), 0) AS refund_amount_line,
    COALESCE(refund_quantity, 0) AS refund_qty_line
  FROM parsed2
  WHERE
    (@skc_filter_on = 0 OR parsed_skc IN UNNEST(@skc_list))
    AND (@spu_filter_on = 0 OR parsed_spu IN UNNEST(@spu_list))
),
spu_rank AS (
  SELECT
    parsed_spu AS spu,
    SUM(refund_amount_line) AS refund_amount
  FROM line_base
  GROUP BY 1
  QUALIFY ROW_NUMBER() OVER (ORDER BY refund_amount DESC, spu) <= @top_n
),
spu_agg AS (
  SELECT
    lb.parsed_spu AS spu,
    SUM(lb.quantity) AS sales_qty,
    SUM(lb.sales_amount) AS sales_amount,
    SUM(lb.refund_qty_line) AS refund_qty,
    SUM(lb.refund_amount_line) AS refund_amount
  FROM line_base lb
  JOIN spu_rank sr ON sr.spu = lb.parsed_spu
  GROUP BY 1
),
skc_agg AS (
  SELECT
    lb.parsed_spu AS spu,
    lb.skc,
    SUM(lb.quantity) AS sales_qty,
    SUM(lb.sales_amount) AS sales_amount,
    SUM(lb.refund_qty_line) AS refund_qty,
    SUM(lb.refund_amount_line) AS refund_amount
  FROM line_base lb
  JOIN spu_rank sr ON sr.spu = lb.parsed_spu
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
          spu_filter_on: filters.spu_list?.length ? 1 : 0,
          skc_filter_on: filters.skc_list?.length ? 1 : 0,
          spu_list: filters.spu_list?.length ? filters.spu_list : ['__ALL__'],
          skc_list: filters.skc_list?.length ? filters.skc_list : ['__ALL__'],
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

    return {
      filters,
      rows: [...grouped.values()].sort((a, b) => b.refund_amount - a.refund_amount),
      meta: {
        partial_data: false,
        notes: [],
      },
    }
  }

  async getSpuSkcOptions(filters: P2Filters) {
    if (!this.client) {
      return {
        filters,
        options: { spus: [], skcs: [] },
        meta: { partial_data: true, notes: ['BigQuery credentials not found; returning empty options.'] },
      }
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

    return {
      filters,
      options: { spus, skcs, pairs },
      meta: { partial_data: false, notes: [] },
    }
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
