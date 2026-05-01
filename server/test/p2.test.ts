import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { P2Service, type P2Filters } from '../domain/p2/service.js'

type QueryCall = {
  query: string
  params?: Record<string, unknown>
}

function emptyTrendsMock() {
  return {
    trends: {
      order_count: [],
      sales_qty: [],
      refund_order_count: [],
      refund_amount: [],
      gmv: [],
      net_received_amount: [],
      net_revenue_amount: [],
      refund_amount_ratio: [],
    },
  }
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

function extractSqlSection(sql: string, from: string, to: string) {
  const start = sql.indexOf(from)
  const end = sql.indexOf(to, start + from.length)
  assert.notEqual(start, -1, `Missing SQL section start: ${from}`)
  assert.notEqual(end, -1, `Missing SQL section end: ${to}`)
  return sql.slice(start, end)
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
  assert.doesNotMatch(overviewSql, /@spu IN UNNEST\(IFNULL\(o\.product_ids/)
  assert.doesNotMatch(overviewSql, /@skc IN UNNEST\(IFNULL\(o\.skcs/)
  assert.match(overviewSql, /EXISTS \(/)
  assert.match(overviewSql, /parsed_spu/)
  assert.match(overviewSql, /parsed_skc/)
  assert.doesNotMatch(overviewSql, /\bo\.gmv\b/)
  assert.doesNotMatch(overviewSql, /revenue_after_all_discounts/)

  const salesQtySql = calls[1]?.query ?? ''
  assert.doesNotMatch(salesQtySql, /@spu IN UNNEST\(IFNULL\(o\.product_ids/)
  assert.doesNotMatch(salesQtySql, /@skc IN UNNEST\(IFNULL\(o\.skcs/)
  assert.match(salesQtySql, /EXISTS \(/)
  assert.match(salesQtySql, /parsed_spu/)
  assert.match(salesQtySql, /parsed_skc/)

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
    queryP2SpuTable: () => ({ rows: [] }),
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
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
    queryP2SpuTable: () => ({ rows: [] }),
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
  })

  const payload = await service.getOverview(createFilters())

  assert.deepEqual(coverageChecks, [{ dateFrom: '2026-03-31', dateTo: '2026-04-29' }])
  assert.equal(calls.length, 5)
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
    queryP2SpuTable: () => ({ rows: [] }),
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
  })

  const payload = await service.getOverview(createFilters())

  assert.equal(calls.length, 5)
  assert.equal(payload.cards.order_count, 1)
  assert.equal(payload.meta.source_mode, 'bigquery_fallback')
  assert.ok(
    payload.meta.notes.some((note) =>
      note.includes('SQLite Shopify BI cache unavailable; fell back to BigQuery: cache database locked'),
    ),
  )
}

async function testOverviewCacheErrorWithoutBigQueryDoesNotClaimFallback() {
  const service = new P2Service(null, {
    hasCoverage: () => {
      throw new Error('cache database locked')
    },
    getGeneration: () => 'unused',
    queryP2Overview: () => {
      throw new Error('cache overview should not be queried')
    },
    queryP2SpuTable: () => ({ rows: [] }),
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
  })

  const payload = await service.getOverview(createFilters())

  assert.equal(payload.meta.partial_data, true)
  assert.deepEqual(payload.cards, {
    order_count: 0,
    sales_qty: 0,
    refund_order_count: 0,
    refund_amount: 0,
    gmv: 0,
    net_received_amount: 0,
    net_revenue_amount: 0,
    refund_amount_ratio: 0,
    avg_order_amount: 0,
  })
  assert.ok(
    payload.meta.notes.some((note) =>
      note.includes('SQLite Shopify BI cache unavailable: cache database locked'),
    ),
  )
  assert.ok(
    payload.meta.notes.some((note) =>
      note.includes('BigQuery credentials not found; returning empty overview.'),
    ),
  )
  assert.equal(
    payload.meta.notes.some((note) => /fell back to BigQuery/.test(note)),
    false,
  )
}

async function testCloseClosesCacheRepository() {
  let closeCount = 0
  const service = new P2Service(null, {
    hasCoverage: () => false,
    getGeneration: () => 'unused',
    queryP2Overview: () => {
      throw new Error('cache overview should not be queried')
    },
    queryP2SpuTable: () => ({ rows: [] }),
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
    close: () => {
      closeCount += 1
    },
  })

  service.close()

  assert.equal(closeCount, 1)
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
  assert.match(spuTableSql, /sales_lines AS/)
  assert.match(spuTableSql, /refund_event_agg AS/)
  assert.match(spuTableSql, /refund_line_dim AS/)
  assert.match(spuTableSql, /refund_event_agg AS \([\s\S]*re\.refund_date BETWEEN DATE\(@date_from\) AND DATE\(@date_to\)/)
  const refundLineDimSql = extractSqlSection(spuTableSql, 'refund_line_dim AS', 'refund_agg AS')
  assert.doesNotMatch(refundLineDimSql, /processed_date BETWEEN DATE\(@date_from\) AND DATE\(@date_to\)/)
}

async function testSpuTableScalarFiltersFeedBigQueryListParams() {
  const { client, calls } = createClient([[]])
  const service = new P2Service(client)

  await service.getSpuTable({ ...createFilters(), spu: 'LWS-PT21BK', skc: 'LWS-PT21BK' }, 20)

  assert.equal(calls[0]?.params?.spu_filter_on, 1)
  assert.equal(calls[0]?.params?.skc_filter_on, 1)
  assert.deepEqual(calls[0]?.params?.spu_list, ['LWS-PT21BK'])
  assert.deepEqual(calls[0]?.params?.skc_list, ['LWS-PT21BK'])
}

async function testSpuSkcOptionsExcludesShippingCostLines() {
  const { client, calls } = createClient([[]])
  const service = new P2Service(client)

  await service.getSpuSkcOptions(createFilters())

  const optionsSql = calls[0]?.query ?? ''
  assert.match(optionsSql, /NOT COALESCE\(li\.is_shipping_cost, FALSE\)/)
}

async function testSpuTableUsesSqliteCacheWhenCovered() {
  const bigQuery = createClient([[{ row_type: 'SPU', spu: 'BQ', refund_amount: 999 }]])
  const service = new P2Service(bigQuery.client, {
    hasCoverage: () => true,
    getGeneration: () => 'generation-1',
    queryP2Overview: () => {
      throw new Error('overview not used')
    },
    queryP2SpuTable: () => ({
      rows: [{
        spu: 'SPU-1',
        sales_qty: 2,
        sales_amount: 100,
        refund_qty: 1,
        refund_amount: 50,
        refund_qty_ratio: 0.5,
        refund_amount_ratio: 0.5,
        skc_rows: [],
      }],
    }),
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
  })

  const payload = await service.getSpuTable(createFilters(), 20)

  assert.equal(bigQuery.calls.length, 0)
  assert.equal(payload.rows[0]?.spu, 'SPU-1')
  assert.equal(payload.meta.source_mode, 'sqlite_shopify_bi_cache')
  assert.equal(payload.meta.cache_generation, 'generation-1')
  assert.deepEqual(payload.meta.notes, [])
}

async function testSpuSkcOptionsUsesSqliteCacheWhenCovered() {
  const bigQuery = createClient([[{ spu: 'BQ', skc: 'BQ-SKC' }]])
  const service = new P2Service(bigQuery.client, {
    hasCoverage: () => true,
    getGeneration: () => 'generation-1',
    queryP2Overview: () => {
      throw new Error('overview not used')
    },
    queryP2SpuTable: () => ({ rows: [] }),
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => ({
      options: {
        spus: ['SPU-1'],
        skcs: ['SKC-1'],
        pairs: [{ spu: 'SPU-1', skc: 'SKC-1' }],
      },
    }),
  })

  const payload = await service.getSpuSkcOptions(createFilters())

  assert.equal(bigQuery.calls.length, 0)
  assert.deepEqual(payload.options, {
    spus: ['SPU-1'],
    skcs: ['SKC-1'],
    pairs: [{ spu: 'SPU-1', skc: 'SKC-1' }],
  })
  assert.equal(payload.meta.source_mode, 'sqlite_shopify_bi_cache')
  assert.equal(payload.meta.cache_generation, 'generation-1')
  assert.deepEqual(payload.meta.notes, [])
}

async function testOverviewCachesSqliteResponsesByGeneration() {
  let sqliteCalls = 0
  let generationCalls = 0
  const service = new P2Service(null, {
    hasCoverage: () => true,
    getGeneration: () => {
      generationCalls += 1
      return 'generation-1'
    },
    queryP2Overview: () => {
      sqliteCalls += 1
      return {
        cards: {
          order_count: sqliteCalls,
          sales_qty: 0,
          refund_order_count: 0,
          refund_amount: 0,
          gmv: 0,
          net_received_amount: 0,
          net_revenue_amount: 0,
          refund_amount_ratio: 0,
          avg_order_amount: 0,
        },
      }
    },
    queryP2SpuTable: () => ({ rows: [] }),
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
  })

  const first = await service.getOverview(createFilters())
  const second = await service.getOverview(createFilters())

  assert.equal(first.cards.order_count, 1)
  assert.equal(second.cards.order_count, 1)
  assert.equal(sqliteCalls, 1)
  assert.equal(generationCalls, 2)
}

async function testSpuTableCachesSqliteResponsesByGenerationAndTopN() {
  let sqliteCalls = 0
  const service = new P2Service(null, {
    hasCoverage: () => true,
    getGeneration: () => 'generation-1',
    queryP2Overview: () => {
      throw new Error('overview not used')
    },
    queryP2SpuTable: () => {
      sqliteCalls += 1
      return {
        rows: [{
          spu: `SPU-${sqliteCalls}`,
          sales_qty: 0,
          sales_amount: 0,
          refund_qty: 0,
          refund_amount: 0,
          refund_qty_ratio: 0,
          refund_amount_ratio: 0,
          skc_rows: [],
        }],
      }
    },
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
  })

  const first = await service.getSpuTable(createFilters(), 20)
  const second = await service.getSpuTable(createFilters(), 20)
  const differentTopN = await service.getSpuTable(createFilters(), 10)

  assert.equal(first.rows[0]?.spu, 'SPU-1')
  assert.equal(second.rows[0]?.spu, 'SPU-1')
  assert.equal(differentTopN.rows[0]?.spu, 'SPU-2')
  assert.equal(sqliteCalls, 2)
}

async function testSpuSkcOptionsCachesSqliteResponsesByGeneration() {
  let sqliteCalls = 0
  const service = new P2Service(null, {
    hasCoverage: () => true,
    getGeneration: () => 'generation-1',
    queryP2Overview: () => {
      throw new Error('overview not used')
    },
    queryP2SpuTable: () => ({ rows: [] }),
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => {
      sqliteCalls += 1
      return {
        options: {
          spus: [`SPU-${sqliteCalls}`],
          skcs: [`SKC-${sqliteCalls}`],
          pairs: [{ spu: `SPU-${sqliteCalls}`, skc: `SKC-${sqliteCalls}` }],
        },
      }
    },
  })

  const first = await service.getSpuSkcOptions(createFilters())
  const second = await service.getSpuSkcOptions(createFilters())

  assert.deepEqual(first.options.spus, ['SPU-1'])
  assert.deepEqual(second.options.spus, ['SPU-1'])
  assert.equal(sqliteCalls, 1)
}

async function testOverviewCacheInvalidatesWhenGenerationChanges() {
  let sqliteCalls = 0
  let generationCalls = 0
  const service = new P2Service(null, {
    hasCoverage: () => true,
    getGeneration: () => {
      generationCalls += 1
      return `generation-${generationCalls}`
    },
    queryP2Overview: () => {
      sqliteCalls += 1
      return {
        cards: {
          order_count: sqliteCalls,
          sales_qty: 0,
          refund_order_count: 0,
          refund_amount: 0,
          gmv: 0,
          net_received_amount: 0,
          net_revenue_amount: 0,
          refund_amount_ratio: 0,
          avg_order_amount: 0,
        },
      }
    },
    queryP2SpuTable: () => ({ rows: [] }),
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
  })

  const first = await service.getOverview(createFilters())
  const second = await service.getOverview(createFilters())

  assert.equal(first.cards.order_count, 1)
  assert.equal(first.meta.cache_generation, 'generation-1')
  assert.equal(second.cards.order_count, 2)
  assert.equal(second.meta.cache_generation, 'generation-2')
  assert.equal(sqliteCalls, 2)
}

async function testSpuTableFallsBackToBigQueryWhenCacheCoverageMissing() {
  const { client, calls } = createClient([[
    {
      row_type: 'SPU',
      spu: 'BQ-SPU',
      sales_qty: 2,
      sales_amount: 100,
      refund_qty: 1,
      refund_amount: 40,
      refund_qty_ratio: 0.5,
      refund_amount_ratio: 0.4,
    },
  ]])
  const service = new P2Service(client, {
    hasCoverage: () => false,
    getGeneration: () => 'unused',
    queryP2Overview: () => {
      throw new Error('overview not used')
    },
    queryP2SpuTable: () => {
      throw new Error('cache table should not be queried')
    },
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
  })

  const payload = await service.getSpuTable(createFilters(), 20)

  assert.equal(calls.length, 1)
  assert.equal(payload.rows[0]?.spu, 'BQ-SPU')
  assert.equal(payload.meta.source_mode, 'bigquery_fallback')
}

async function testSpuSkcOptionsFallsBackToBigQueryWhenCacheFails() {
  const { client, calls } = createClient([[{ spu: 'BQ-SPU', skc: 'BQ-SKC' }]])
  const service = new P2Service(client, {
    hasCoverage: () => {
      throw new Error('cache database locked')
    },
    getGeneration: () => 'unused',
    queryP2Overview: () => {
      throw new Error('overview not used')
    },
    queryP2SpuTable: () => ({ rows: [] }),
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => {
      throw new Error('options not used')
    },
  })

  const payload = await service.getSpuSkcOptions(createFilters())

  assert.equal(calls.length, 1)
  assert.deepEqual(payload.options, {
    spus: ['BQ-SPU'],
    skcs: ['BQ-SKC'],
    pairs: [{ spu: 'BQ-SPU', skc: 'BQ-SKC' }],
  })
  assert.equal(payload.meta.source_mode, 'bigquery_fallback')
  assert.ok(
    payload.meta.notes.some((note) =>
      note.includes('SQLite Shopify BI cache unavailable; fell back to BigQuery: cache database locked'),
    ),
  )
}

async function testSpuTableCacheErrorWithoutBigQueryDoesNotClaimFallback() {
  const service = new P2Service(null, {
    hasCoverage: () => {
      throw new Error('cache database locked')
    },
    getGeneration: () => 'unused',
    queryP2Overview: () => {
      throw new Error('overview not used')
    },
    queryP2SpuTable: () => {
      throw new Error('table not used')
    },
    queryP2Trends: () => emptyTrendsMock(),
    queryP2SpuSkcOptions: () => ({ options: { spus: [], skcs: [], pairs: [] } }),
  })

  const payload = await service.getSpuTable(createFilters(), 20)

  assert.equal(payload.meta.partial_data, true)
  assert.deepEqual(payload.rows, [])
  assert.ok(
    payload.meta.notes.some((note) =>
      note.includes('SQLite Shopify BI cache unavailable: cache database locked'),
    ),
  )
  assert.ok(
    payload.meta.notes.some((note) =>
      note.includes('BigQuery credentials not found; returning empty table.'),
    ),
  )
  assert.equal(
    payload.meta.notes.some((note) => /fell back to BigQuery/.test(note)),
    false,
  )
}

async function testSqliteCacheReturnsP2SpuTableAndOptions() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-cache-'))
  const sqlitePath = path.join(tmpDir, 'data', 'issues.sqlite')
  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(sqlitePath)

  try {
    cache.replaceWindow({
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
      orders: [
        {
          order_id: 'order-a',
          order_no: 'LC100',
          shop_domain: '2vnpww-33.myshopify.com',
          processed_date: '2026-04-02',
          primary_product_type: 'Dress',
          first_published_at_in_order: '2026-03-20',
          is_regular_order: true,
          is_gift_card_order: false,
          gmv_usd: 120,
          revenue_usd: 100,
          net_revenue_usd: 90,
        },
        {
          order_id: 'order-b',
          order_no: 'LC101',
          shop_domain: '2vnpww-33.myshopify.com',
          processed_date: '2026-04-03',
          primary_product_type: 'Dress',
          first_published_at_in_order: '2026-03-21',
          is_regular_order: true,
          is_gift_card_order: false,
          gmv_usd: 80,
          revenue_usd: 80,
          net_revenue_usd: 70,
        },
        {
          order_id: 'order-c',
          order_no: 'LC102',
          shop_domain: '2vnpww-33.myshopify.com',
          processed_date: '2026-03-25',
          primary_product_type: 'Dress',
          first_published_at_in_order: '2026-03-18',
          is_regular_order: true,
          is_gift_card_order: false,
          gmv_usd: 90,
          revenue_usd: 90,
          net_revenue_usd: 80,
        },
      ],
      orderLines: [
        {
          order_id: 'order-a',
          order_no: 'LC100',
          line_key: 'order-a:line-1',
          sku: 'DRESS-RED-M',
          skc: 'DRESS-RED',
          spu: 'DRESS',
          product_id: 'prod-a',
          variant_id: 'var-a',
          quantity: 2,
          discounted_total_usd: 100,
          is_insurance_item: false,
          is_price_adjustment: false,
          is_shipping_cost: false,
        },
        {
          order_id: 'order-b',
          order_no: 'LC101',
          line_key: 'order-b:line-1',
          sku: 'TOP-BLUE-M',
          skc: 'TOP-BLUE',
          spu: 'TOP',
          product_id: 'prod-b',
          variant_id: 'var-b',
          quantity: 1,
          discounted_total_usd: 80,
          is_insurance_item: false,
          is_price_adjustment: false,
          is_shipping_cost: false,
        },
        {
          order_id: 'order-c',
          order_no: 'LC102',
          line_key: 'order-c:line-1',
          sku: 'JACKET-GREEN-M',
          skc: 'JACKET-GREEN',
          spu: 'JACKET',
          product_id: 'prod-c',
          variant_id: 'var-c',
          quantity: 1,
          discounted_total_usd: 90,
          is_insurance_item: false,
          is_price_adjustment: false,
          is_shipping_cost: false,
        },
        {
          order_id: 'order-a',
          order_no: 'LC100',
          line_key: 'order-a:shipping',
          sku: 'SHIP',
          skc: 'SHIP',
          spu: 'SHIP',
          product_id: null,
          variant_id: null,
          quantity: 1,
          discounted_total_usd: 10,
          is_insurance_item: false,
          is_price_adjustment: false,
          is_shipping_cost: true,
        },
      ],
      refundEvents: [
        {
          refund_id: 'refund-a',
          order_id: 'order-a',
          order_no: 'LC100',
          sku: 'DRESS-RED-M',
          refund_date: '2026-04-05',
          refund_quantity: 1,
          refund_subtotal_usd: 50,
        },
        {
          refund_id: 'refund-b',
          order_id: 'order-b',
          order_no: 'LC101',
          sku: 'TOP-BLUE-M',
          refund_date: '2026-04-06',
          refund_quantity: 1,
          refund_subtotal_usd: 30,
        },
        {
          refund_id: 'refund-c',
          order_id: 'order-c',
          order_no: 'LC102',
          sku: 'JACKET-GREEN-M',
          refund_date: '2026-04-07',
          refund_quantity: 1,
          refund_subtotal_usd: 60,
        },
      ],
      finishedAt: '2026-05-01T00:00:00.000Z',
    })

    const table = cache.queryP2SpuTable({
      ...createFilters(),
      date_from: '2026-04-01',
      date_to: '2026-04-30',
      category: 'Dress',
    }, 2)
    assert.equal(table.rows.length, 2)
    assert.equal(table.rows[0]?.spu, 'JACKET')
    assert.equal(table.rows[0]?.sales_qty, 0)
    assert.equal(table.rows[0]?.sales_amount, 0)
    assert.equal(table.rows[0]?.refund_qty, 1)
    assert.equal(table.rows[0]?.refund_amount, 60)
    assert.equal(table.rows[1]?.spu, 'DRESS')
    assert.equal(table.rows[1]?.sales_qty, 2)
    assert.equal(table.rows[1]?.sales_amount, 100)
    assert.equal(table.rows[1]?.refund_qty, 1)
    assert.equal(table.rows[1]?.refund_amount, 50)
    assert.deepEqual(table.rows[1]?.skc_rows.map((row) => row.skc), ['DRESS-RED'])

    const options = cache.queryP2SpuSkcOptions({
      ...createFilters(),
      date_from: '2026-04-01',
      date_to: '2026-04-30',
      category: 'Dress',
    }).options
    assert.deepEqual(options.spus, ['DRESS', 'TOP'])
    assert.deepEqual(options.skcs, ['DRESS-RED', 'TOP-BLUE'])
    assert.deepEqual(options.pairs, [
      { spu: 'DRESS', skc: 'DRESS-RED' },
      { spu: 'TOP', skc: 'TOP-BLUE' },
    ])
  } finally {
    cache.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

await testOverviewUsesAdr0007FinanceMetrics()
await testOverviewUsesSqliteCacheWhenCovered()
await testOverviewFallsBackToBigQueryWhenCacheCoverageMissing()
await testOverviewFallsBackToBigQueryWhenCacheFails()
await testOverviewCacheErrorWithoutBigQueryDoesNotClaimFallback()
await testCloseClosesCacheRepository()
await testOverviewSalesQtyExcludesShippingCostLines()
await testSpuTableExcludesShippingCostLines()
await testSpuTableScalarFiltersFeedBigQueryListParams()
await testSpuSkcOptionsExcludesShippingCostLines()
await testSpuTableUsesSqliteCacheWhenCovered()
await testSpuSkcOptionsUsesSqliteCacheWhenCovered()
await testOverviewCachesSqliteResponsesByGeneration()
await testSpuTableCachesSqliteResponsesByGenerationAndTopN()
await testSpuSkcOptionsCachesSqliteResponsesByGeneration()
await testOverviewCacheInvalidatesWhenGenerationChanges()
await testSpuTableFallsBackToBigQueryWhenCacheCoverageMissing()
await testSpuSkcOptionsFallsBackToBigQueryWhenCacheFails()
await testSpuTableCacheErrorWithoutBigQueryDoesNotClaimFallback()
await testSqliteCacheReturnsP2SpuTableAndOptions()

console.log('P2 tests passed')
