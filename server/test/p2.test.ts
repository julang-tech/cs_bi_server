import assert from 'node:assert/strict'
import { P2Service, type P2Filters } from '../domain/p2/service.js'

type QueryCall = {
  query: string
  params?: Record<string, unknown>
}

function createFilters(): P2Filters {
  return {
    date_from: '2026-03-31',
    date_to: '2026-04-29',
    grain: 'month',
  }
}

function createClient(rowsByCall: Array<Array<Record<string, unknown>>>) {
  const calls: QueryCall[] = []

  return {
    calls,
    client: {
      async query(options: unknown) {
        const call = options as QueryCall
        calls.push(call)
        return [rowsByCall[calls.length - 1] ?? []]
      },
    },
  }
}

async function testOverviewUsesAdr0007FinanceMetrics() {
  const { client, calls } = createClient([
    [{
      order_count: 2,
      regular_order_count: 1,
      non_regular_order_count: 1,
      gmv: 100,
      net_received_amount: 90,
      net_revenue_amount: 80,
      regular_received_amount: 70,
      non_regular_received_amount: 20,
      refund_order_count: 1,
      refund_amount: 10,
    }],
    [{ sales_qty: 3 }],
  ])
  const service = new P2Service(client)

  const payload = await service.getOverview(createFilters())

  const overviewSql = calls[0]?.query ?? ''
  assert.match(overviewSql, /WITH order_metrics AS/)
  assert.match(overviewSql, /refund_metrics AS/)
  assert.match(overviewSql, /CROSS JOIN refund_metrics/)
  assert.match(overviewSql, /dwd_orders_fact_usd/)
  assert.match(overviewSql, /o\.cs_bi_gmv_usd/)
  assert.match(overviewSql, /o\.cs_bi_revenue_usd/)
  assert.match(overviewSql, /o\.cs_bi_net_revenue_usd/)
  assert.match(overviewSql, /COALESCE\(o\.is_regular_order, FALSE\) = TRUE/)
  assert.match(overviewSql, /re\.refund_date BETWEEN DATE\(@date_from\) AND DATE\(@date_to\)/)
  assert.match(overviewSql, /CAST\(re\.refund_subtotal AS NUMERIC\) \* COALESCE\(CAST\(o\.usd_fx_rate AS NUMERIC\), 1\)/)
  assert.doesNotMatch(overviewSql, /\bo\.gmv\b/)
  assert.doesNotMatch(overviewSql, /revenue_after_all_discounts/)

  assert.equal(payload.cards.gmv, 100)
  assert.equal(payload.cards.net_received_amount, 90)
  assert.equal(payload.cards.net_revenue_amount, 80)
  assert.equal(payload.cards.refund_amount_ratio, 10 / 90)
  assert.match(payload.meta.notes[0] ?? '', /ADR-0007/)
  assert.match(payload.meta.notes[0] ?? '', /refund-flow/)
}

async function testOverviewUsesSqliteCacheWhenCovered() {
  const sqliteCalls: P2Filters[] = []
  const bigQuery = createClient([[{ order_count: 999 }]])
  const service = new P2Service(bigQuery.client, {
    hasCoverage: () => true,
    getGeneration: () => 'generation-1',
    queryP2Overview: (filters: P2Filters) => {
      sqliteCalls.push(filters)
      return {
        cards: {
          order_count: 1,
          sales_qty: 2,
          refund_order_count: 1,
          refund_amount: 50,
          gmv: 120,
          net_received_amount: 100,
          net_revenue_amount: 90,
          refund_amount_ratio: 0.5,
          avg_order_amount: 100,
        },
      }
    },
  })

  const payload = await service.getOverview(createFilters())

  assert.deepEqual(sqliteCalls.map((filters) => filters.date_from), ['2026-03-31'])
  assert.equal(bigQuery.calls.length, 0)
  assert.deepEqual(payload.cards, {
    order_count: 1,
    sales_qty: 2,
    refund_order_count: 1,
    refund_amount: 50,
    gmv: 120,
    net_received_amount: 100,
    net_revenue_amount: 90,
    refund_amount_ratio: 0.5,
    avg_order_amount: 100,
  })
  assert.equal(payload.meta.source_mode, 'sqlite_shopify_bi_cache')
  assert.equal(payload.meta.cache_generation, 'generation-1')
}

