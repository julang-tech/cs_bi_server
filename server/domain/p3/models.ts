export const GRAINS = ['day', 'week', 'month'] as const
export type Grain = (typeof GRAINS)[number]

export const DATE_BASES = ['order_date', 'refund_date'] as const
export type DateBasis = (typeof DATE_BASES)[number]

export const MAJOR_ISSUE_TYPES = ['product', 'warehouse', 'logistics'] as const
export type MajorIssueType = (typeof MAJOR_ISSUE_TYPES)[number]

export const MAJOR_TYPE_LABELS: Record<MajorIssueType, string> = {
  product: '产品问题',
  warehouse: '仓库问题',
  logistics: '物流问题',
}

export const TARGET_PAGE_MAP: Record<MajorIssueType, string> = {
  product: 'p4',
  warehouse: 'p5',
  logistics: 'p6',
}

export type P3Filters = {
  date_from: string
  date_to: string
  grain: Grain
  date_basis: DateBasis
  sku?: string | null
  skc?: string | null
  spu?: string | null
}

export type DrilldownFilters = P3Filters & {
  major_issue_type: MajorIssueType
}

export type SummaryMetrics = {
  sales_qty: number
  complaint_count: number
}

export type TrendPoint = {
  bucket: string
  sales_qty: number
  complaint_count: number
}

export type ProductSalesPoint = {
  spu: string
  skc: string
  sales_qty: number
}

export type IssueSharePoint = {
  major_issue_type: MajorIssueType
  count: number
  ratio: number
}

export type OrderLineContext = {
  sku: string
  quantity: number
  skc?: string | null
  spu?: string | null
}

export type OrderContext = {
  order_no: string
  order_date?: string | null
  country?: string | null
  line_items: OrderLineContext[]
}

export type StandardIssueRecord = {
  source_system: string
  source_subtable: string
  source_record_id: string
  major_issue_type: MajorIssueType
  minor_issue_type: string
  order_no: string
  record_date?: string | null
  order_date?: string | null
  refund_date?: string | null
  sku?: string | null
  skc?: string | null
  spu?: string | null
  customer_email?: string | null
  country?: string | null
  solution?: string | null
  is_order_level_only: boolean
  order_line_contexts: OrderLineContext[]
  logistics_no?: string | null
  logistics_status?: string | null
  process_note?: string | null
  result_note?: string | null
  resolution_note?: string | null
  status?: string | null
}

export type SourceBundle = {
  issues: StandardIssueRecord[]
  notes: string[]
  partial_data: boolean
}

export type DashboardComputation = {
  summary: SummaryMetrics
  trends: TrendPoint[]
  issue_share: IssueSharePoint[]
  notes: string[]
  partial_data: boolean
}

export type ProductRankingChild = {
  skc: string
  sales_qty: number
  complaint_count: number
  complaint_rate: number
}

export type ProductRankingEntry = {
  spu: string
  sales_qty: number
  complaint_count: number
  complaint_rate: number
  children: ProductRankingChild[]
}

export type DashboardResponse = {
  filters: Record<string, unknown>
  summary: SummaryMetrics & {
    complaint_rate: number
  }
  trends: {
    sales_qty: Array<{ bucket: string; value: number }>
    complaint_count: Array<{ bucket: string; value: number }>
    complaint_rate: Array<{ bucket: string; value: number }>
  }
  issue_share: Array<{
    major_issue_type: MajorIssueType
    label: string
    count: number
    ratio: number
  }>
  meta: {
    version: string
    complaint_definition: string
    source_modes: string[]
    partial_data: boolean
    notes: string[]
    stable_fields?: string[]
    upgradable_fields?: string[]
  }
}

export type DrilldownOptionsResponse = {
  filters: Record<string, unknown>
  options: Array<{
    major_issue_type: MajorIssueType
    label: string
    count: number
    ratio: number
    target_page: string
  }>
  meta: {
    partial_data: boolean
    notes: string[]
  }
}

export type DrilldownPreviewResponse = {
  filters: Record<string, unknown>
  preview: {
    top_reasons: Array<{ reason: string; count: number }>
    top_spus: Array<{ spu: string; count: number }>
    top_skcs: Array<{ skc: string; count: number }>
    sample_orders: Array<Record<string, unknown>>
  }
  meta: {
    partial_data: boolean
    notes: string[]
  }
}

export type ProductRankingResponse = {
  filters: Record<string, unknown>
  ranking: ProductRankingEntry[]
  meta: {
    partial_data: boolean
    notes: string[]
  }
}

export interface SalesRepository {
  fetchSummary(filters: P3Filters): Promise<SummaryMetrics>
  fetchTrends(filters: P3Filters): Promise<TrendPoint[]>
  fetchProductSales(filters: P3Filters): Promise<ProductSalesPoint[]>
}

export interface OrderEnrichmentRepository {
  enrichIssues(
    issues: StandardIssueRecord[],
  ): Promise<{ issues: StandardIssueRecord[]; notes: string[] }>
}

export interface IssueProvider {
  getSourceBundle(): Promise<SourceBundle>
}
