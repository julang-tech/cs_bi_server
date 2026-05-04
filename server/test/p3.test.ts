import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildDashboardPayload,
  buildDrilldownPreviewPayload,
  buildProductRankingPayload,
  computeProductRanking,
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
import { SqliteShopifyBiCacheRepository } from '../integrations/shopify-bi-cache.js'

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

const salesSummary: SummaryMetrics = { sales_qty: 120, order_count: 90, complaint_count: 0 }
const salesTrends: TrendPoint[] = [
  { bucket: '2026-03-02', sales_qty: 70, order_count: 50, complaint_count: 0 },
  { bucket: '2026-03-09', sales_qty: 50, order_count: 40, complaint_count: 0 },
]

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bikanban-p3-'))
}

async function testSqliteShopifyBiCacheRepository() {
  const tmpDir = createTempDir()
  const sqlitePath = path.join(tmpDir, 'issues.sqlite')
  const repository = new SqliteShopifyBiCacheRepository(sqlitePath)
  repository.replaceWindow({
    dateFrom: '2026-03-01',
    dateTo: '2026-03-31',
    orders: [
      {
        order_id: 'gid://shopify/Order/1',
        order_no: 'LC1',
        shop_domain: 'shop.example',
        processed_date: '2026-03-02',
        primary_product_type: 'Apparel',
        first_published_at_in_order: '2026-02-01',
        is_regular_order: true,
        is_gift_card_order: false,
        gmv_usd: 10,
        revenue_usd: 10,
        net_revenue_usd: 10,
      },
      {
        order_id: 'gid://shopify/Order/2',
        order_no: 'LC2',
        shop_domain: 'shop.example',
        processed_date: '2026-03-03',
        primary_product_type: 'Apparel',
        first_published_at_in_order: '2026-02-01',
        is_regular_order: true,
        is_gift_card_order: false,
        gmv_usd: 20,
        revenue_usd: 20,
        net_revenue_usd: 20,
      },
      {
        order_id: 'gid://shopify/Order/3',
        order_no: 'LC3',
        shop_domain: 'shop.example',
        processed_date: '2026-03-09',
        primary_product_type: 'Apparel',
        first_published_at_in_order: '2026-02-01',
        is_regular_order: true,
        is_gift_card_order: false,
        gmv_usd: 30,
        revenue_usd: 30,
        net_revenue_usd: 30,
      },
    ],
    orderLines: [
      {
        order_id: 'gid://shopify/Order/1',
        order_no: 'LC1',
        line_key: 'LC1-1',
        sku: 'SKU-1',
        skc: 'SKC-1',
        spu: 'SPU-1',
        product_id: null,
        variant_id: null,
        quantity: 1,
        discounted_total_usd: 10,
        is_insurance_item: false,
        is_price_adjustment: false,
        is_shipping_cost: false,
      },
      {
        order_id: 'gid://shopify/Order/2',
        order_no: 'LC2',
        line_key: 'LC2-1',
        sku: 'SKU-2',
        skc: 'SKC-2',
        spu: 'SPU-2',
        product_id: null,
        variant_id: null,
        quantity: 2,
        discounted_total_usd: 20,
        is_insurance_item: false,
        is_price_adjustment: false,
        is_shipping_cost: false,
      },
      {
        order_id: 'gid://shopify/Order/3',
        order_no: 'LC3',
        line_key: 'LC3-1',
        sku: 'SKU-3',
        skc: 'SKC-3',
        spu: 'SPU-3',
        product_id: null,
        variant_id: null,
        quantity: 1,
        discounted_total_usd: 15,
        is_insurance_item: false,
        is_price_adjustment: false,
        is_shipping_cost: false,
      },
      {
        order_id: 'gid://shopify/Order/3',
        order_no: 'LC3',
        line_key: 'LC3-2',
        sku: 'SKU-4',
        skc: 'SKC-4',
        spu: 'SPU-4',
        product_id: null,
        variant_id: null,
        quantity: 1,
        discounted_total_usd: 15,
        is_insurance_item: false,
        is_price_adjustment: false,
        is_shipping_cost: false,
      },
    ],
    refundEvents: [
      {
        refund_id: 'refund-1',
        order_id: 'gid://shopify/Order/1',
        order_no: 'LC1',
        sku: 'SKU-1',
        refund_date: '2026-03-11',
        refund_quantity: 1,
        refund_subtotal_usd: 10,
      },
      {
        refund_id: 'refund-2',
        order_id: 'gid://shopify/Order/3',
        order_no: 'LC3',
        sku: 'SKU-4',
        refund_date: '2026-03-12',
        refund_quantity: 1,
        refund_subtotal_usd: 15,
      },
      {
        refund_id: 'refund-3',
        order_id: 'gid://shopify/Order/3',
        order_no: 'LC3',
        sku: 'SKU-3',
        refund_date: '2026-03-13',
        refund_quantity: 1,
        refund_subtotal_usd: 15,
      },
    ],
  })
  const cache = repository
  const summary = await cache.fetchSummary(baseFilters)
  assert.equal(summary.sales_qty, 4)

  const skuSummary = await cache.fetchSummary({ ...baseFilters, sku: 'SKU-4' })
  assert.equal(skuSummary.sales_qty, 1)

  const skcSummary = await cache.fetchSummary({ ...baseFilters, skc: 'SKC-1' })
  assert.equal(skcSummary.sales_qty, 1)

  const spuSummary = await cache.fetchSummary({ ...baseFilters, spu: 'SPU-3' })
  assert.equal(spuSummary.sales_qty, 1)

  const trends = await cache.fetchTrends(baseFilters)
  assert.deepEqual(trends, [
    { bucket: '2026-03-02', sales_qty: 2, order_count: 2, complaint_count: 0 },
    { bucket: '2026-03-09', sales_qty: 2, order_count: 1, complaint_count: 0 },
  ])

  const productSales = await cache.fetchProductSales(baseFilters)
  assert.deepEqual(
    productSales.sort((left, right) => left.skc.localeCompare(right.skc)),
    [
      { spu: 'SPU-1', skc: 'SKC-1', sales_qty: 1 },
      { spu: 'SPU-2', skc: 'SKC-2', sales_qty: 1 },
      { spu: 'SPU-3', skc: 'SKC-3', sales_qty: 1 },
      { spu: 'SPU-4', skc: 'SKC-4', sales_qty: 1 },
    ],
  )

  const enriched = await cache.enrichIssues([
    { ...issues[0], order_date: null, refund_date: null, skc: null, spu: null },
    { ...issues[2], order_date: null, refund_date: null },
  ])
  assert.equal(enriched.issues[0]?.order_date, '2026-03-02')
  assert.equal(enriched.issues[0]?.refund_date, '2026-03-11')
  assert.equal(enriched.issues[0]?.skc, 'SKC-1')
  assert.equal(enriched.issues[0]?.spu, 'SPU-1')
  assert.equal(enriched.issues[1]?.order_date, '2026-03-09')
  assert.equal(enriched.issues[1]?.refund_date, '2026-03-12')
  assert.equal(enriched.issues[1]?.order_line_contexts.length, 2)

  const refundDateFilters: P3Filters = {
    ...baseFilters,
    date_basis: 'refund_date',
  }
  const refundDateSummary = await cache.fetchSummary(refundDateFilters)
  assert.equal(refundDateSummary.sales_qty, 4)

  const refundDateTrends = await cache.fetchTrends(refundDateFilters)
  assert.deepEqual(refundDateTrends, [
    { bucket: '2026-03-02', sales_qty: 2, order_count: 2, complaint_count: 0 },
    { bucket: '2026-03-09', sales_qty: 2, order_count: 1, complaint_count: 0 },
  ])

  const refundDateProductSales = await cache.fetchProductSales(refundDateFilters)
  assert.deepEqual(
    refundDateProductSales.sort((left, right) => left.skc.localeCompare(right.skc)),
    [
      { spu: 'SPU-1', skc: 'SKC-1', sales_qty: 1 },
      { spu: 'SPU-2', skc: 'SKC-2', sales_qty: 1 },
      { spu: 'SPU-3', skc: 'SKC-3', sales_qty: 1 },
      { spu: 'SPU-4', skc: 'SKC-4', sales_qty: 1 },
    ],
  )

  const refundDateDashboard = computeDashboard(
    refundDateFilters,
    refundDateSummary,
    refundDateTrends,
    filterIssues(enriched.issues, refundDateFilters),
    [],
    false,
  )
  assert.equal(refundDateDashboard.summary.sales_qty, 4)

  cache.close()
}

