import fs from 'node:fs'
import path from 'node:path'
import { BigQuery } from '@google-cloud/bigquery'
import { TtlCache } from '../domain/p3/cache.js'
import type {
  OrderEnrichmentRepository,
  OrderLineContext,
  P3Filters,
  SalesRepository,
  StandardIssueRecord,
  SummaryMetrics,
  TrendPoint,
} from '../domain/p3/models.js'

function getSamplePath(repoRoot: string) {
  const formalPath = path.join(repoRoot, 'docs', 'p3-formal-runtime-sample-response.json')
  const litePath = path.join(repoRoot, 'docs', 'p3-lite-sample-response.json')
  return fs.existsSync(formalPath) ? formalPath : litePath
}

function readDashboardSample(repoRoot: string) {
  return JSON.parse(fs.readFileSync(getSamplePath(repoRoot), 'utf8')) as {
    summary: { sales_qty: number }
    trends: {
      sales_qty: Array<{ bucket: string; value: number }>
    }
  }
}

export class SampleSalesRepository implements SalesRepository {
  constructor(private readonly repoRoot: string) {}

  async fetchSummary(): Promise<SummaryMetrics> {
    const sample = readDashboardSample(this.repoRoot)
    return { sales_qty: sample.summary.sales_qty, complaint_count: 0 }
  }

  async fetchTrends(): Promise<TrendPoint[]> {
    const sample = readDashboardSample(this.repoRoot)
    return sample.trends.sales_qty.map((point) => ({
      bucket: point.bucket,
      sales_qty: point.value,
      complaint_count: 0,
    }))
  }
}

export class SampleOrderEnrichmentRepository implements OrderEnrichmentRepository {
  async enrichIssues(issues: StandardIssueRecord[]) {
    const enriched = issues.map((issue) => {
      const fallbackLineItems: OrderLineContext[] =
        issue.major_issue_type === 'logistics'
          ? issue.order_line_contexts
          : [
              {
                sku: issue.sku ?? `${issue.order_no}-SKU`,
                quantity: 1,
                skc: issue.skc ?? `${issue.order_no}-SKC`,
                spu: issue.spu ?? `${issue.order_no}-SPU`,
              },
            ]

      return {
        ...issue,
        order_date: issue.order_date ?? issue.record_date ?? null,
        order_line_contexts: fallbackLineItems,
        skc: issue.skc ?? fallbackLineItems[0]?.skc ?? null,
        spu: issue.spu ?? fallbackLineItems[0]?.spu ?? null,
      }
    })

    return { issues: enriched, notes: [] }
  }
}

type BigQueryRows = Array<Record<string, unknown>>

type BigQueryLike = {
  query(options: unknown): Promise<unknown>
}

function extractRows(result: unknown): BigQueryRows {
  if (!Array.isArray(result)) {
    return []
  }

  const [rows] = result as [unknown, ...unknown[]]
  return Array.isArray(rows) ? (rows as BigQueryRows) : []
}

export class BigQuerySalesRepository implements SalesRepository {
  private readonly summaryCache = new TtlCache<SummaryMetrics>(300_000)
  private readonly trendCache = new TtlCache<TrendPoint[]>(300_000)

  constructor(private readonly client: BigQueryLike) {}

  async fetchSummary(filters: P3Filters): Promise<SummaryMetrics> {
    const cacheKey = JSON.stringify(['summary', filters])
    const cached = this.summaryCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const rows = extractRows(await this.client.query({
      query: `
SELECT
  COALESCE(SUM(li.quantity), 0) AS sales_qty
FROM \`julang-dev-database.shopify_ods.ods_shopify_order_line_items\` li
JOIN \`julang-dev-database.shopify_ods.ods_shopify_orders\` o
  ON li.order_id = o.order_id AND li.shop_domain = o.shop_domain
LEFT JOIN \`julang-dev-database.shopify_intermediate.int_product_skc\` skc_map
  ON skc_map.variant_sku = li.sku
LEFT JOIN \`julang-dev-database.product_information_database.dim_product_sku\` sku_dim
  ON sku_dim.sku_id = li.sku
WHERE o.processed_at IS NOT NULL
  AND DATE(o.processed_at) BETWEEN DATE(@date_from) AND DATE(@date_to)
  AND (@sku = '' OR li.sku = @sku)
  AND (@skc = '' OR COALESCE(skc_map.skc, sku_dim.skc_id) = @skc)
  AND (@spu = '' OR sku_dim.spu_id = @spu)
      `,
      params: {
        date_from: filters.date_from,
        date_to: filters.date_to,
        sku: filters.sku ?? '',
        skc: filters.skc ?? '',
        spu: filters.spu ?? '',
      },
    }))

    const result = {
      sales_qty: Number(rows[0]?.sales_qty ?? 0),
      complaint_count: 0,
    }
    return this.summaryCache.set(cacheKey, result)
  }

