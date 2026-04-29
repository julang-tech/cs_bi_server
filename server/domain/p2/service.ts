import fs from 'node:fs'
import { BigQuery } from '@google-cloud/bigquery'

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
}

type BigQueryLike = {
  query(options: unknown): Promise<unknown>
}

type BigQueryRows = Array<Record<string, unknown>>

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

const BASE_FROM = `
FROM \`julang-dev-database.shopify_dwd.dwd_orders_fact\` o
LEFT JOIN (
  SELECT order_id, SUM(CAST(refund_subtotal AS NUMERIC)) AS refund_amount
  FROM \`julang-dev-database.shopify_dwd.dwd_refund_events\`
  GROUP BY order_id
) r ON r.order_id = o.order_id
WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
  AND NOT COALESCE(o.is_gift_card_order, FALSE)
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
`

export class P2Service {
  constructor(private readonly client: BigQueryLike | null) {}

  async getOverview(filters: P2Filters) {
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
          regular_order_count: 0,
          non_regular_order_count: 0,
          regular_received_amount: 0,
          non_regular_received_amount: 0,
          avg_order_amount: 0,
          regular_avg_order_amount: 0,
          non_regular_avg_order_amount: 0,
          refund_order_ratio_total: 0,
          refund_order_ratio_regular: 0,
        },
        meta: {
          partial_data: true,
          notes: ['BigQuery credentials not found; returning empty overview.'],
        },
      }
    }

    const rows = extractRows(
      await this.client.query({
        query: `
SELECT
  COUNT(DISTINCT o.order_id) AS order_count,
  COUNT(DISTINCT IF(COALESCE(o.is_regular_order, FALSE), o.order_id, NULL)) AS regular_order_count,
  COUNT(DISTINCT IF(NOT COALESCE(o.is_regular_order, FALSE), o.order_id, NULL)) AS non_regular_order_count,
  SUM(COALESCE(o.gmv, 0)) AS gmv,
  SUM(COALESCE(o.revenue_after_all_discounts, 0)) AS net_received_amount,
  SUM(COALESCE(o.revenue_after_all_discounts, 0) - COALESCE(r.refund_amount, 0)) AS net_revenue_amount,
  SUM(IF(COALESCE(o.is_regular_order, FALSE), COALESCE(o.revenue_after_all_discounts, 0), 0)) AS regular_received_amount,
  SUM(IF(NOT COALESCE(o.is_regular_order, FALSE), COALESCE(o.revenue_after_all_discounts, 0), 0)) AS non_regular_received_amount,
  COUNT(DISTINCT IF(COALESCE(r.refund_amount, 0) > 0, o.order_id, NULL)) AS refund_order_count,
  SUM(COALESCE(r.refund_amount, 0)) AS refund_amount
${BASE_FROM}
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
JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact\` o
  ON o.order_id = li.order_id
WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
  AND NOT COALESCE(o.is_gift_card_order, FALSE)
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
        `,
        params: {
          ...this.buildParams(filters),
        },
      }),
    )

    const orderCount = toNumber(row.order_count)
    const regularOrderCount = toNumber(row.regular_order_count)
    const nonRegularOrderCount = toNumber(row.non_regular_order_count)
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
        regular_order_count: regularOrderCount,
        non_regular_order_count: nonRegularOrderCount,
        regular_received_amount: toNumber(row.regular_received_amount),
        non_regular_received_amount: toNumber(row.non_regular_received_amount),
        avg_order_amount: orderCount ? netReceived / orderCount : 0,
        regular_avg_order_amount: regularOrderCount
          ? toNumber(row.regular_received_amount) / regularOrderCount
          : 0,
        non_regular_avg_order_amount: nonRegularOrderCount
          ? toNumber(row.non_regular_received_amount) / nonRegularOrderCount
          : 0,
        refund_order_ratio_total: orderCount ? refundOrderCount / orderCount : 0,
        refund_order_ratio_regular: regularOrderCount ? refundOrderCount / regularOrderCount : 0,
      },
      meta: {
        partial_data: false,
        notes: [],
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
      o.primary_product_type,
      o.shop_domain,
      o.first_published_at_in_order,
      CASE
        WHEN li.sku IS NULL OR TRIM(li.sku) = '' THEN 'N/A'
        WHEN STRPOS(TRIM(li.sku), '-') > 0 THEN REGEXP_REPLACE(TRIM(li.sku), r'-[^-]+$', '')
        ELSE TRIM(li.sku)
      END AS parsed_skc
    FROM \`julang-dev-database.shopify_intermediate.int_line_items_classified\` li
    JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact\` o
      ON o.order_id = li.order_id
    LEFT JOIN \`julang-dev-database.shopify_dwd.dwd_refund_events\` re
      ON re.order_id = li.order_id
     AND re.sku = li.sku
    WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
      AND NOT COALESCE(o.is_gift_card_order, FALSE)
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
      *,
      SPLIT(parsed_skc, '-') AS skc_parts,
      REGEXP_EXTRACT(parsed_skc, r'([^-]+)$') AS skc_last_segment,
      CASE
        WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
        ELSE ''
      END AS skc_prefix
    FROM parsed
  )
  SELECT
    order_id,
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
    parsed_skc AS skc,
    COALESCE(quantity, 0) AS quantity,
    COALESCE(discounted_total, 0) AS sales_amount,
    COALESCE(refund_subtotal, 0) AS refund_amount_line,
    COALESCE(refund_quantity, 0) AS refund_qty_line
  FROM parsed2
  WHERE
    (
      @skc = ''
      OR parsed_skc = @skc
    )
    AND (
      @spu = ''
      OR (
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
        END
      ) = @spu
    )
),
spu_rank AS (
  SELECT
    spu,
    SUM(refund_amount_line) AS refund_amount
  FROM line_base
  GROUP BY 1
  QUALIFY ROW_NUMBER() OVER (ORDER BY refund_amount DESC, spu) <= @top_n
),
spu_agg AS (
  SELECT
    lb.spu,
    SUM(lb.quantity) AS sales_qty,
    SUM(lb.sales_amount) AS sales_amount,
    SUM(lb.refund_qty_line) AS refund_qty,
    SUM(lb.refund_amount_line) AS refund_amount
  FROM line_base lb
  JOIN spu_rank sr ON sr.spu = lb.spu
  GROUP BY 1
),
skc_agg AS (
  SELECT
    lb.spu,
    lb.skc,
    SUM(lb.quantity) AS sales_qty,
    SUM(lb.sales_amount) AS sales_amount,
    SUM(lb.refund_qty_line) AS refund_qty,
    SUM(lb.refund_amount_line) AS refund_amount
  FROM line_base lb
  JOIN spu_rank sr ON sr.spu = lb.spu
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
  return new P2Service(hasBigQuery ? new BigQuery() : null)
}
