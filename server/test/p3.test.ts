import assert from 'node:assert/strict'
import {
  buildDashboardPayload,
  buildDrilldownPreviewPayload,
  computeDashboard,
  filterIssues,
  resolveIssueQueryDate,
} from '../domain/p3/compute.js'
import type {
  DrilldownFilters,
  P3Filters,
  StandardIssueRecord,
  SummaryMetrics,
  TrendPoint,
} from '../domain/p3/models.js'

const baseFilters: P3Filters = {
  date_from: '2026-03-01',
  date_to: '2026-03-31',
  grain: 'week',
  date_basis: 'order_date',
}

const issues: StandardIssueRecord[] = [
  {
    source_system: 'openclaw_feishu',
    source_subtable: '1-3待跟进表-货品瑕疵',
    source_record_id: 'rec-product',
    major_issue_type: 'product',
    minor_issue_type: '货品瑕疵-其他',
    order_no: 'LC1',
    record_date: '2026-03-02',
    order_date: '2026-03-02',
    refund_date: '2026-03-11',
    sku: 'SKU-1',
    skc: 'SKC-1',
    spu: 'SPU-1',
    customer_email: 'a@example.com',
    country: 'US',
    solution: '退款跟进',
    is_order_level_only: false,
    order_line_contexts: [{ sku: 'SKU-1', quantity: 1, skc: 'SKC-1', spu: 'SPU-1' }],
  },
  {
    source_system: 'openclaw_feishu',
    source_subtable: '1-2待跟进表-漏发、发错',
    source_record_id: 'rec-warehouse',
    major_issue_type: 'warehouse',
    minor_issue_type: '仓库-发错SKU',
    order_no: 'LC2',
    record_date: '2026-03-05',
    order_date: '2026-03-09',
    refund_date: null,
    sku: 'SKU-2',
    skc: 'SKC-2',
    spu: 'SPU-2',
    customer_email: 'b@example.com',
    country: 'US',
    solution: '补发',
    is_order_level_only: false,
    order_line_contexts: [{ sku: 'SKU-2', quantity: 1, skc: 'SKC-2', spu: 'SPU-2' }],
  },
  {
    source_system: 'openclaw_feishu',
    source_subtable: '1-4待跟进表-物流问题',
    source_record_id: 'rec-logistics',
    major_issue_type: 'logistics',
    minor_issue_type: '物流问题-超期',
    order_no: 'LC3',
    record_date: '2026-03-08',
    order_date: '2026-03-09',
    refund_date: '2026-03-12',
    customer_email: 'c@example.com',
    country: 'CA',
    solution: '补发',
    status: '处理中',
    is_order_level_only: true,
    order_line_contexts: [
      { sku: 'SKU-3', quantity: 1, skc: 'SKC-3', spu: 'SPU-3' },
      { sku: 'SKU-4', quantity: 1, skc: 'SKC-4', spu: 'SPU-4' },
    ],
  },
]

const salesSummary: SummaryMetrics = { sales_qty: 120, complaint_count: 0 }
const salesTrends: TrendPoint[] = [
  { bucket: '2026-03-02', sales_qty: 70, complaint_count: 0 },
  { bucket: '2026-03-09', sales_qty: 50, complaint_count: 0 },
]

function run() {
  const filtered = filterIssues(issues, baseFilters)
  const result = computeDashboard(baseFilters, salesSummary, salesTrends, filtered, [], false)
  const payload = buildDashboardPayload(baseFilters, result)

  assert.deepEqual(payload.summary, {
    sales_qty: 120,
    complaint_count: 3,
    complaint_rate: 0.025,
  })
  assert.deepEqual(payload.issue_share, [
    { major_issue_type: 'product', label: '产品问题', count: 1, ratio: 0.333333 },
    { major_issue_type: 'warehouse', label: '仓库问题', count: 1, ratio: 0.333333 },
    { major_issue_type: 'logistics', label: '物流问题', count: 1, ratio: 0.333333 },
  ])
  assert.deepEqual(payload.trends.sales_qty, [
    { bucket: '2026-03-02', value: 70 },
    { bucket: '2026-03-09', value: 50 },
  ])
  assert.equal(payload.meta.version, 'p3-formal-runtime')
  assert.equal(payload.filters.date_basis, 'order_date')

  const logisticsFiltered = filterIssues(issues, { ...baseFilters, sku: 'SKU-4' })
  assert.equal(logisticsFiltered.length, 1)
  assert.equal(logisticsFiltered[0]?.major_issue_type, 'logistics')

  const refundFiltered = filterIssues(issues, {
    ...baseFilters,
    date_basis: 'refund_date',
    date_from: '2026-03-11',
    date_to: '2026-03-12',
  })
  assert.equal(refundFiltered.length, 2)
  assert.equal(refundFiltered.some((issue) => issue.order_no === 'LC2'), false)
  assert.equal(resolveIssueQueryDate(issues[0], { date_basis: 'refund_date' }), '2026-03-11')

  const fallbackOrderFiltered = filterIssues(
    [
      {
        ...issues[0],
        source_record_id: 'rec-fallback-order',
        order_no: 'LC4',
        order_date: null,
        record_date: '2026-03-20',
      },
    ],
    {
      ...baseFilters,
      date_from: '2026-03-20',
      date_to: '2026-03-20',
    },
  )
  assert.equal(fallbackOrderFiltered.length, 1)

  const previewFilters: DrilldownFilters = {
    ...baseFilters,
    major_issue_type: 'logistics',
  }
  const previewPayload = buildDrilldownPreviewPayload(previewFilters, filtered, [], false)
  assert.deepEqual(previewPayload.preview.top_reasons, [{ reason: '物流问题-超期', count: 1 }])
  assert.equal(previewPayload.preview.sample_orders[0]?.order_no, 'LC3')
  assert.deepEqual(previewPayload.preview.top_spus, [])
  assert.equal(previewPayload.filters.date_basis, 'order_date')

  console.log('P3 compute tests passed')
}

run()
