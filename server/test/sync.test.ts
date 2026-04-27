import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SyncService, sanitizeTargetRecord } from '../domain/sync/service.js'
import { buildDateFilter, filterRowsByDate, transformSourceRecord } from '../domain/sync/transform.js'
import type { FeishuField, FeishuRecord } from '../integrations/feishu.js'
import {
  inferLogisticsStatusFromShopify,
  matchSkuAmount,
  resolveShopifySiteKey,
  type ShopifyOrder,
} from '../integrations/shopify.js'
import type { SyncConfig } from '../integrations/sync-config.js'

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bikanban-sync-'))
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function createConfig(baseDir: string) {
  const configPath = path.join(baseDir, 'config', 'config.json')
  const config = {
    feishu: {
      app_id: 'cli_xxx',
      app_secret: 'secret',
    },
    source: {
      app_token: 'source-app',
      table_id: 'source-table',
      view_id: 'source-view',
    },
    target: {
      app_token: 'target-app',
      table_id: 'target-table',
      view_id: 'target-view',
    },
    runtime: {
      state_path: './data/state.json',
      log_path: './data/sync.log',
    },
    shopify: {
      sites: {
        lc: {
          url: 'https://lc.example.com/admin/api/2025-10/graphql.json',
          token: 'lc-token',
          currency: 'USD',
          site_name: 'LC',
        },
        fr: {
          url: 'https://fr.example.com/admin/api/2025-10/graphql.json',
          token: 'fr-token',
          currency: 'EUR',
          site_name: 'FR',
        },
        uk: {
          url: 'https://uk.example.com/admin/api/2025-10/graphql.json',
          token: 'uk-token',
          currency: 'GBP',
          site_name: 'UK',
        },
      },
    },
  }
  writeJson(configPath, config)
  return configPath
}

function testTransformBasicFields() {
  const result = transformSourceRecord('src-1', {
    记录日期: '2025/08/19',
    订单号: 'LC123',
    客户订单总数: '2',
    物流状态: '已发货',
    是否退运费: '退运费',
    是否退运费险: '不退运费险',
    具体操作要求: '1件退全款',
    创建人: '张三',
    退款原因分类: '物流问题',
  })

  assert.equal(result.errors.length, 0)
  assert.equal(result.records.length, 1)
  const record = result.records[0] as Record<string, unknown>
  assert.equal(record['订单号'], 'LC123')
  assert.equal(record['历史订单数'], '2')
  assert.equal(record['跟进组'], '客服组')
  assert.match(String(record['待跟进客诉备注'] ?? ''), /物流问题/)
  assert.equal(record['客诉类型'], '物流问题-其他')
  assert.deepEqual(record['客诉方案'], ['全额退款'])
  assert.deepEqual(record['命中视图'], ['1-4待跟进表-物流问题'])
  assert.equal(record['问题处理状态'], '待处理')
}

function testTransformSplitsMultiSkuRows() {
  const result = transformSourceRecord('src-2', {
    记录日期: '2025/08/19',
    订单号: 'LC124',
    具体操作要求: '3件退40%\nLWS-PT21BK-M\nLWS-PT21TBL-M',
  })

  assert.equal(result.errors.length, 0)
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0]?.['客诉SKU'], 'LWS-PT21BK-M')
  assert.equal(result.records[1]?.['客诉SKU'], 'LWS-PT21TBL-M')
}

function testTransformInfersRefundSolutionAndView() {
  const result = transformSourceRecord('src-4', {
    记录日期: '2025/08/19',
    订单号: 'LC125',
    退款原因分类: ['错漏发'],
    具体操作要求: '补发1件\nABC-123-M',
  })

  assert.equal(result.errors.length, 0)
  const record = result.records[0] as Record<string, unknown>
  assert.deepEqual(record['客诉方案'], ['补发'])
  assert.deepEqual(record['命中视图'], ['1-5待跟进表-补发'])
  assert.equal(record['客诉类型'], '仓库-漏发')
}

function testTransformMissingRequiredFields() {
  const result = transformSourceRecord('src-3', { 记录日期: '2025/08/19' })
  assert.ok(result.errors.length > 0)
  assert.equal(result.records.length, 0)
}

function testDateFilters() {
  const rows: Array<[string, Record<string, unknown>]> = [
    ['a', { 记录日期: '2025/08/18' }],
    ['b', { 记录日期: '2025/08/19' }],
    ['c', { 记录日期: '2025/08/20' }],
  ]

  const exact = filterRowsByDate(rows, buildDateFilter({ date: '2025-08-19' }))
  assert.deepEqual(exact.map(([sourceKey]) => sourceKey), ['b'])

  const range = filterRowsByDate(rows, buildDateFilter({ from: '2025-08-19', to: '2025-08-20' }))
  assert.deepEqual(range.map(([sourceKey]) => sourceKey), ['b', 'c'])
}

