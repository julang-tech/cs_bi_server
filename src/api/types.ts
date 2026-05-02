export type Grain = 'day' | 'week' | 'month'

export interface PeriodWindow {
  date_from: string  // YYYY-MM-DD
  date_to: string
}

export interface TrendPoint {
  bucket: string
  value: number
}

export interface DashboardMeta {
  partial_data?: boolean
  notes?: string[]
}

// ----- P1 -----
export interface P1Filters extends PeriodWindow {
  grain: Grain
  agent_name?: string
}
export interface P1Summary {
  inbound_email_count: number
  outbound_email_count: number
  avg_queue_hours: number
  first_response_timeout_count: number
  first_email_count: number
  unreplied_email_count: number
}
export interface P1AgentRow {
  agent_name: string
  outbound_email_count: number
  reply_span_hours?: number | null
  avg_outbound_emails_per_hour_by_span: number
  avg_outbound_emails_per_hour_by_schedule: number
  qa_reply_counts: { excellent: number; pass: number; fail: number }
}
export interface P1AgentTrendRow {
  agent_name: string
  items: Array<{
    bucket: string
    avg_outbound_emails_per_hour_by_span: number
    avg_outbound_emails_per_hour_by_schedule: number
  }>
}
export interface P1Dashboard {
  filters: P1Filters
  summary: P1Summary
  trends: {
    inbound_email_count: TrendPoint[]
    outbound_email_count: TrendPoint[]
    first_response_timeout_count: TrendPoint[]
    avg_queue_hours?: TrendPoint[]
    first_email_count?: TrendPoint[]
    unreplied_email_count?: TrendPoint[]
  }
  agent_workload: P1AgentRow[]
  agent_workload_trends: P1AgentTrendRow[]
  meta: DashboardMeta
}

// ----- P2 -----
export interface P2Filters extends PeriodWindow {
  grain: Grain
  channel?: string
  category?: string
  spu?: string
  skc?: string
  spu_list?: string[]
  skc_list?: string[]
  listing_date_from?: string
  listing_date_to?: string
  top_n?: number
}
export interface P2OverviewCards {
  order_count: number
  sales_qty: number
  refund_order_count: number
  refund_amount: number
  gmv: number
  net_received_amount: number
  net_revenue_amount: number
  refund_amount_ratio: number
}
export interface P2Overview {
  cards: P2OverviewCards
  trends: {
    order_count: TrendPoint[]
    sales_qty: TrendPoint[]
    refund_order_count: TrendPoint[]
    refund_amount: TrendPoint[]
    gmv: TrendPoint[]
    net_received_amount: TrendPoint[]
    net_revenue_amount: TrendPoint[]
    refund_amount_ratio: TrendPoint[]
  }
  meta: DashboardMeta
}
export interface P2SpuRow {
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
  }>
}

// ----- P3 -----
export type MajorIssueType = 'product' | 'logistics' | 'warehouse' | 'refund' | 'other'
export interface P3Filters extends PeriodWindow {
  grain: Grain
  date_basis: 'order_date' | 'refund_date'
  spu?: string
  skc?: string
  sku?: string
}
export interface P3Summary {
  sales_qty: number
  complaint_count: number
  complaint_rate: number
}
export interface P3IssueShareItem {
  major_issue_type: MajorIssueType
  label: string
  count: number
  ratio: number
  target_page?: string | null
}
export interface P3Dashboard {
  filters: P3Filters
  summary: P3Summary
  trends: {
    sales_qty: TrendPoint[]
    complaint_count: TrendPoint[]
    complaint_rate: TrendPoint[]
    issue_product_count?: TrendPoint[]
    issue_logistics_count?: TrendPoint[]
    issue_warehouse_count?: TrendPoint[]
  }
  issue_share: P3IssueShareItem[]
  meta: DashboardMeta
}
export interface P3ProductRankingRow {
  spu: string
  sales_qty: number
  complaint_count: number
  complaint_rate: number
  children: Array<{
    skc: string
    sales_qty: number
    complaint_count: number
    complaint_rate: number
  }>
}
