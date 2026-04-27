import assert from 'node:assert/strict'
import { BigQueryOrderEnrichmentRepository } from '../integrations/bigquery.js'
import { FeishuIssueProvider } from '../integrations/feishu.js'

async function testBigQueryOrderEnrichmentRepository() {
  const repository = new BigQueryOrderEnrichmentRepository({
    async query() {
      return [[
        {
          order_no: 'LC3',
          order_date: '2026-03-09',
          country: 'CA',
          sku: 'SKU-4',
          quantity: 1,
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
      customer_email: 'c@example.com',
      is_order_level_only: true,
      order_line_contexts: [],
    },
  ])

  assert.equal(result.notes.length, 0)
  assert.equal(result.issues[0]?.order_date, '2026-03-09')
  assert.equal(result.issues[0]?.order_line_contexts[0]?.sku, 'SKU-4')
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
      runtime: { state_path: './data/state.json', log_path: './data/sync.log' },
    })

    const bundle = await provider.getSourceBundle()
    assert.equal(authCalls, 1)
    assert.equal(recordsCalls, 1)
    assert.equal(bundle.partial_data, false)
    assert.equal(bundle.issues.length, 1)
    assert.equal(bundle.issues[0]?.major_issue_type, 'product')
    assert.equal(bundle.notes.length, 2)
    assert.match(bundle.notes[0] ?? '', /Skipped record rec-2/)
    assert.match(bundle.notes[1] ?? '', /Ignored 1 records/)
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
      runtime: { state_path: './data/state.json', log_path: './data/sync.log' },
    })

    const bundle = await provider.getSourceBundle()
    assert.equal(bundle.partial_data, true)
    assert.equal(bundle.issues.length, 0)
    assert.match(bundle.notes[0] ?? '', /Failed to fetch Feishu records/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function run() {
  await testBigQueryOrderEnrichmentRepository()
  await testFeishuIssueProviderSuccess()
  await testFeishuIssueProviderFailure()
  console.log('P3 integration tests passed')
}

await run()