function testTimestampDateFilter() {
  const rows: Array<[string, Record<string, unknown>]> = [
    ['a', { 记录日期: 1755446400000 }],
    ['b', { 记录日期: 1755532800000 }],
  ]
  const filtered = filterRowsByDate(rows, buildDateFilter({ date: '2025-08-19' }))
  assert.deepEqual(filtered.map(([sourceKey]) => sourceKey), ['b'])
}

function testDateFilterRejectsMixedModes() {
  assert.throws(() => buildDateFilter({ date: '2025-08-19', from: '2025-08-18' }))
}

function testSanitizeTargetRecord() {
  const fields: Record<string, FeishuField> = {
    订单号: { field_id: 'f1', field_name: '订单号', field_type: 1, property: null },
    问题处理状态: {
      field_id: 'f2',
      field_name: '问题处理状态',
      field_type: 3,
      property: { options: [{ name: '待处理' }] },
    },
    记录日期: { field_id: 'f3', field_name: '记录日期', field_type: 5, property: null },
  }

  const result = sanitizeTargetRecord(
    'src',
    {
      订单号: 'LC100',
      问题处理状态: '待处理',
      记录日期: '2025/08/19',
      未知字段: 'drop-me',
    },
    fields,
  )

  assert.equal(result.sanitizedRecord['订单号'], 'LC100')
  assert.equal(result.sanitizedRecord['问题处理状态'], '待处理')
  assert.equal(typeof result.sanitizedRecord['记录日期'], 'number')
  assert.deepEqual(result.dropped_unknown_fields, ['未知字段'])
}

function testResolveShopifySiteKey() {
  assert.equal(resolveShopifySiteKey('LC123'), 'lc')
  assert.equal(resolveShopifySiteKey('LUK123'), 'uk')
  assert.equal(resolveShopifySiteKey('LFR123'), 'fr')
  assert.equal(resolveShopifySiteKey('ABC123'), null)
}

function testShopifyHelpers() {
  const order: ShopifyOrder = {
    id: 'gid://shopify/Order/1',
    name: 'LC500',
    customer_name: 'Alice',
    customer_email: 'alice@example.com',
    order_date: '2026-04-01T12:00:00Z',
    order_amount: '99.50',
    currency: 'USD',
    fulfillment_status: 'FULFILLED',
    tracking_numbers: ['TRK-1'],
    shipped_at: '2026-04-02T12:00:00Z',
    admin_order_url: 'https://lc.example.com/admin/orders/1',
    line_items: [
      {
        sku: 'INSURE02',
        quantity: 1,
        originalUnitPrice: { amount: '1.99', currencyCode: 'USD' },
        originalTotal: { amount: '1.99', currencyCode: 'USD' },
      },
      {
        sku: 'SKU-1',
        quantity: 1,
        originalUnitPrice: { amount: '97.51', currencyCode: 'USD' },
        originalTotal: { amount: '97.51', currencyCode: 'USD' },
      },
    ],
  }

  assert.equal(inferLogisticsStatusFromShopify('UNFULFILLED'), '未发货')
  assert.equal(inferLogisticsStatusFromShopify('FULFILLED'), '运输途中')
  assert.equal(matchSkuAmount(order, 'sku-1'), '97.51')
  assert.equal(matchSkuAmount(order, null), '97.51')
}