  async fetchTrends(filters: P3Filters): Promise<TrendPoint[]> {
    const cacheKey = JSON.stringify(['trends', filters])
    const cached = this.trendCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const bucketExpression =
      filters.grain === 'day'
        ? 'DATE(o.processed_at)'
        : filters.grain === 'week'
          ? 'DATE_TRUNC(DATE(o.processed_at), WEEK(MONDAY))'
          : 'DATE_TRUNC(DATE(o.processed_at), MONTH)'

    const rows = extractRows(await this.client.query({
      query: `
SELECT
  CAST(${bucketExpression} AS STRING) AS bucket,
  SUM(li.quantity) AS sales_qty
FROM \`julang-dev-database.shopify_ods.ods_shopify_order_line_items\` li
JOIN \`julang-dev-database.shopify_ods.ods_shopify_orders\` o
  ON li.order_id = o.order_id AND li.shop_domain = o.shop_domain
LEFT JOIN \`julang-dev-database.shopify_intermediate.int_product_skc\` skc_map
  ON skc_map.variant_sku = li.sku
LEFT JOIN \`julang-dev-database.product_information_database.dim_product_sku\` sku_dim
  ON sku_dim.sku_id = li.sku
WHERE o.processed_at IS NOT NULL
  AND DATE(o.processed_at) BETWEEN DATE(@date_from) AND DATE(@date_to)
  AND (@sku = '' OR li.sku = @sku)
  AND (@skc = '' OR COALESCE(skc_map.skc, sku_dim.skc_id) = @skc)
  AND (@spu = '' OR sku_dim.spu_id = @spu)
GROUP BY 1
ORDER BY 1
      `,
      params: {
        date_from: filters.date_from,
        date_to: filters.date_to,
        sku: filters.sku ?? '',
        skc: filters.skc ?? '',
        spu: filters.spu ?? '',
      },
    }))

    const result = rows.map((row) => ({
      bucket: String(row.bucket),
      sales_qty: Number(row.sales_qty ?? 0),
      complaint_count: 0,
    }))
    return this.trendCache.set(cacheKey, result)
  }
}

export class BigQueryOrderEnrichmentRepository implements OrderEnrichmentRepository {
  private readonly cache = new TtlCache<Record<string, {
    order_date?: string | null
    country?: string | null
    line_items: OrderLineContext[]
  }>>(600_000)

  constructor(private readonly client: BigQueryLike) {}

  async enrichIssues(issues: StandardIssueRecord[]) {
    const orderNos = [...new Set(issues.map((issue) => issue.order_no).filter(Boolean))].sort()
    if (!orderNos.length) {
      return { issues, notes: [] }
    }

    const contexts = await this.fetchOrderContexts(orderNos)
    const notes: string[] = []
    const enriched: StandardIssueRecord[] = []

    for (const issue of issues) {
      const context = contexts[issue.order_no]
      if (!context) {
        notes.push(`Missing order enrichment for ${issue.order_no}.`)
        continue
      }

      const matchedLine = this.matchLineItem(issue, context.line_items)
      enriched.push({
        ...issue,
        order_date: context.order_date ?? issue.order_date ?? null,
        country: context.country ?? issue.country ?? null,
        order_line_contexts: context.line_items,
        skc: matchedLine?.skc ?? null,
        spu: matchedLine?.spu ?? null,
      })
    }

    return { issues: enriched, notes }
  }

  private async fetchOrderContexts(orderNos: string[]) {
    const cacheKey = JSON.stringify(orderNos)
    const cached = this.cache.get(cacheKey)
    if (cached) {
      return cached
    }

    const rows = extractRows(await this.client.query({
      query: `
SELECT
  o.name AS order_no,
  CAST(DATE(o.processed_at) AS STRING) AS order_date,
  o.shipping_country AS country,
  li.sku AS sku,
  SUM(li.quantity) AS quantity,
  COALESCE(skc_map.skc, sku_dim.skc_id) AS skc,
  sku_dim.spu_id AS spu
FROM \`julang-dev-database.shopify_ods.ods_shopify_orders\` o
LEFT JOIN \`julang-dev-database.shopify_ods.ods_shopify_order_line_items\` li
  ON li.order_id = o.order_id AND li.shop_domain = o.shop_domain
LEFT JOIN \`julang-dev-database.shopify_intermediate.int_product_skc\` skc_map
  ON skc_map.variant_sku = li.sku
LEFT JOIN \`julang-dev-database.product_information_database.dim_product_sku\` sku_dim
  ON sku_dim.sku_id = li.sku
WHERE o.name IN UNNEST(@order_nos)
GROUP BY 1, 2, 3, 4, 6, 7
      `,
      params: {
        order_nos: orderNos,
      },
      types: {
        order_nos: ['STRING'],
      },
    }))

    const perOrder: Record<string, {
      order_date?: string | null
      country?: string | null
      line_items: OrderLineContext[]
    }> = {}

    for (const row of rows) {
      const orderNo = String(row.order_no)
      perOrder[orderNo] ??= {
        order_date: row.order_date ? String(row.order_date) : null,
        country: row.country ? String(row.country) : null,
        line_items: [],
      }

      if (row.sku) {
        perOrder[orderNo].line_items.push({
          sku: String(row.sku),
          quantity: Number(row.quantity ?? 0),
          skc: row.skc ? String(row.skc) : null,
          spu: row.spu ? String(row.spu) : null,
        })
      }
    }

    return this.cache.set(cacheKey, perOrder)
  }

  private matchLineItem(
    issue: StandardIssueRecord,
    lineItems: OrderLineContext[],
  ): OrderLineContext | undefined {
    if (issue.sku) {
      const matched = lineItems.find((lineItem) => lineItem.sku === issue.sku)
      if (matched) {
        return matched
      }
    }

    return lineItems[0]
  }
}
