import {
  type DateBasis,
  MAJOR_ISSUE_TYPES,
  MAJOR_TYPE_LABELS,
  TARGET_PAGE_MAP,
  type DashboardComputation,
  type DrilldownFilters,
  type DrilldownOptionsResponse,
  type DrilldownPreviewResponse,
  type Grain,
  type IssueSharePoint,
  type P3Filters,
  type ProductRankingEntry,
  type ProductRankingResponse,
  type ProductSalesPoint,
  type StandardIssueRecord,
  type SummaryMetrics,
  type TrendPoint,
} from './models.js'

export function safeRate(numerator: number, denominator: number) {
  if (denominator <= 0) {
    return 0
  }
  return Number((numerator / denominator).toFixed(6))
}

function parseIsoDateParts(rawDate: string) {
  const [yearText, monthText, dayText] = rawDate.split('-')
  return {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
  }
}

function formatIsoDate(year: number, month: number, day: number) {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`
}

export function bucketDate(grain: Grain, rawDate: string) {
  if (grain === 'day') {
    return rawDate
  }

  const { year, month, day } = parseIsoDateParts(rawDate)
  const date = new Date(Date.UTC(year, month - 1, day))

  if (grain === 'week') {
    const weekday = (date.getUTCDay() + 6) % 7
    date.setUTCDate(date.getUTCDate() - weekday)
    return date.toISOString().slice(0, 10)
  }

  return formatIsoDate(year, month, 1)
}

export function getDedupeKey(issue: StandardIssueRecord) {
  if (issue.major_issue_type === 'logistics' || issue.is_order_level_only) {
    return `${issue.source_record_id}|order:${issue.order_no}`
  }
  return `${issue.source_record_id}|sku:${issue.sku ?? ''}`
}

export function matchesDimensionFilters(issue: StandardIssueRecord, filters: P3Filters) {
  if (!filters.sku && !filters.skc && !filters.spu) {
    return true
  }

  if (issue.major_issue_type !== 'logistics') {
    if (filters.sku && issue.sku !== filters.sku) {
      return false
    }
    if (filters.skc && issue.skc !== filters.skc) {
      return false
    }
    if (filters.spu && issue.spu !== filters.spu) {
      return false
    }
    return true
  }

  if (
    filters.sku &&
    !issue.order_line_contexts.some((lineItem) => lineItem.sku === filters.sku)
  ) {
    return false
  }
  if (
    filters.skc &&
    !issue.order_line_contexts.some((lineItem) => lineItem.skc === filters.skc)
  ) {
    return false
  }
  if (
    filters.spu &&
    !issue.order_line_contexts.some((lineItem) => lineItem.spu === filters.spu)
  ) {
    return false
  }
  return true
}

export function resolveIssueQueryDate(
  issue: StandardIssueRecord,
  filters: Pick<P3Filters, 'date_basis'>,
) {
  return resolveIssueDateByBasis(issue, filters.date_basis)
}

function resolveIssueDateByBasis(issue: StandardIssueRecord, dateBasis: DateBasis) {
  if (dateBasis === 'record_date') {
    return issue.record_date ?? null
  }
  if (dateBasis === 'refund_date') {
    return issue.refund_date ?? null
  }

  return issue.order_date ?? issue.record_date ?? null
}

// Non-product line items (insurance/shipping/price-adjustment) — already filtered
// out at sync time via lookupOrderSkus, but kept here as a safety net so any future
// leak doesn't pollute complaint counts or product ranking.
const EXCLUDED_SKUS = new Set(['Insure01', 'Insure02', 'SHIPPINGCOST', 'PRICE ADJUSTMENT'])

export function filterIssues(issues: StandardIssueRecord[], filters: P3Filters) {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    if (issue.sku && EXCLUDED_SKUS.has(issue.sku)) {
      return false
    }
    const queryDate = resolveIssueQueryDate(issue, filters)
    if (!queryDate) {
      return false
    }
    if (queryDate < filters.date_from || queryDate > filters.date_to) {
      return false
    }
    if (!matchesDimensionFilters(issue, filters)) {
      return false
    }
    const dedupeKey = getDedupeKey(issue)
    if (seen.has(dedupeKey)) {
      return false
    }
    seen.add(dedupeKey)
    return true
  })
}

export function computeDashboard(
  filters: P3Filters,
  salesSummary: SummaryMetrics,
  salesTrends: TrendPoint[],
  issues: StandardIssueRecord[],
  notes: string[],
  partialData: boolean,
): DashboardComputation {
  const complaintCount = issues.length
  const summary: SummaryMetrics = {
    sales_qty: salesSummary.sales_qty,
    order_count: salesSummary.order_count,
    complaint_count: complaintCount,
  }

  const complaintByBucket = new Map<string, number>()
  for (const issue of issues) {
    const queryDate = resolveIssueQueryDate(issue, filters)
    if (!queryDate) continue
    const bucket = bucketDate(filters.grain, queryDate)
    complaintByBucket.set(bucket, (complaintByBucket.get(bucket) ?? 0) + 1)
  }

  const salesByBucket = new Map(
    salesTrends.map((point) => [point.bucket, { sales_qty: point.sales_qty, order_count: point.order_count }]),
  )
  const buckets = [...new Set([...salesByBucket.keys(), ...complaintByBucket.keys()])].sort()

  const trends: TrendPoint[] = buckets.map((bucket) => {
    const sales = salesByBucket.get(bucket) ?? { sales_qty: 0, order_count: 0 }
    return {
      bucket,
      sales_qty: sales.sales_qty,
      order_count: sales.order_count,
      complaint_count: complaintByBucket.get(bucket) ?? 0,
    }
  })

  const countByType = new Map(MAJOR_ISSUE_TYPES.map((type) => [type, 0]))
  for (const issue of issues) {
    countByType.set(issue.major_issue_type, (countByType.get(issue.major_issue_type) ?? 0) + 1)
  }
  const totalIssues = [...countByType.values()].reduce((sum, value) => sum + value, 0)
  const issue_share: IssueSharePoint[] = MAJOR_ISSUE_TYPES.map((major_issue_type) => ({
    major_issue_type,
    count: countByType.get(major_issue_type) ?? 0,
    ratio: safeRate(countByType.get(major_issue_type) ?? 0, totalIssues),
  }))

  return {
    summary,
    trends,
    issue_share,
    notes,
    partial_data: partialData,
  }
}

export function buildDashboardPayload(
  filters: P3Filters,
  result: DashboardComputation,
  sourceModes: string[] = ['feishu/openclaw runtime fetch', 'shopify bigquery enrichment'],
) {
  return {
    filters: {
      date_from: filters.date_from,
      date_to: filters.date_to,
      grain: filters.grain,
      date_basis: filters.date_basis,
      sku: filters.sku ?? null,
      skc: filters.skc ?? null,
      spu: filters.spu ?? null,
    },
    summary: {
      sales_qty: result.summary.sales_qty,
      order_count: result.summary.order_count,
      complaint_count: result.summary.complaint_count,
      complaint_rate: safeRate(result.summary.complaint_count, result.summary.sales_qty),
    },
    trends: {
      sales_qty: result.trends.map((point) => ({ bucket: point.bucket, value: point.sales_qty })),
      order_count: result.trends.map((point) => ({ bucket: point.bucket, value: point.order_count })),
      complaint_count: result.trends.map((point) => ({
        bucket: point.bucket,
        value: point.complaint_count,
      })),
      complaint_rate: result.trends.map((point) => ({
        bucket: point.bucket,
        value: safeRate(point.complaint_count, point.sales_qty),
      })),
    },
    issue_share: result.issue_share.map((point) => ({
      major_issue_type: point.major_issue_type,
      label: MAJOR_TYPE_LABELS[point.major_issue_type],
      count: point.count,
      ratio: point.ratio,
    })),
    meta: {
      version: 'p3-formal-runtime',
      complaint_definition: 'standardized_issue_records',
      source_modes: sourceModes,
      partial_data: result.partial_data,
      notes: result.notes,
      stable_fields: ['filters', 'summary', 'trends', 'issue_share', 'meta'],
      upgradable_fields: ['meta.notes'],
    },
  }
}

export function buildDrilldownOptionsPayload(
  filters: P3Filters,
  result: DashboardComputation,
  sourceModes: string[] = ['feishu/openclaw runtime fetch', 'shopify bigquery enrichment'],
): DrilldownOptionsResponse {
  return {
    filters: {
      date_from: filters.date_from,
      date_to: filters.date_to,
      grain: filters.grain,
      date_basis: filters.date_basis,
      sku: filters.sku ?? null,
      skc: filters.skc ?? null,
      spu: filters.spu ?? null,
    },
    options: result.issue_share.map((point) => ({
      major_issue_type: point.major_issue_type,
      label: MAJOR_TYPE_LABELS[point.major_issue_type],
      count: point.count,
      ratio: point.ratio,
      target_page: TARGET_PAGE_MAP[point.major_issue_type],
    })),
    meta: {
      partial_data: result.partial_data,
      notes: [...sourceModes.map((mode) => `source_mode:${mode}`), ...result.notes],
    },
  }
}

export function buildDrilldownPreviewPayload(
  filters: DrilldownFilters,
  issues: StandardIssueRecord[],
  notes: string[],
  partialData: boolean,
): DrilldownPreviewResponse {
  const scopedIssues = issues.filter(
    (issue) => issue.major_issue_type === filters.major_issue_type,
  )
  const reasonCounts = new Map<string, number>()
  for (const issue of scopedIssues) {
    reasonCounts.set(issue.minor_issue_type, (reasonCounts.get(issue.minor_issue_type) ?? 0) + 1)
  }

  const top_reasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }))

  let top_spus: Array<{ spu: string; count: number }> = []
  let top_skcs: Array<{ skc: string; count: number }> = []
  let sample_orders: Array<Record<string, unknown>> = []

  if (filters.major_issue_type === 'logistics') {
    const seenOrders = new Set<string>()
    sample_orders = scopedIssues
      .filter((issue) => {
        if (seenOrders.has(issue.order_no)) {
          return false
        }
        seenOrders.add(issue.order_no)
        return true
      })
      .slice(0, 10)
      .map((issue) => ({
        order_no: issue.order_no,
        customer_email: issue.customer_email ?? null,
        country: issue.country ?? null,
        reason: issue.minor_issue_type,
        solution: issue.solution ?? null,
        status: issue.status ?? null,
      }))
  } else {
    const spuCounts = new Map<string, number>()
    const skcCounts = new Map<string, number>()
    for (const issue of scopedIssues) {
      if (issue.spu) {
        spuCounts.set(issue.spu, (spuCounts.get(issue.spu) ?? 0) + 1)
      }
      if (issue.skc) {
        skcCounts.set(issue.skc, (skcCounts.get(issue.skc) ?? 0) + 1)
      }
    }

    top_spus = [...spuCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([spu, count]) => ({ spu, count }))
    top_skcs = [...skcCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([skc, count]) => ({ skc, count }))
  }

  return {
    filters: {
      date_from: filters.date_from,
      date_to: filters.date_to,
      grain: filters.grain,
      date_basis: filters.date_basis,
      sku: filters.sku ?? null,
      skc: filters.skc ?? null,
      spu: filters.spu ?? null,
      major_issue_type: filters.major_issue_type,
    },
    preview: {
      top_reasons,
      top_spus,
      top_skcs,
      sample_orders,
    },
    meta: {
      partial_data: partialData,
      notes,
    },
  }
}

function sortRankingRows<T extends { complaint_count: number; complaint_rate: number }>(
  leftKey: string,
  rightKey: string,
  left: T,
  right: T,
) {
  return (
    right.complaint_count - left.complaint_count ||
    right.complaint_rate - left.complaint_rate ||
    leftKey.localeCompare(rightKey)
  )
}

export function computeProductRanking(
  salesRows: ProductSalesPoint[],
  issues: StandardIssueRecord[],
): ProductRankingEntry[] {
  const spuSales = new Map<string, number>()
  const skcSales = new Map<string, number>()

  for (const row of salesRows) {
    if (!row.spu || !row.skc) {
      continue
    }
    spuSales.set(row.spu, (spuSales.get(row.spu) ?? 0) + row.sales_qty)
    skcSales.set(`${row.spu}__${row.skc}`, (skcSales.get(`${row.spu}__${row.skc}`) ?? 0) + row.sales_qty)
  }

  const spuComplaints = new Map<string, number>()
  const skcComplaints = new Map<string, number>()

  for (const issue of issues) {
    if (issue.major_issue_type === 'logistics') {
      const seenPairs = new Set<string>()
      for (const lineItem of issue.order_line_contexts) {
        if (!lineItem.spu || !lineItem.skc) {
          continue
        }
        if (EXCLUDED_SKUS.has(lineItem.sku) || EXCLUDED_SKUS.has(lineItem.spu)) {
          continue
        }
        const pairKey = `${lineItem.spu}__${lineItem.skc}`
        if (seenPairs.has(pairKey)) {
          continue
        }
        seenPairs.add(pairKey)
        spuComplaints.set(lineItem.spu, (spuComplaints.get(lineItem.spu) ?? 0) + 1)
        skcComplaints.set(pairKey, (skcComplaints.get(pairKey) ?? 0) + 1)
      }
      continue
    }

    if (!issue.spu || !issue.skc) {
      continue
    }
    if (EXCLUDED_SKUS.has(issue.spu) || (issue.sku && EXCLUDED_SKUS.has(issue.sku))) {
      continue
    }

    spuComplaints.set(issue.spu, (spuComplaints.get(issue.spu) ?? 0) + 1)
    skcComplaints.set(`${issue.spu}__${issue.skc}`, (skcComplaints.get(`${issue.spu}__${issue.skc}`) ?? 0) + 1)
  }

  const spus = new Set<string>([...spuSales.keys(), ...spuComplaints.keys()])
  const ranking: ProductRankingEntry[] = [...spus]
    .map((spu) => {
      const childPairs = new Set<string>()
      for (const key of skcSales.keys()) {
        if (key.startsWith(`${spu}__`)) {
          childPairs.add(key)
        }
      }
      for (const key of skcComplaints.keys()) {
        if (key.startsWith(`${spu}__`)) {
          childPairs.add(key)
        }
      }

      const children = [...childPairs]
        .map((pairKey) => {
          const skc = pairKey.slice(spu.length + 2)
          const sales_qty = skcSales.get(pairKey) ?? 0
          const complaint_count = skcComplaints.get(pairKey) ?? 0
          return {
            skc,
            sales_qty,
            complaint_count,
            complaint_rate: safeRate(complaint_count, sales_qty),
          }
        })
        .sort((left, right) => sortRankingRows(left.skc, right.skc, left, right))

      const sales_qty = spuSales.get(spu) ?? children.reduce((sum, child) => sum + child.sales_qty, 0)
      const complaint_count =
        spuComplaints.get(spu) ?? children.reduce((sum, child) => sum + child.complaint_count, 0)

      return {
        spu,
        sales_qty,
        complaint_count,
        complaint_rate: safeRate(complaint_count, sales_qty),
        children,
      }
    })
    .sort((left, right) => sortRankingRows(left.spu, right.spu, left, right))

  return ranking
}

export function buildProductRankingPayload(
  filters: P3Filters,
  ranking: ProductRankingEntry[],
  notes: string[],
  partialData: boolean,
): ProductRankingResponse {
  return {
    filters: {
      date_from: filters.date_from,
      date_to: filters.date_to,
      grain: filters.grain,
      date_basis: filters.date_basis,
      sku: filters.sku ?? null,
      skc: filters.skc ?? null,
      spu: filters.spu ?? null,
    },
    ranking,
    meta: {
      partial_data: partialData,
      notes,
    },
  }
}
