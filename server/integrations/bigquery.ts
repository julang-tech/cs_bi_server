import fs from 'node:fs'
import path from 'node:path'
import { TtlCache } from '../domain/p3/cache.js'
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

  async fetchProductSales(): Promise<ProductSalesPoint[]> {
    return []
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
        refund_date: issue.refund_date ?? null,
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

type OrderContextRow = {
  order_date?: string | null
  line_items: OrderLineContext[]
}

type RefundContextRow = {
  earliest_refund_date: string | null
  refund_date_by_sku: Map<string, string>
}

function extractRows(result: unknown): BigQueryRows {
  if (!Array.isArray(result)) {
    return []
  }

  const [rows] = result as [unknown, ...unknown[]]
  return Array.isArray(rows) ? (rows as BigQueryRows) : []
}

function normalizeText(value: unknown) {
  return String(value ?? '').trim()
}

function normalizeSku(value: unknown) {
  return normalizeText(value).toUpperCase()
}

export class BigQuerySalesRepository implements SalesRepository {
  private readonly summaryCache = new TtlCache<SummaryMetrics>(300_000)
  private readonly trendCache = new TtlCache<TrendPoint[]>(300_000)
  private readonly productSalesCache = new TtlCache<ProductSalesPoint[]>(300_000)

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
  COUNT(*) AS sales_qty
FROM \`julang-dev-database.shopify_dwd.dwd_orders_fact\` o
WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
  AND (@sku = '' OR @sku IN UNNEST(IFNULL(o.skus, [])))
  AND (
    @skc = ''
    OR @skc IN UNNEST(IFNULL(o.skcs, []))
    OR EXISTS (
      SELECT 1
      FROM UNNEST(IFNULL(o.skus, [])) AS sku
      LEFT JOIN \`julang-dev-database.product_information_database.dim_product_sku\` sku_dim
        ON sku_dim.sku_id = sku
      WHERE sku_dim.skc_id = @skc
    )
  )
  AND (
    @spu = ''
    OR EXISTS (
      SELECT 1
      FROM UNNEST(IFNULL(o.skus, [])) AS sku
      LEFT JOIN \`julang-dev-database.product_information_database.dim_product_sku\` sku_dim
        ON sku_dim.sku_id = sku
      WHERE sku_dim.spu_id = @spu
    )
  )
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
        ? 'o.processed_date'
        : filters.grain === 'week'
          ? 'DATE_TRUNC(o.processed_date, WEEK(MONDAY))'
          : 'DATE_TRUNC(o.processed_date, MONTH)'

    const rows = extractRows(await this.client.query({
      query: `
SELECT
  CAST(${bucketExpression} AS STRING) AS bucket,
  COUNT(*) AS sales_qty
FROM \`julang-dev-database.shopify_dwd.dwd_orders_fact\` o
WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
  AND (@sku = '' OR @sku IN UNNEST(IFNULL(o.skus, [])))
  AND (
    @skc = ''
    OR @skc IN UNNEST(IFNULL(o.skcs, []))
    OR EXISTS (
      SELECT 1
      FROM UNNEST(IFNULL(o.skus, [])) AS sku
      LEFT JOIN \`julang-dev-database.product_information_database.dim_product_sku\` sku_dim
        ON sku_dim.sku_id = sku
      WHERE sku_dim.skc_id = @skc
    )
  )
  AND (
    @spu = ''
    OR EXISTS (
      SELECT 1
      FROM UNNEST(IFNULL(o.skus, [])) AS sku
      LEFT JOIN \`julang-dev-database.product_information_database.dim_product_sku\` sku_dim
        ON sku_dim.sku_id = sku
      WHERE sku_dim.spu_id = @spu
    )
  )
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

  async fetchProductSales(filters: P3Filters): Promise<ProductSalesPoint[]> {
    const cacheKey = JSON.stringify(['product-sales', filters])
    const cached = this.productSalesCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const rows = extractRows(await this.client.query({
      query: `
WITH order_sku_rows AS (
  SELECT
    o.order_name,
    sku,
    COALESCE(sku_dim.skc_id, skc) AS skc,
    sku_dim.spu_id AS spu
  FROM \`julang-dev-database.shopify_dwd.dwd_orders_fact\` o
  LEFT JOIN UNNEST(IFNULL(o.skus, [])) AS sku WITH OFFSET sku_offset
  LEFT JOIN UNNEST(IFNULL(o.skcs, [])) AS skc WITH OFFSET skc_offset
    ON skc_offset = sku_offset
  LEFT JOIN \`julang-dev-database.product_information_database.dim_product_sku\` sku_dim
    ON sku_dim.sku_id = sku
  WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
    AND (@sku = '' OR sku = @sku)
    AND (@skc = '' OR COALESCE(sku_dim.skc_id, skc) = @skc)
    AND (@spu = '' OR sku_dim.spu_id = @spu)
)
SELECT
  spu,
  skc,
  COUNT(DISTINCT order_name) AS sales_qty
FROM order_sku_rows
WHERE spu IS NOT NULL
  AND skc IS NOT NULL
GROUP BY 1, 2
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
      spu: String(row.spu ?? ''),
      skc: String(row.skc ?? ''),
      sales_qty: Number(row.sales_qty ?? 0),
    }))
    return this.productSalesCache.set(cacheKey, result)
  }
}

export class BigQueryOrderEnrichmentRepository implements OrderEnrichmentRepository {
  private readonly orderCache = new TtlCache<Record<string, OrderContextRow>>(600_000)
  private readonly refundCache = new TtlCache<Record<string, RefundContextRow>>(600_000)

  constructor(private readonly client: BigQueryLike) {}

  async enrichIssues(issues: StandardIssueRecord[]) {
    const orderNos = [...new Set(issues.map((issue) => issue.order_no).filter(Boolean))].sort()
    if (!orderNos.length) {
      return { issues, notes: [] }
    }

    const [orderContexts, refundContexts] = await Promise.all([
      this.fetchOrderContexts(orderNos),
      this.fetchRefundContexts(orderNos),
    ])

    const notes: string[] = []
    const enriched: StandardIssueRecord[] = []

    for (const issue of issues) {
      const orderContext = orderContexts[issue.order_no]
      const refundContext = refundContexts[issue.order_no]

      if (!orderContext) {
        notes.push(
          `Missing order enrichment for ${issue.order_no}; fell back to record_date when available.`,
        )
        enriched.push({
          ...issue,
          order_date: issue.order_date ?? issue.record_date ?? null,
          refund_date: this.resolveRefundDate(issue, refundContext) ?? issue.refund_date ?? null,
        })
        continue
      }

      const matchedLine = this.matchLineItem(issue, orderContext.line_items)
      enriched.push({
        ...issue,
        order_date: orderContext.order_date ?? issue.order_date ?? issue.record_date ?? null,
        refund_date: this.resolveRefundDate(issue, refundContext) ?? issue.refund_date ?? null,
        country: issue.country ?? null,
        order_line_contexts: orderContext.line_items,
        skc: matchedLine?.skc ?? issue.skc ?? null,
        spu: matchedLine?.spu ?? issue.spu ?? null,
      })
    }

    return { issues: enriched, notes }
  }

  private async fetchOrderContexts(orderNos: string[]) {
    const cacheKey = JSON.stringify(orderNos)
    const cached = this.orderCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const rows = extractRows(await this.client.query({
      query: `
SELECT
  o.order_name AS order_no,
  CAST(o.processed_date AS STRING) AS order_date,
  sku AS sku,
  COALESCE(sku_dim.skc_id, skc) AS skc,
  sku_dim.spu_id AS spu
FROM \`julang-dev-database.shopify_dwd.dwd_orders_fact\` o
LEFT JOIN UNNEST(IFNULL(o.skus, [])) AS sku WITH OFFSET sku_offset
LEFT JOIN UNNEST(IFNULL(o.skcs, [])) AS skc WITH OFFSET skc_offset
  ON skc_offset = sku_offset
LEFT JOIN \`julang-dev-database.product_information_database.dim_product_sku\` sku_dim
  ON sku_dim.sku_id = sku
WHERE o.order_name IN UNNEST(@order_nos)
      `,
      params: {
        order_nos: orderNos,
      },
      types: {
        order_nos: ['STRING'],
      },
    }))

    const perOrder: Record<string, OrderContextRow> = {}
    for (const row of rows) {
      const orderNo = normalizeText(row.order_no)
      if (!orderNo) {
        continue
      }

      perOrder[orderNo] ??= {
        order_date: row.order_date ? String(row.order_date) : null,
        line_items: [],
      }

      const sku = normalizeText(row.sku)
      if (!sku) {
        continue
      }

      perOrder[orderNo].line_items.push({
        sku,
        quantity: 1,
        skc: row.skc ? String(row.skc) : null,
        spu: row.spu ? String(row.spu) : null,
      })
    }

    return this.orderCache.set(cacheKey, perOrder)
  }

  private async fetchRefundContexts(orderNos: string[]) {
    const cacheKey = JSON.stringify(orderNos)
    const cached = this.refundCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const rows = extractRows(await this.client.query({
      query: `
SELECT
  order_name AS order_no,
  sku,
  CAST(MIN(refund_date) AS STRING) AS refund_date
FROM \`julang-dev-database.shopify_dwd.dwd_refund_events\`
WHERE order_name IN UNNEST(@order_nos)
GROUP BY 1, 2
      `,
      params: {
        order_nos: orderNos,
      },
      types: {
        order_nos: ['STRING'],
      },
    }))

    const perOrder: Record<string, RefundContextRow> = {}
    for (const row of rows) {
      const orderNo = normalizeText(row.order_no)
      const refundDate = row.refund_date ? String(row.refund_date) : null
      if (!orderNo || !refundDate) {
        continue
      }

      perOrder[orderNo] ??= {
        earliest_refund_date: refundDate,
        refund_date_by_sku: new Map<string, string>(),
      }

      if (
        !perOrder[orderNo].earliest_refund_date ||
        refundDate < perOrder[orderNo].earliest_refund_date
      ) {
        perOrder[orderNo].earliest_refund_date = refundDate
      }

      const skuKey = normalizeSku(row.sku)
      if (!skuKey) {
        continue
      }

      const current = perOrder[orderNo].refund_date_by_sku.get(skuKey)
      if (!current || refundDate < current) {
        perOrder[orderNo].refund_date_by_sku.set(skuKey, refundDate)
      }
    }

    return this.refundCache.set(cacheKey, perOrder)
  }

  private resolveRefundDate(
    issue: StandardIssueRecord,
    refundContext: RefundContextRow | undefined,
  ) {
    if (!refundContext) {
      return null
    }

    if (issue.major_issue_type === 'logistics' || issue.is_order_level_only) {
      return refundContext.earliest_refund_date
    }

    const skuKey = normalizeSku(issue.sku)
    if (skuKey) {
      return refundContext.refund_date_by_sku.get(skuKey) ?? refundContext.earliest_refund_date
    }

    return refundContext.earliest_refund_date
  }

  private matchLineItem(issue: StandardIssueRecord, lineItems: OrderLineContext[]) {
    if (issue.sku) {
      const issueSku = normalizeSku(issue.sku)
      const matched = lineItems.find((lineItem) => normalizeSku(lineItem.sku) === issueSku)
      if (matched) {
        return matched
      }
    }

    return lineItems[0]
  }
}
