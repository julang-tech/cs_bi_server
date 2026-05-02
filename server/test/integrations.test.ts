import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BigQueryOrderEnrichmentRepository,
  BigQuerySalesRepository,
} from '../integrations/bigquery.js'
import { FeishuIssueProvider } from '../integrations/feishu.js'
import { SqliteIssueProvider, SqliteMirrorRepository } from '../integrations/sqlite.js'
import { createP3Service } from '../domain/p3/service.js'

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bikanban-p3-'))
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

async function testBigQueryOrderEnrichmentRepository() {
  const repository = new BigQueryOrderEnrichmentRepository({
    async query(options: { query?: string }) {
      if (String(options.query).includes('dwd_refund_events')) {
        return [[
          {
            order_no: 'LC3',
            sku: 'SKU-4',
            refund_date: '2026-03-12',
          },
        ]]
      }

      return [[
        {
          order_no: 'LC3',
          order_date: '2026-03-09',
          sku: 'SKU-4',
          skc: 'SKC-4',
          spu: 'SPU-4',
        },
      ]]
    },
  })

  const result = await repository.enrichIssues([
    {
      source_system: 'openclaw_feishu',
      source_subtable: '1-4待跟进表-物流问题',
      source_record_id: 'rec-logistics',
      major_issue_type: 'logistics',
      minor_issue_type: '物流问题-超期',
      order_no: 'LC3',
      record_date: '2026-03-08',
      order_date: null,
      refund_date: null,
      customer_email: 'c@example.com',
      is_order_level_only: true,
      order_line_contexts: [],
    },
  ])

  assert.equal(result.notes.length, 0)
  assert.equal(result.issues[0]?.order_date, '2026-03-09')
  assert.equal(result.issues[0]?.refund_date, '2026-03-12')
  assert.equal(result.issues[0]?.order_line_contexts[0]?.sku, 'SKU-4')
}

async function testBigQueryOrderEnrichmentRepositoryFallbackKeepsIssue() {
  const repository = new BigQueryOrderEnrichmentRepository({
    async query() {
      return [[]]
    },
  })

  const result = await repository.enrichIssues([
    {
      source_system: 'sqlite_mirror',
      source_subtable: '1-3待跟进表-货品瑕疵',
      source_record_id: 'rec-fallback',
      major_issue_type: 'product',
      minor_issue_type: '货品瑕疵-其他',
      order_no: 'LC404',
      record_date: '2026-04-20',
      order_date: null,
      refund_date: null,
      sku: 'SKU-404',
      skc: null,
      spu: null,
      customer_email: 'fallback@example.com',
      country: null,
      solution: '退款跟进',
      is_order_level_only: false,
      order_line_contexts: [],
    },
  ])

  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0]?.order_no, 'LC404')
  assert.equal(result.issues[0]?.order_date, '2026-04-20')
  assert.match(result.notes[0] ?? '', /Missing order enrichment/)
}

async function testBigQueryOrderEnrichmentRepositoryUsesSkuRefundDate() {
  const repository = new BigQueryOrderEnrichmentRepository({
    async query(options: { query?: string }) {
      if (String(options.query).includes('dwd_refund_events')) {
        return [[
          {
            order_no: 'LC5',
            sku: 'SKU-5',
            refund_date: '2026-03-15',
          },
          {
            order_no: 'LC5',
            sku: 'SKU-6',
            refund_date: '2026-03-16',
          },
        ]]
      }

      return [[
        {
          order_no: 'LC5',
          order_date: '2026-03-10',
          sku: 'SKU-5',
          skc: 'SKC-5',
          spu: 'SPU-5',
        },
        {
          order_no: 'LC5',
          order_date: '2026-03-10',
          sku: 'SKU-6',
          skc: 'SKC-6',
          spu: 'SPU-6',
        },
      ]]
    },
  })

  const result = await repository.enrichIssues([
    {
      source_system: 'sqlite_mirror',
      source_subtable: '1-3待跟进表-货品瑕疵',
      source_record_id: 'rec-product-refund',
      major_issue_type: 'product',
      minor_issue_type: '货品瑕疵-其他',
      order_no: 'LC5',
      record_date: '2026-03-09',
      order_date: null,
      refund_date: null,
      sku: 'SKU-6',
      skc: null,
      spu: null,
      customer_email: 'refund@example.com',
      country: null,
      solution: '退款跟进',
      is_order_level_only: false,
      order_line_contexts: [],
    },
  ])

  assert.equal(result.issues[0]?.refund_date, '2026-03-16')
  assert.equal(result.issues[0]?.spu, 'SPU-6')
}

