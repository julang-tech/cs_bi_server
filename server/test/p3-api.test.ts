import assert from 'node:assert/strict'
import { buildApp } from '../entrypoints/app.js'
import { P3Service } from '../domain/p3/service.js'
import type {
  IssueProvider,
  OrderEnrichmentRepository,
  P3Filters,
  ProductRefundPoint,
  ProductSalesPoint,
  SalesRepository,
  StandardIssueRecord,
  SummaryMetrics,
  TrendPoint,
} from '../domain/p3/models.js'

class StubSalesRepository implements SalesRepository {
  async fetchSummary(_filters: P3Filters): Promise<SummaryMetrics> {
    return { sales_qty: 120, order_count: 90, complaint_count: 0 }
  }

  async fetchTrends(_filters: P3Filters): Promise<TrendPoint[]> {
    return [
      { bucket: '2026-03-02', sales_qty: 70, order_count: 50, complaint_count: 0 },
      { bucket: '2026-03-09', sales_qty: 50, order_count: 40, complaint_count: 0 },
    ]
  }

  async fetchProductSales(_filters: P3Filters): Promise<ProductSalesPoint[]> {
    return [
      { spu: 'SPU-1', skc: 'SKC-1', sales_qty: 10 },
      { spu: 'SPU-2', skc: 'SKC-2', sales_qty: 8 },
      { spu: 'SPU-3', skc: 'SKC-3', sales_qty: 5 },
      { spu: 'SPU-4', skc: 'SKC-4', sales_qty: 4 },
    ]
  }

  async fetchProductRefunds(_filters: P3Filters): Promise<ProductRefundPoint[]> {
    return [
      { spu: 'SPU-1', skc: 'SKC-1', refund_qty: 1, refund_amount: 10 },
      { spu: 'SPU-2', skc: 'SKC-2', refund_qty: 0, refund_amount: 0 },
      { spu: 'SPU-3', skc: 'SKC-3', refund_qty: 1, refund_amount: 8 },
      { spu: 'SPU-4', skc: 'SKC-4', refund_qty: 1, refund_amount: 12 },
    ]
  }

  getDataAsOf(_dateFrom: string, _dateTo: string) {
    return '2026-05-04T06:00:00.000Z'
  }
}

class StubIssueProvider implements IssueProvider {
  async getSourceBundle() {
    const issues: StandardIssueRecord[] = [
      {
        source_system: 'openclaw_feishu',
        source_subtable: '1-3待跟进表-货品瑕疵',
        source_record_id: 'rec-product',
        major_issue_type: 'product',
        minor_issue_type: '货品瑕疵-其他',
        order_no: 'LC1',
        record_date: '2026-03-02',
        order_date: null,
        refund_date: '2026-03-11',
        sku: 'SKU-1',
        skc: null,
        spu: null,
        customer_email: 'a@example.com',
        country: null,
        solution: '退款跟进',
        is_order_level_only: false,
        order_line_contexts: [],
      },
      {
        source_system: 'openclaw_feishu',
        source_subtable: '1-2待跟进表-漏发、发错',
        source_record_id: 'rec-warehouse',
        major_issue_type: 'warehouse',
        minor_issue_type: '仓库-发错SKU',
        order_no: 'LC2',
        record_date: '2026-03-05',
        order_date: null,
        refund_date: null,
        sku: 'SKU-2',
        skc: null,
        spu: null,
        customer_email: 'b@example.com',
        country: null,
        solution: '补发',
        is_order_level_only: false,
        order_line_contexts: [],
      },
      {
        source_system: 'openclaw_feishu',
        source_subtable: '1-4待跟进表-物流问题',
        source_record_id: 'rec-logistics',
        major_issue_type: 'logistics',
        minor_issue_type: '物流问题-超期',
        order_no: 'LC3',
        record_date: '2026-03-08',
        order_date: null,
        refund_date: '2026-03-12',
        customer_email: 'c@example.com',
        country: null,
        solution: '补发',
        is_order_level_only: true,
        order_line_contexts: [],
      },
    ]

    return { issues, notes: [], partial_data: false }
  }
}