async function testOverviewFallsBackToBigQueryWhenCacheCoverageMissing() {
  const coverageChecks: Array<{ dateFrom: string; dateTo: string }> = []
  const { client, calls } = createClient([
    [{
      order_count: 2,
      regular_order_count: 2,
      non_regular_order_count: 0,
      gmv: 120,
      net_received_amount: 100,
      net_revenue_amount: 90,
      regular_received_amount: 100,
      non_regular_received_amount: 0,
      refund_order_count: 1,
      refund_amount: 20,
    }],
    [{ sales_qty: 4 }],
  ])
  const service = new P2Service(client, {
    hasCoverage: (dateFrom: string, dateTo: string) => {
      coverageChecks.push({ dateFrom, dateTo })
      return false
    },
    getGeneration: () => 'unused',
    queryP2Overview: () => {
      throw new Error('cache overview should not be queried')
    },
  })

  const payload = await service.getOverview(createFilters())

  assert.deepEqual(coverageChecks, [{ dateFrom: '2026-03-31', dateTo: '2026-04-29' }])
  assert.equal(calls.length, 2)
  assert.equal(payload.cards.order_count, 2)
  assert.equal(payload.cards.sales_qty, 4)
  assert.equal(payload.meta.source_mode, 'bigquery_fallback')
}

async function testOverviewFallsBackToBigQueryWhenCacheFails() {
  const { client, calls } = createClient([
    [{
      order_count: 1,
      regular_order_count: 1,
      non_regular_order_count: 0,
      gmv: 80,
      net_received_amount: 75,
      net_revenue_amount: 70,
      regular_received_amount: 75,
      non_regular_received_amount: 0,
      refund_order_count: 1,
      refund_amount: 5,
    }],
    [{ sales_qty: 2 }],
  ])
  const service = new P2Service(client, {
    hasCoverage: () => {
      throw new Error('cache database locked')
    },
    getGeneration: () => 'unused',
    queryP2Overview: () => {
      throw new Error('cache overview should not be queried')
    },
  })

  const payload = await service.getOverview(createFilters())

  assert.equal(calls.length, 2)
  assert.equal(payload.cards.order_count, 1)
  assert.equal(payload.meta.source_mode, 'bigquery_fallback')
  assert.ok(
    payload.meta.notes.some((note) =>
      note.includes('SQLite Shopify BI cache unavailable; fell back to BigQuery: cache database locked'),
    ),
  )
}

async function testOverviewSalesQtyExcludesShippingCostLines() {
  const { client, calls } = createClient([
    [{
      order_count: 0,
      regular_order_count: 0,
      non_regular_order_count: 0,
      gmv: 0,
      net_received_amount: 0,
      net_revenue_amount: 0,
      regular_received_amount: 0,
      non_regular_received_amount: 0,
      refund_order_count: 0,
      refund_amount: 0,
    }],
    [{ sales_qty: 0 }],
  ])
  const service = new P2Service(client)

  await service.getOverview(createFilters())

  const salesQtySql = calls[1]?.query ?? ''
  assert.match(salesQtySql, /NOT COALESCE\(li\.is_shipping_cost, FALSE\)/)
}

async function testSpuTableExcludesShippingCostLines() {
  const { client, calls } = createClient([[]])
  const service = new P2Service(client)

  await service.getSpuTable(createFilters(), 20)

  const spuTableSql = calls[0]?.query ?? ''
  assert.match(spuTableSql, /NOT COALESCE\(li\.is_shipping_cost, FALSE\)/)
}

await testOverviewUsesAdr0007FinanceMetrics()
await testOverviewUsesSqliteCacheWhenCovered()
await testOverviewFallsBackToBigQueryWhenCacheCoverageMissing()
await testOverviewFallsBackToBigQueryWhenCacheFails()
await testOverviewSalesQtyExcludesShippingCostLines()
await testSpuTableExcludesShippingCostLines()

console.log('P2 tests passed')