async function testBigQuerySalesRepository() {
  const repository = new BigQuerySalesRepository({
    async query(options: { query?: string }) {
      if (String(options.query).includes('WITH order_sku_rows')) {
        return [[
          { spu: 'SPU-1', skc: 'SKC-1', sales_qty: 2 },
          { spu: 'SPU-1', skc: 'SKC-2', sales_qty: 1 },
        ]]
      }

      if (String(options.query).includes('GROUP BY 1')) {
        return [[
          { bucket: '2026-03-10', sales_qty: 2 },
          { bucket: '2026-03-11', sales_qty: 3 },
        ]]
      }

      return [[{ sales_qty: 5 }]]
    },
  })

  const filters = {
    date_from: '2026-03-10',
    date_to: '2026-03-11',
    grain: 'day' as const,
    date_basis: 'order_date' as const,
    sku: 'SKU-1',
    skc: 'SKC-1',
    spu: 'SPU-1',
  }

  const summary = await repository.fetchSummary(filters)
  const trends = await repository.fetchTrends(filters)
  const productSales = await repository.fetchProductSales(filters)

  assert.equal(summary.sales_qty, 5)
  assert.deepEqual(trends, [
    { bucket: '2026-03-10', sales_qty: 2, complaint_count: 0 },
    { bucket: '2026-03-11', sales_qty: 3, complaint_count: 0 },
  ])
  assert.deepEqual(productSales, [
    { spu: 'SPU-1', skc: 'SKC-1', sales_qty: 2 },
    { spu: 'SPU-1', skc: 'SKC-2', sales_qty: 1 },
  ])
}

