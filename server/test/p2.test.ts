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
  assert.match(overviewSql, /o\.cs_bi_gmv/)
  assert.match(overviewSql, /o\.cs_bi_revenue/)
  assert.match(overviewSql, /o\.cs_bi_net_revenue/)
  assert.match(overviewSql, /re\.refund_date BETWEEN DATE\(@date_from\) AND DATE\(@date_to\)/)
  assert.doesNotMatch(overviewSql, /\bo\.gmv\b/)
  assert.doesNotMatch(overviewSql, /revenue_after_all_discounts/)

  assert.equal(payload.cards.gmv, 100)
  assert.equal(payload.cards.net_received_amount, 90)
  assert.equal(payload.cards.net_revenue_amount, 80)
  assert.equal(payload.cards.refund_amount_ratio, 10 / 90)
  assert.match(payload.meta.notes[0] ?? '', /ADR-0007/)
  assert.match(payload.meta.notes[0] ?? '', /refund-flow/)
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
await testOverviewSalesQtyExcludesShippingCostLines()
await testSpuTableExcludesShippingCostLines()

console.log('P2 tests passed')