async function testSyncPreviewAndRun() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const targetFields: FeishuField[] = [
    { field_id: '1', field_name: '订单号', field_type: 1, property: null },
    { field_id: '2', field_name: '记录日期', field_type: 5, property: null },
    { field_id: '3', field_name: '问题处理状态', field_type: 3, property: { options: [{ name: '待处理' }] } },
    { field_id: '4', field_name: '跟进组', field_type: 1, property: null },
    { field_id: '5', field_name: '客户姓名', field_type: 1, property: null },
    { field_id: '6', field_name: '客户邮箱', field_type: 1, property: null },
    { field_id: '7', field_name: '下单日期', field_type: 5, property: null },
    { field_id: '8', field_name: '订单金额', field_type: 2, property: null },
    { field_id: '9', field_name: '物流号', field_type: 1, property: null },
    { field_id: '10', field_name: '订单发货时间', field_type: 5, property: null },
    { field_id: '11', field_name: '后台订单链接', field_type: 1, property: null },
    { field_id: '12', field_name: '物流状态', field_type: 1, property: null },
    { field_id: '13', field_name: 'SKU金额', field_type: 2, property: null },
    { field_id: '14', field_name: '客诉SKU', field_type: 1, property: null },
  ]

  const sourceRecords: FeishuRecord[] = [
    {
      record_id: 'rec-1',
      fields: {
        记录日期: '2026/04/24',
        订单号: 'LC200',
        具体操作要求: '退款\nSKU-1',
      },
    },
  ]

  const createdRecords: Array<Record<string, unknown>> = []
  const updatedRecords: Array<Record<string, unknown>> = []

  const service = new SyncService({
    createClient: (_config: SyncConfig) => ({
      async listRecords() {
        return sourceRecords
      },
      async listFields() {
        return targetFields
      },
      async createRecord(_table, fields) {
        createdRecords.push(fields)
        return 'target-rec-1'
      },
      async updateRecord(_table, recordId, fields) {
        updatedRecords.push({ recordId, fields })
        return recordId
      },
    }),
    createShopifyClient: () => ({
      async fetchOrder(orderNo: string) {
        assert.equal(orderNo, 'LC200')
        return {
          id: 'gid://shopify/Order/200',
          name: orderNo,
          customer_name: 'Alice Example',
          customer_email: 'alice@example.com',
          order_date: '2026-04-20T10:00:00Z',
          order_amount: '120.50',
          currency: 'USD',
          fulfillment_status: 'FULFILLED',
          tracking_numbers: ['TRACK-123'],
          shipped_at: '2026-04-21T09:00:00Z',
          admin_order_url: 'https://lc.example.com/admin/orders/200',
          line_items: [
            {
              sku: 'SKU-1',
              quantity: 1,
              originalUnitPrice: { amount: '120.50', currencyCode: 'USD' },
              originalTotal: { amount: '120.50', currencyCode: 'USD' },
            },
          ],
        }
      },
    }),
  })

  const preview = await service.preview({ config: configPath })
  assert.equal(preview.mode, 'preview')
  assert.equal(preview.summary.source_rows, 1)
  assert.equal(preview.created, 1)
  assert.equal(preview.enrichment_summary.eligible_records, 1)
  assert.equal(preview.enrichment_summary.enriched_records, 1)
  assert.ok(
    preview.diagnostics.some(
      (item) =>
        Array.isArray((item as { backfilled_fields?: string[] }).backfilled_fields) &&
        (item as { backfilled_fields: string[] }).backfilled_fields.includes('客户姓名'),
    ),
  )

  const sync = await service.sync({ config: configPath })
  assert.equal(sync.mode, 'sync')
  assert.equal(sync.created, 1)
  assert.equal(createdRecords.length, 1)
  assert.equal(createdRecords[0]?.['客户姓名'], 'Alice Example')
  assert.equal(createdRecords[0]?.['客户邮箱'], 'alice@example.com')
  assert.equal(createdRecords[0]?.['订单金额'], 120.5)
  assert.equal(createdRecords[0]?.['物流号'], 'TRACK-123')
  assert.equal(createdRecords[0]?.['后台订单链接'], 'https://lc.example.com/admin/orders/200')
  assert.equal(createdRecords[0]?.['SKU金额'], 120.5)

  const statePath = path.join(tmpDir, 'data', 'state.json')
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    source_to_target_ids: Record<string, string[]>
  }
  assert.deepEqual(state.source_to_target_ids['rec-1'], ['target-rec-1'])

  await service.sync({ config: configPath })
  assert.equal(updatedRecords.length, 1)
}

async function testShopifyBackfillOnlyFillsEmptyFields() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)

  const targetFields: FeishuField[] = [
    { field_id: '1', field_name: '订单号', field_type: 1, property: null },
    { field_id: '2', field_name: '记录日期', field_type: 5, property: null },
    { field_id: '3', field_name: '问题处理状态', field_type: 3, property: { options: [{ name: '待处理' }] } },
    { field_id: '4', field_name: '跟进组', field_type: 1, property: null },
    { field_id: '5', field_name: '客户姓名', field_type: 1, property: null },
    { field_id: '6', field_name: '物流状态', field_type: 1, property: null },
    { field_id: '7', field_name: '订单金额', field_type: 2, property: null },
  ]

  const createdRecords: Array<Record<string, unknown>> = []

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return [
          {
            record_id: 'rec-keep',
            fields: {
              记录日期: '2026/04/24',
              订单号: 'LC201',
              具体操作要求: '退款',
              物流状态: '运输途中',
            },
          },
        ]
      },
      async listFields() {
        return targetFields
      },
      async createRecord(_table, fields) {
        createdRecords.push(fields)
        return 'target-rec-keep'
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
    }),
    createShopifyClient: () => ({
      async fetchOrder() {
        return {
          id: 'gid://shopify/Order/201',
          name: 'LC201',
          customer_name: 'Filled Name',
          customer_email: 'filled@example.com',
          order_date: '2026-04-20T10:00:00Z',
          order_amount: '88.00',
          currency: 'USD',
          fulfillment_status: 'UNFULFILLED',
          tracking_numbers: [],
          shipped_at: null,
          admin_order_url: 'https://lc.example.com/admin/orders/201',
          line_items: [
            {
              sku: 'SKU-ONLY',
              quantity: 1,
              originalUnitPrice: { amount: '88.00', currencyCode: 'USD' },
              originalTotal: { amount: '88.00', currencyCode: 'USD' },
            },
          ],
        }
      },
    }),
  })

  await service.sync({ config: configPath })
  assert.equal(createdRecords[0]?.['物流状态'], '运输途中')
  assert.equal(createdRecords[0]?.['客户姓名'], 'Filled Name')
  assert.equal(createdRecords[0]?.['订单金额'], 88)
}