async function testFeishuIssueProviderSuccess() {
  const originalFetch = globalThis.fetch
  let authCalls = 0
  let recordsCalls = 0

  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input)
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      authCalls += 1
      return new Response(
        JSON.stringify({
          code: 0,
          tenant_access_token: 'tenant-token',
        }),
        { status: 200 },
      )
    }

    recordsCalls += 1
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          items: [
            {
              record_id: 'rec-1',
              fields: {
                订单号: 'LC100',
                命中视图: '1-3待跟进表-货品瑕疵',
                瑕疵原因: '货品瑕疵-其他',
                客户邮箱: 'x@example.com',
                客诉SKU: 'SKU-100',
                记录日期: '2026-03-10',
              },
            },
            {
              record_id: 'rec-2',
              fields: {
                订单号: '',
              },
            },
            {
              record_id: 'rec-3',
              fields: {
                订单号: 'LC101',
              },
            },
          ],
        },
      }),
      { status: 200 },
    )
  }) as typeof fetch

  try {
    const provider = new FeishuIssueProvider(process.cwd(), {
      feishu: { app_id: 'cli_xxx', app_secret: 'secret' },
      source: { app_token: 'source-app', table_id: 'source-table', view_id: 'source-view' },
      target: { app_token: 'target-app', table_id: 'target-table', view_id: 'target-view' },
      runtime: {
        state_path: './data/state.json',
        log_path: './data/sync.log',
        sqlite_path: './data/issues.sqlite',
      },
    })

    const bundle = await provider.getSourceBundle()
    assert.equal(authCalls, 1)
    assert.equal(recordsCalls, 1)
    assert.equal(bundle.partial_data, false)
    // rec-1 (product), rec-3 (no view → other). rec-2 (no order_no) skipped.
    assert.equal(bundle.issues.length, 2)
    assert.equal(bundle.issues[0]?.major_issue_type, 'product')
    assert.equal(bundle.issues[1]?.major_issue_type, 'other')
    assert.equal(bundle.notes.length, 1)
    assert.match(bundle.notes[0] ?? '', /Skipped record rec-2/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testFeishuIssueProviderFailure() {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: 999, msg: 'bad auth' }), { status: 200 })) as typeof fetch

  try {
    const provider = new FeishuIssueProvider(process.cwd(), {
      feishu: { app_id: 'cli_xxx', app_secret: 'secret' },
      source: { app_token: 'source-app', table_id: 'source-table', view_id: 'source-view' },
      target: { app_token: 'target-app', table_id: 'target-table', view_id: 'target-view' },
      runtime: {
        state_path: './data/state.json',
        log_path: './data/sync.log',
        sqlite_path: './data/issues.sqlite',
      },
    })

    const bundle = await provider.getSourceBundle()
    assert.equal(bundle.partial_data, true)
    assert.equal(bundle.issues.length, 0)
    assert.match(bundle.notes[0] ?? '', /Failed to fetch Feishu records/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testSqliteIssueProviderAndP3Service() {
  const tmpDir = createTempDir()
  const configPath = path.join(tmpDir, 'config', 'sync', 'config.json')
  const sqlitePath = path.join(tmpDir, 'config', 'data', 'issues.sqlite')
  writeJson(configPath, {
    feishu: { app_id: 'cli_xxx', app_secret: 'secret' },
    source: { app_token: 'source-app', table_id: 'source-table', view_id: 'source-view' },
    target: { app_token: 'target-app', table_id: 'target-table', view_id: 'target-view' },
    runtime: {
      state_path: './data/state.json',
      log_path: './data/sync.log',
      sqlite_path: './data/issues.sqlite',
      refresh_interval_minutes: 120,
    },
  })

  const repository = new SqliteMirrorRepository(sqlitePath)
  repository.syncRecords([
    {
      record_id: 'target-rec-1',
      source_record_id: 'source-rec-1',
      source_record_index: 0,
      synced_at: '2026-04-27T00:00:00.000Z',
      fields: {
        订单号: 'LC500',
        记录日期: '2026/04/24',
        客诉SKU: 'SKU-500',
        客诉类型: '货品瑕疵-其他',
        客诉方案: ['退款'],
        命中视图: '1-3待跟进表-货品瑕疵',
        客户邮箱: 'sqlite@example.com',
      },
    },
  ])
  repository.close()

  const provider = new SqliteIssueProvider(process.cwd(), sqlitePath)
  const bundle = await provider.getSourceBundle()
  assert.equal(bundle.issues.length, 1)
  assert.equal(bundle.issues[0]?.order_no, 'LC500')
  assert.equal(bundle.issues[0]?.major_issue_type, 'product')

  const originalCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS
  process.env.GOOGLE_APPLICATION_CREDENTIALS = ''
  try {
    const service = createP3Service(process.cwd(), configPath)
    const payload = await service.getDashboard({
      date_from: '2026-04-01',
      date_to: '2026-04-30',
      grain: 'week',
      date_basis: 'order_date',
    })

    assert.ok(payload.meta.source_modes.includes('sqlite mirrored target records'))
    assert.ok(payload.meta.source_modes.includes('sqlite shopify bi cache'))
    assert.equal(payload.summary.complaint_count, 1)
  } finally {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = originalCredentials
  }
}

async function testP3ServiceFallsBackToFeishuWhenSqliteMirrorMissing() {
  const tmpDir = createTempDir()
  const configPath = path.join(tmpDir, 'config', 'sync', 'config.json')
  const sqlitePath = path.join(tmpDir, 'config', 'data', 'missing.sqlite')
  writeJson(configPath, {
    feishu: { app_id: 'cli_xxx', app_secret: 'secret' },
    source: { app_token: 'source-app', table_id: 'source-table', view_id: 'source-view' },
    target: { app_token: 'target-app', table_id: 'target-table', view_id: 'target-view' },
    runtime: {
      state_path: './data/state.json',
      log_path: './data/sync.log',
      sqlite_path: './data/missing.sqlite',
      refresh_interval_minutes: 120,
    },
  })

  assert.equal(fs.existsSync(sqlitePath), false)

  const originalFetch = globalThis.fetch
  let authCalls = 0
  let recordsCalls = 0
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input)
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      authCalls += 1
      return new Response(
        JSON.stringify({
          code: 0,
          tenant_access_token: 'tenant-token',
        }),
        { status: 200 },
      )
    }

    recordsCalls += 1
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          items: [],
        },
      }),
      { status: 200 },
    )
  }) as typeof fetch

  try {
    const service = createP3Service(process.cwd(), configPath)
    const payload = await service.getDashboard({
      date_from: '2026-04-01',
      date_to: '2026-04-30',
      grain: 'week',
      date_basis: 'order_date',
    })

    assert.equal(fs.existsSync(sqlitePath), true)
    assert.equal(authCalls, 1)
    assert.equal(recordsCalls, 1)
    assert.ok(payload.meta.source_modes.includes('feishu/openclaw runtime fetch'))
    assert.equal(payload.meta.source_modes.includes('sqlite mirrored target records'), false)
    assert.ok(payload.meta.source_modes.includes('sqlite shopify bi cache'))

    const secondService = createP3Service(process.cwd(), configPath)
    const secondPayload = await secondService.getDashboard({
      date_from: '2026-04-01',
      date_to: '2026-04-30',
      grain: 'week',
      date_basis: 'order_date',
    })

    assert.equal(authCalls, 2)
    assert.equal(recordsCalls, 2)
    assert.ok(secondPayload.meta.source_modes.includes('feishu/openclaw runtime fetch'))
    assert.equal(secondPayload.meta.source_modes.includes('sqlite mirrored target records'), false)
    assert.ok(secondPayload.meta.source_modes.includes('sqlite shopify bi cache'))
  } finally {
    globalThis.fetch = originalFetch
  }
}