class StubEnrichmentRepository implements OrderEnrichmentRepository {
  async enrichIssues(issues: StandardIssueRecord[]) {
    const orderMap: Record<string, { order_date: string; country: string; lines: StandardIssueRecord['order_line_contexts'] }> = {
      LC1: {
        order_date: '2026-03-02',
        country: 'US',
        lines: [{ sku: 'SKU-1', quantity: 1, skc: 'SKC-1', spu: 'SPU-1' }],
      },
      LC2: {
        order_date: '2026-03-09',
        country: 'US',
        lines: [{ sku: 'SKU-2', quantity: 1, skc: 'SKC-2', spu: 'SPU-2' }],
      },
      LC3: {
        order_date: '2026-03-09',
        country: 'CA',
        lines: [
          { sku: 'SKU-3', quantity: 1, skc: 'SKC-3', spu: 'SPU-3' },
          { sku: 'SKU-4', quantity: 1, skc: 'SKC-4', spu: 'SPU-4' },
        ],
      },
    }

    return {
      issues: issues.map((issue) => {
        const context = orderMap[issue.order_no]
        const line = context.lines[0]
        return {
          ...issue,
          order_date: context.order_date,
          refund_date: issue.refund_date ?? null,
          country: context.country,
          order_line_contexts: context.lines,
          skc: issue.sku ? line?.skc ?? null : null,
          spu: issue.sku ? line?.spu ?? null : null,
        }
      }),
      notes: [],
    }
  }
}

async function run() {
  const service = new P3Service(
    new StubSalesRepository(),
    new StubIssueProvider(),
    new StubEnrichmentRepository(),
  )

  const { app } = await buildApp({ service })

  const dashboardResponse = await app.inject({
    method: 'GET',
    url: '/api/bi/p3/dashboard?date_from=2026-03-01&date_to=2026-03-31&grain=week&date_basis=order_date',
  })
  const dashboardPayload = dashboardResponse.json()
  assert.equal(dashboardResponse.statusCode, 200)
  assert.deepEqual(Object.keys(dashboardPayload), ['filters', 'summary', 'trends', 'issue_share', 'meta'])
  assert.equal(dashboardPayload.filters.grain, 'week')
  assert.equal(dashboardPayload.filters.date_basis, 'order_date')
  assert.deepEqual(dashboardPayload.trends.sales_qty[0], { bucket: '2026-03-02', value: 70 })
  assert.equal(dashboardPayload.meta.version, 'p3-formal-runtime')
  assert.equal(dashboardPayload.meta.data_as_of, '2026-05-04T06:00:00.000Z')
  assert.equal(dashboardPayload.issue_share.length, 5)

  const optionsResponse = await app.inject({
    method: 'GET',
    url: '/api/bi/p3/drilldown-options?date_from=2026-03-01&date_to=2026-03-31&date_basis=order_date',
  })
  const optionsPayload = optionsResponse.json()
  assert.equal(optionsResponse.statusCode, 200)
  assert.equal(optionsPayload.filters.date_basis, 'order_date')
  assert.equal(optionsPayload.options[0].target_page, 'p4')
  assert.equal(optionsPayload.options[2].major_issue_type, 'logistics')

  const previewResponse = await app.inject({
    method: 'GET',
    url: '/api/bi/p3/drilldown-preview?date_from=2026-03-01&date_to=2026-03-31&major_issue_type=product',
  })
  const previewPayload = previewResponse.json()
  assert.equal(previewResponse.statusCode, 200)
  assert.equal(previewPayload.filters.date_basis, 'record_date')
  assert.equal(previewPayload.preview.top_reasons[0].reason, '货品瑕疵-其他')
  assert.equal(previewPayload.preview.top_spus[0].spu, 'SPU-1')

  const rankingResponse = await app.inject({
    method: 'GET',
    url: '/api/bi/p3/product-ranking?date_from=2026-03-01&date_to=2026-03-31&grain=week&date_basis=order_date',
  })
  const rankingPayload = rankingResponse.json()
  assert.equal(rankingResponse.statusCode, 200)
  assert.deepEqual(Object.keys(rankingPayload), ['filters', 'ranking', 'meta'])
  assert.equal(rankingPayload.ranking[0].spu, 'SPU-4')
  assert.equal(rankingPayload.ranking[1].children[0].skc, 'SKC-3')

  const invalidRankingResponse = await app.inject({
    method: 'GET',
    url: '/api/bi/p3/product-ranking?date_from=2026-03-31&date_to=2026-03-01',
  })
  assert.equal(invalidRankingResponse.statusCode, 422)

  const invalidResponse = await app.inject({
    method: 'GET',
    url: '/api/bi/p3/dashboard?date_from=2026-03-31&date_to=2026-03-01',
  })
  assert.equal(invalidResponse.statusCode, 422)
  assert.equal(invalidResponse.json().detail, 'date_from cannot be later than date_to.')

  await app.close()
  console.log('P3 API tests passed')
}

await run()