async function testSkuAmountStaysEmptyWhenComplaintSkuMissingOnMultiProductOrder() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)

  const targetFields: FeishuField[] = [
    { field_id: '1', field_name: '订单号', field_type: 1, property: null },
    { field_id: '2', field_name: '记录日期', field_type: 5, property: null },
    { field_id: '3', field_name: '问题处理状态', field_type: 3, property: { options: [{ name: '待处理' }] } },
    { field_id: '4', field_name: '跟进组', field_type: 1, property: null },
    { field_id: '5', field_name: 'SKU金额', field_type: 2, property: null },
  ]

  const createdRecords: Array<Record<string, unknown>> = []

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return [
          {
            record_id: 'rec-multi',
            fields: {
              记录日期: '2026/04/24',
              订单号: 'LC202',
              具体操作要求: '退款',
            },
          },
        ]
      },
      async listFields() {
        return targetFields
      },
      async createRecord(_table, fields) {
        createdRecords.push(fields)
        return 'target-rec-multi'
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
    }),
    createShopifyClient: () => ({
      async fetchOrder() {
        return {
          id: 'gid://shopify/Order/202',
          name: 'LC202',
          customer_name: 'Bob',
          customer_email: 'bob@example.com',
          order_date: '2026-04-20T10:00:00Z',
          order_amount: '150.00',
          currency: 'USD',
          fulfillment_status: 'FULFILLED',
          tracking_numbers: ['TRACK-202'],
          shipped_at: '2026-04-21T09:00:00Z',
          admin_order_url: 'https://lc.example.com/admin/orders/202',
          line_items: [
            {
              sku: 'SKU-A',
              quantity: 1,
              originalUnitPrice: { amount: '50.00', currencyCode: 'USD' },
              originalTotal: { amount: '50.00', currencyCode: 'USD' },
            },
            {
              sku: 'SKU-B',
              quantity: 1,
              originalUnitPrice: { amount: '100.00', currencyCode: 'USD' },
              originalTotal: { amount: '100.00', currencyCode: 'USD' },
            },
          ],
        }
      },
    }),
  })

  const preview = await service.preview({ config: configPath })
  assert.ok(
    preview.diagnostics.some(
      (item) =>
        Array.isArray((item as { skipped_reasons?: string[] }).skipped_reasons) &&
        (item as { skipped_reasons: string[] }).skipped_reasons.includes(
          'sku_amount_requires_complaint_sku_or_single_product_line',
        ),
    ),
  )

  await service.sync({ config: configPath })
  assert.equal(createdRecords[0]?.['SKU金额'], undefined)
}

async function testSyncCsv() {
  const tmpDir = createTempDir()
  const sourcePath = path.join(tmpDir, 'source.csv')
  const targetPath = path.join(tmpDir, 'target.csv')

  fs.writeFileSync(
    sourcePath,
    ['记录日期,订单号,具体操作要求,退款原因分类', '2025/08/19,LC301,"补发1件\nABC-123-M",错漏发'].join('\n'),
  )
  fs.writeFileSync(targetPath, '订单号,记录日期\n')

  const service = new SyncService()
  const result = await service.syncCsv({ source: sourcePath, target: targetPath })

  assert.equal(result.source.rowCount, 1)
  assert.equal(result.summary.source_rows, 1)
  assert.equal(result.samples.length, 1)
}

async function run() {
  testTransformBasicFields()
  testTransformSplitsMultiSkuRows()
  testTransformInfersRefundSolutionAndView()
  testTransformMissingRequiredFields()
  testDateFilters()
  testTimestampDateFilter()
  testDateFilterRejectsMixedModes()
  testSanitizeTargetRecord()
  testResolveShopifySiteKey()
  testShopifyHelpers()
  await testSyncPreviewAndRun()
  await testShopifyBackfillOnlyFillsEmptyFields()
  await testSkuAmountStaysEmptyWhenComplaintSkuMissingOnMultiProductOrder()
  await testSyncCsv()
  console.log('Sync tests passed')
}

await run()