function testCreateP3ServiceAppliesBigQueryProxyConfig() {
  const tmpDir = createTempDir()
  const configPath = path.join(tmpDir, 'config', 'sync', 'config.json')
  writeJson(configPath, {
    feishu: { app_id: 'cli_xxx', app_secret: 'secret' },
    source: { app_token: 'source-app', table_id: 'source-table', view_id: 'source-view' },
    target: { app_token: 'target-app', table_id: 'target-table', view_id: 'target-view' },
    runtime: {
      state_path: './data/state.json',
      log_path: './data/sync.log',
      sqlite_path: './data/issues.sqlite',
      refresh_interval_minutes: 120,
    },
    bigquery: {
      proxy: {
        enabled: true,
        http_proxy: 'http://127.0.0.1:7890',
        https_proxy: 'http://127.0.0.1:7890',
        no_proxy: '127.0.0.1,localhost',
      },
    },
  })

  const originalHttpProxy = process.env.HTTP_PROXY
  const originalHttpsProxy = process.env.HTTPS_PROXY
  const originalNoProxy = process.env.NO_PROXY

  try {
    createP3Service(process.cwd(), configPath)
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7890')
    assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:7890')
    assert.equal(process.env.NO_PROXY, '127.0.0.1,localhost')
  } finally {
    process.env.HTTP_PROXY = originalHttpProxy
    process.env.HTTPS_PROXY = originalHttpsProxy
    process.env.NO_PROXY = originalNoProxy
  }
}

async function run() {
  await testBigQueryOrderEnrichmentRepository()
  await testBigQueryOrderEnrichmentRepositoryFallbackKeepsIssue()
  await testBigQueryOrderEnrichmentRepositoryUsesSkuRefundDate()
  await testBigQuerySalesRepository()
  await testFeishuIssueProviderSuccess()
  await testFeishuIssueProviderFailure()
  await testSqliteIssueProviderAndP3Service()
  await testP3ServiceFallsBackToFeishuWhenSqliteMirrorMissing()
  testCreateP3ServiceAppliesBigQueryProxyConfig()
  console.log('P3 integration tests passed')
}

await run()