async function run() {
  await testSqliteShopifyBiCacheRepository()
  const filtered = filterIssues(issues, baseFilters)
  const result = computeDashboard(baseFilters, salesSummary, salesTrends, filtered, [], false)
  const payload = buildDashboardPayload(baseFilters, result, undefined, '2026-05-04T06:00:00.000Z')

  assert.deepEqual(payload.summary, {
    sales_qty: 120,
    order_count: 90,
    complaint_count: 3,
    complaint_rate: 0.025,
  })
  assert.deepEqual(payload.issue_share, [
    { major_issue_type: 'product', label: '产品问题', count: 1, ratio: 0.333333 },
    { major_issue_type: 'warehouse', label: '仓库问题', count: 1, ratio: 0.333333 },
    { major_issue_type: 'logistics', label: '物流问题', count: 1, ratio: 0.333333 },
    { major_issue_type: 'refund', label: '退款/客户原因', count: 0, ratio: 0 },
    { major_issue_type: 'other', label: '其他', count: 0, ratio: 0 },
  ])
  assert.deepEqual(payload.trends.sales_qty, [
    { bucket: '2026-03-02', value: 70 },
    { bucket: '2026-03-09', value: 50 },
  ])
  assert.equal(payload.meta.version, 'p3-formal-runtime')
  assert.equal(payload.meta.data_as_of, '2026-05-04T06:00:00.000Z')
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

  const ranking = computeProductRanking(
    [
      { spu: 'SPU-1', skc: 'SKC-1', sales_qty: 10 },
      { spu: 'SPU-2', skc: 'SKC-2', sales_qty: 6 },
      { spu: 'SPU-3', skc: 'SKC-3', sales_qty: 4 },
      { spu: 'SPU-4', skc: 'SKC-4', sales_qty: 4 },
    ],
    filtered,
  )
  const rankingPayload = buildProductRankingPayload(baseFilters, ranking, [], false)
  assert.equal(rankingPayload.ranking.length, 4)
  assert.deepEqual(rankingPayload.ranking[0], {
    spu: 'SPU-3',
    sales_qty: 4,
    complaint_count: 1,
    complaint_rate: 0.25,
    children: [
      {
        skc: 'SKC-3',
        sales_qty: 4,
        complaint_count: 1,
        complaint_rate: 0.25,
      },
    ],
  })
  assert.equal(rankingPayload.ranking[1]?.spu, 'SPU-4')
  assert.equal(rankingPayload.ranking[2]?.children[0]?.complaint_count, 1)
  assert.equal(rankingPayload.ranking[3]?.children[0]?.skc, 'SKC-1')

  console.log('P3 compute tests passed')
}

await run()
