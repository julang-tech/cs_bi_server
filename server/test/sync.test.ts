import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SyncService, sanitizeTargetRecord } from '../domain/sync/service.js'
import { buildDateFilter, filterRowsByDate, transformSourceRecord } from '../domain/sync/transform.js'
import type { FeishuField, FeishuRecord } from '../integrations/feishu.js'
import { SqliteMirrorRepository, SqliteP3BigQueryCacheRepository } from '../integrations/sqlite.js'
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
      sqlite_path: './data/issues.sqlite',
      refresh_interval_minutes: 120,
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
  assert.equal(preview.sqlite.enabled, false)
  assert.equal(preview.bigquery_cache.enabled, false)
  assert.ok(
    preview.diagnostics.some(
      (item) =>
        Array.isArray((item as { backfilled_fields?: string[] }).backfilled_fields) &&
        (item as { backfilled_fields: string[] }).backfilled_fields.includes('客户姓名'),
    ),
  )

  const sync = await service.syncSourceToTarget({ config: configPath })
  assert.equal(sync.mode, 'source-to-target')
  assert.equal(sync.created, 1)
  assert.equal(sync.sqlite.enabled, false)
  assert.equal(sync.bigquery_cache.enabled, false)
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

  const secondSync = await service.syncSourceToTarget({ config: configPath })
  assert.equal(secondSync.updated, 1)
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

  await service.syncSourceToTarget({ config: configPath })
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

  await service.syncSourceToTarget({ config: configPath })
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

async function testSqliteMirrorDeletesMissingRecords() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const targetFields: FeishuField[] = [
    { field_id: '1', field_name: '订单号', field_type: 1, property: null },
    { field_id: '2', field_name: '记录日期', field_type: 5, property: null },
    { field_id: '3', field_name: '问题处理状态', field_type: 3, property: { options: [{ name: '待处理' }] } },
    { field_id: '4', field_name: '跟进组', field_type: 1, property: null },
  ]

  const sourceRecords: FeishuRecord[] = [
    {
      record_id: 'rec-1',
      fields: {
        记录日期: '2026/04/24',
        订单号: 'LC200',
        具体操作要求: '退款',
      },
    },
    {
      record_id: 'rec-2',
      fields: {
        记录日期: '2026/04/24',
        订单号: 'LC201',
        具体操作要求: '退款',
      },
    },
  ]

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return sourceRecords
      },
      async listFields() {
        return targetFields
      },
      async createRecord(_table, fields) {
        return `target-${String(fields['订单号'])}`
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
    }),
    createShopifyClient: () => null,
  })

  const first = await service.sync({ config: configPath })
  assert.equal(first.sqlite.inserted, 2)

  sourceRecords.pop()

  const second = await service.sync({ config: configPath })
  assert.equal(second.sqlite.deleted, 1)

  const sqliteRepo = new SqliteMirrorRepository(path.join(tmpDir, 'data', 'issues.sqlite'))
  const sqliteRows = sqliteRepo.listActiveRows()
  assert.equal(sqliteRows.length, 1)
  assert.equal(sqliteRows[0]?.source_record_id, 'rec-1')
  sqliteRepo.close()
}

async function testSqliteMirrorRangeSyncDoesNotDeleteMissingRecords() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const targetFields: FeishuField[] = [
    { field_id: '1', field_name: '订单号', field_type: 1, property: null },
    { field_id: '2', field_name: '记录日期', field_type: 5, property: null },
    { field_id: '3', field_name: '问题处理状态', field_type: 3, property: { options: [{ name: '待处理' }] } },
    { field_id: '4', field_name: '跟进组', field_type: 1, property: null },
  ]

  const sourceRecords: FeishuRecord[] = [
    {
      record_id: 'rec-1',
      fields: {
        记录日期: '2026/04/24',
        订单号: 'LC200',
        具体操作要求: '退款',
      },
    },
    {
      record_id: 'rec-2',
      fields: {
        记录日期: '2026/04/25',
        订单号: 'LC201',
        具体操作要求: '退款',
      },
    },
  ]

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return sourceRecords
      },
      async listFields() {
        return targetFields
      },
      async createRecord(_table, fields) {
        return `target-${String(fields['订单号'])}`
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
    }),
    createShopifyClient: () => null,
  })

  const first = await service.sync({ config: configPath })
  assert.equal(first.sqlite.inserted, 2)

  const second = await service.sync({
    config: configPath,
    from: '2026-04-24',
    to: '2026-04-24',
  })
  assert.equal(second.sqlite.deleted, 0)

  const sqliteRepo = new SqliteMirrorRepository(path.join(tmpDir, 'data', 'issues.sqlite'))
  const sqliteRows = sqliteRepo.listActiveRows()
  assert.equal(sqliteRows.length, 2)
  assert.deepEqual(
    sqliteRows.map((row) => row.source_record_id),
    ['rec-1', 'rec-2'],
  )
  sqliteRepo.close()
}

async function testSyncSqliteFailureMarksRunFailed() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const targetFields: FeishuField[] = [
    { field_id: '1', field_name: '订单号', field_type: 1, property: null },
    { field_id: '2', field_name: '记录日期', field_type: 5, property: null },
  ]

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return [
          {
            record_id: 'rec-1',
            fields: {
              记录日期: '2026/04/24',
              订单号: 'LC900',
              具体操作要求: '退款',
            },
          },
        ]
      },
      async listFields() {
        return targetFields
      },
      async createRecord() {
        return 'target-rec-1'
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
    }),
    createShopifyClient: () => null,
    createSqliteRepository: () =>
      ({
        syncRecords() {
          throw new Error('sqlite down')
        },
        close() {},
      }) as unknown as SqliteMirrorRepository,
  })

  const result = await service.sync({ config: configPath })
  assert.equal(result.sqlite.ok, false)
  assert.equal(result.sqlite.sqlite_failed, 1)
  assert.equal(result.failed, 1)
}

async function testSyncTargetToSqliteReadsTargetTable() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const targetRecords: FeishuRecord[] = [
    {
      record_id: 'target-rec-1',
      fields: {
        记录日期: '2026/04/24',
        订单号: 'LC910',
        客诉SKU: 'SKU-910',
        问题处理状态: '处理中',
      },
    },
  ]

  const service = new SyncService({
    createClient: () => ({
      async listRecords(table) {
        assert.equal(table.table_id, 'target-table')
        return targetRecords
      },
      async listFields() {
        throw new Error('target-to-sqlite should not list target fields')
      },
      async createRecord() {
        throw new Error('target-to-sqlite should not create target records')
      },
      async updateRecord() {
        throw new Error('target-to-sqlite should not update target records')
      },
    }),
    createShopifyClient: () => null,
  })

  const result = await service.sync({ config: configPath })
  assert.equal(result.mode, 'sync')
  assert.equal(result.scanned, 1)
  assert.equal(result.sqlite.ok, true)
  assert.equal(result.sqlite.inserted, 1)

  const sqliteRepo = new SqliteMirrorRepository(path.join(tmpDir, 'data', 'issues.sqlite'))
  const sqliteRows = sqliteRepo.listActiveRows()
  assert.equal(sqliteRows.length, 1)
  assert.equal(sqliteRows[0]?.record_id, 'target-rec-1')
  assert.equal(sqliteRows[0]?.source_record_id, 'target-rec-1')
  assert.equal(sqliteRows[0]?.source_record_index, 0)
  assert.equal(sqliteRows[0]?.fields['问题处理状态'], '处理中')
  sqliteRepo.close()
}

async function testSyncTargetToSqlitePrunesMissingTargetRecords() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const targetRecords: FeishuRecord[] = [
    {
      record_id: 'target-rec-1',
      fields: {
        记录日期: '2026/04/24',
        订单号: 'LC910',
      },
    },
    {
      record_id: 'target-rec-2',
      fields: {
        记录日期: '2026/04/25',
        订单号: 'LC911',
      },
    },
  ]

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return targetRecords
      },
      async listFields() {
        return []
      },
      async createRecord() {
        return 'unused'
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
    }),
    createShopifyClient: () => null,
  })

  const first = await service.sync({ config: configPath })
  assert.equal(first.sqlite.inserted, 2)

  targetRecords.pop()
  const second = await service.sync({ config: configPath })
  assert.equal(second.sqlite.deleted, 1)

  const sqliteRepo = new SqliteMirrorRepository(path.join(tmpDir, 'data', 'issues.sqlite'))
  const sqliteRows = sqliteRepo.listActiveRows()
  assert.equal(sqliteRows.length, 1)
  assert.equal(sqliteRows[0]?.record_id, 'target-rec-1')
  sqliteRepo.close()
}

async function testSyncRefreshesBigQueryCache() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  let queryCount = 0

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return []
      },
      async listFields() {
        return []
      },
      async createRecord() {
        return 'unused'
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query(options: unknown) {
        queryCount += 1
        const query = String((options as { query?: string }).query ?? '')
        if (query.includes('dwd_refund_events')) {
          return [[
            { order_no: 'LC700', sku: 'SKU-700', refund_date: '2026-04-12' },
          ]]
        }
        return [[
          {
            order_no: 'LC700',
            processed_date: '2026-04-10',
            sku: 'SKU-700',
            skc: 'SKC-700',
            spu: 'SPU-700',
            quantity: 1,
          },
        ]]
      },
    }),
  })

  const result = await service.sync({ config: configPath })
  assert.equal(result.bigquery_cache.enabled, true)
  assert.equal(result.bigquery_cache.ok, true)
  assert.equal(result.bigquery_cache.order_lines_upserted, 1)
  assert.equal(result.bigquery_cache.refund_events_upserted, 1)
  assert.equal(queryCount, 5)

  const cache = new SqliteP3BigQueryCacheRepository(path.join(tmpDir, 'data', 'issues.sqlite'))
  const summary = await cache.fetchSummary({
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'day',
    date_basis: 'order_date',
  })
  assert.equal(summary.sales_qty, 1)
}

async function testSyncBigQueryCacheFailureDoesNotBlockSqliteMirror() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const targetFields: FeishuField[] = [
    { field_id: '1', field_name: '订单号', field_type: 1, property: null },
    { field_id: '2', field_name: '记录日期', field_type: 5, property: null },
    { field_id: '3', field_name: '问题处理状态', field_type: 3, property: { options: [{ name: '待处理' }] } },
    { field_id: '4', field_name: '跟进组', field_type: 1, property: null },
  ]

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return [
          {
            record_id: 'rec-bq-fail',
            fields: {
              记录日期: '2026/04/24',
              订单号: 'LC901',
              具体操作要求: '退款',
            },
          },
        ]
      },
      async listFields() {
        return targetFields
      },
      async createRecord(_table, fields) {
        return `target-${String(fields['订单号'])}`
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query() {
        throw new Error('bigquery down')
      },
    }),
  })

  const result = await service.sync({ config: configPath })
  assert.equal(result.sqlite.ok, true)
  assert.equal(result.sqlite.inserted, 1)
  assert.equal(result.bigquery_cache.ok, false)
  assert.equal(result.bigquery_cache.failed, 1)
  assert.equal(result.shopify_bi_cache.ok, false)
  assert.equal(result.shopify_bi_cache.failed, 1)
  assert.equal(result.failed, 2)

  const sqliteRepo = new SqliteMirrorRepository(path.join(tmpDir, 'data', 'issues.sqlite'))
  const sqliteRows = sqliteRepo.listActiveRows()
  assert.equal(sqliteRows.length, 1)
  assert.equal(sqliteRows[0]?.source_record_id, 'rec-bq-fail')
  sqliteRepo.close()
}

async function testSyncRefreshesShopifyBiV2Cache() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return []
      },
      async listFields() {
        return []
      },
      async createRecord() {
        return 'unused'
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query(options: unknown) {
        const query = String((options as { query?: string }).query ?? '')
        if (query.includes('int_line_items_classified')) {
          return [[{
            order_id: 'order-v2-1',
            order_no: 'LC800',
            line_key: 'order-v2-1:SKU-800:0',
            sku: 'SKU-800-M',
            skc: 'SKC-800',
            spu: 'SPU-800',
            product_id: 'prod-800',
            variant_id: 'var-800',
            quantity: 1,
            discounted_total_usd: 100,
            is_insurance_item: false,
            is_price_adjustment: false,
            is_shipping_cost: false,
          }]]
        }
        if (query.includes('FROM `julang-dev-database.shopify_dwd.dwd_orders_fact_usd`')) {
          return [[{
            order_id: 'order-v2-1',
            order_no: 'LC800',
            shop_domain: '2vnpww-33.myshopify.com',
            processed_date: '2026-04-10',
            primary_product_type: 'Dress',
            first_published_at_in_order: '2026-03-20',
            is_regular_order: true,
            is_gift_card_order: false,
            gmv_usd: 120,
            revenue_usd: 100,
            net_revenue_usd: 75,
          }]]
        }
        if (query.includes('dwd_refund_events')) {
          return [[{
            refund_id: 'refund-v2-1',
            order_id: 'order-v2-1',
            order_no: 'LC800',
            sku: 'SKU-800-M',
            refund_date: '2026-04-12',
            refund_quantity: 1,
            refund_subtotal_usd: 25,
          }]]
        }
        return [[]]
      },
    }),
  })

  const result = await service.syncTargetToSqlite({ config: configPath })
  const shopifyBiCache = (result as {
    shopify_bi_cache?: {
      enabled: boolean
      ok: boolean
      orders_upserted: number
      order_lines_upserted: number
      refund_events_upserted: number
    }
  }).shopify_bi_cache
  assert.equal(shopifyBiCache?.enabled, true)
  assert.equal(shopifyBiCache?.ok, true)
  assert.equal(shopifyBiCache?.orders_upserted, 1)
  assert.equal(shopifyBiCache?.order_lines_upserted, 1)
  assert.equal(shopifyBiCache?.refund_events_upserted, 1)
}

async function testSyncRefreshesShopifyBiV2CacheForRefundFlowOrders() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  let sawRefundDrivenOrderQuery = false

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return []
      },
      async listFields() {
        return []
      },
      async createRecord() {
        return 'unused'
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query(options: unknown) {
        const query = String((options as { query?: string }).query ?? '')
        if (query.includes('int_line_items_classified')) {
          return [[{
            order_id: 'order-refund-sync',
            order_no: 'LC801',
            line_key: 'order-refund-sync:SKU-801:0',
            sku: 'SKU-801-M',
            skc: 'SKC-801',
            spu: 'SPU-801',
            product_id: 'prod-801',
            variant_id: 'var-801',
            quantity: 1,
            discounted_total_usd: 100,
            is_insurance_item: false,
            is_price_adjustment: false,
            is_shipping_cost: false,
          }]]
        }
        if (query.includes('FROM `julang-dev-database.shopify_dwd.dwd_orders_fact_usd`')) {
          sawRefundDrivenOrderQuery =
            query.includes('processed_date') &&
            query.includes('OR') &&
            query.includes('dwd_refund_events') &&
            query.includes('refund_date')
          return sawRefundDrivenOrderQuery
            ? [[{
                order_id: 'order-refund-sync',
                order_no: 'LC801',
                shop_domain: '2vnpww-33.myshopify.com',
                processed_date: '2026-03-20',
                primary_product_type: 'Dress',
                first_published_at_in_order: '2026-03-01',
                is_regular_order: true,
                is_gift_card_order: false,
                gmv_usd: 120,
                revenue_usd: 100,
                net_revenue_usd: 60,
              }]]
            : [[]]
        }
        if (query.includes('dwd_refund_events')) {
          return [[{
            refund_id: 'refund-sync-1',
            order_id: 'order-refund-sync',
            order_no: 'LC801',
            sku: 'SKU-801-M',
            refund_date: '2026-04-12',
            refund_quantity: 1,
            refund_subtotal_usd: 40,
          }]]
        }
        return [[]]
      },
    }),
  })

  await service.syncTargetToSqlite({ config: configPath })
  assert.equal(sawRefundDrivenOrderQuery, true)

  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(path.join(tmpDir, 'data', 'issues.sqlite'))
  const cards = cache.queryP2Overview({
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'month',
  }).cards
  assert.equal(cards.order_count, 0)
  assert.equal(cards.net_received_amount, 0)
  assert.equal(cards.refund_order_count, 1)
  assert.equal(cards.refund_amount, 40)
  cache.close()
}

async function testShopifyBiCacheCreatesV2TablesWithoutDroppingLegacyCache() {
  const tmpDir = createTempDir()
  const sqlitePath = path.join(tmpDir, 'data', 'issues.sqlite')
  const legacy = new SqliteMirrorRepository(sqlitePath)
  legacy.replaceBigQueryCacheWindow({
    dateFrom: '2026-04-01',
    dateTo: '2026-04-01',
    orderLines: [{
      order_no: 'LC100',
      processed_date: '2026-04-01',
      sku: 'SKU-1',
      skc: 'SKC-1',
      spu: 'SPU-1',
      quantity: 1,
    }],
    refundEvents: [],
  })
  legacy.unsafeDatabaseForTest().exec(`
    CREATE TABLE IF NOT EXISTS shopify_bi_cache_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      ok INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_shopify_bi_cache_runs_scope
    ON shopify_bi_cache_runs(scope);
  `)
  legacy.close()

  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(sqlitePath)
  cache.close()

  const reopened = new SqliteMirrorRepository(sqlitePath)
  assert.equal(reopened.hasBigQueryCacheRows(), true)
  const tables = reopened
    .unsafeDatabaseForTest()
    .prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'shopify_bi_orders',
          'shopify_bi_order_lines',
          'shopify_bi_refund_events',
          'shopify_bi_cache_runs'
        )
      ORDER BY name
    `)
    .all()
    .map((row) => String((row as { name: unknown }).name))
  assert.deepEqual(tables, [
    'shopify_bi_cache_runs',
    'shopify_bi_order_lines',
    'shopify_bi_orders',
    'shopify_bi_refund_events',
  ])
  const cacheRunIndexColumns = reopened
    .unsafeDatabaseForTest()
    .prepare("PRAGMA index_info('idx_shopify_bi_cache_runs_scope')")
    .all()
    .map((row) => String((row as { name: unknown }).name))
  assert.deepEqual(cacheRunIndexColumns, ['scope', 'ok', 'date_from', 'date_to'])
  reopened.close()
}

async function testShopifyBiCacheReplacesDateWindowTransactionally() {
  const tmpDir = createTempDir()
  const sqlitePath = path.join(tmpDir, 'data', 'issues.sqlite')
  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(sqlitePath)

  cache.replaceWindow({
    dateFrom: '2026-04-01',
    dateTo: '2026-04-02',
    orders: [{
      order_id: 'order-1',
      order_no: 'LC100',
      shop_domain: '2vnpww-33.myshopify.com',
      processed_date: '2026-04-01',
      primary_product_type: 'Dress',
      first_published_at_in_order: '2026-03-20',
      is_regular_order: true,
      is_gift_card_order: false,
      gmv_usd: 120,
      revenue_usd: 100,
      net_revenue_usd: 90,
    }],
    orderLines: [{
      order_id: 'order-1',
      order_no: 'LC100',
      line_key: 'order-1:SKU-1:0',
      sku: 'SKU-1-M',
      skc: 'SKU-1',
      spu: 'SKU',
      product_id: 'prod-1',
      variant_id: 'var-1',
      quantity: 2,
      discounted_total_usd: 100,
      is_insurance_item: false,
      is_price_adjustment: false,
      is_shipping_cost: false,
    }],
    refundEvents: [{
      refund_id: 'refund-1',
      order_id: 'order-1',
      order_no: 'LC100',
      sku: 'SKU-1-M',
      refund_date: '2026-04-02',
      refund_quantity: 1,
      refund_subtotal_usd: 50,
    }],
  })

  cache.replaceWindow({
    dateFrom: '2026-04-01',
    dateTo: '2026-04-02',
    orders: [],
    orderLines: [],
    refundEvents: [],
  })

  assert.equal(cache.hasCoverage('2026-04-01', '2026-04-02'), true)
  assert.equal(cache.getGeneration('2026-04-01', '2026-04-02').length > 0, true)
  assert.deepEqual(cache.queryP2Overview({
    date_from: '2026-04-01',
    date_to: '2026-04-02',
    grain: 'month',
  }).cards, {
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
  cache.close()
}

async function testShopifyBiCacheRefundFlowUsesRefundDateWindow() {
  const tmpDir = createTempDir()
  const sqlitePath = path.join(tmpDir, 'data', 'issues.sqlite')
  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(sqlitePath)

  cache.replaceWindow({
    dateFrom: '2026-03-01',
    dateTo: '2026-04-30',
    orders: [{
      order_id: 'order-refund-flow',
      order_no: 'LC200',
      shop_domain: '2vnpww-33.myshopify.com',
      processed_date: '2026-03-20',
      primary_product_type: 'Dress',
      first_published_at_in_order: '2026-03-01',
      is_regular_order: true,
      is_gift_card_order: false,
      gmv_usd: 120,
      revenue_usd: 100,
      net_revenue_usd: 90,
    }],
    orderLines: [{
      order_id: 'order-refund-flow',
      order_no: 'LC200',
      line_key: 'order-refund-flow:SKU-2:0',
      sku: 'SKU-2-M',
      skc: 'SKU-2',
      spu: 'SKU',
      product_id: 'prod-2',
      variant_id: 'var-2',
      quantity: 1,
      discounted_total_usd: 100,
      is_insurance_item: false,
      is_price_adjustment: false,
      is_shipping_cost: false,
    }],
    refundEvents: [{
      refund_id: 'refund-flow-1',
      order_id: 'order-refund-flow',
      order_no: 'LC200',
      sku: 'SKU-2-M',
      refund_date: '2026-04-02',
      refund_quantity: 1,
      refund_subtotal_usd: 50,
    }],
  })

  const cards = cache.queryP2Overview({
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'month',
  }).cards
  assert.equal(cards.order_count, 0)
  assert.equal(cards.net_received_amount, 0)
  assert.equal(cards.refund_order_count, 1)
  assert.equal(cards.refund_amount, 50)
  assert.equal(cards.refund_amount_ratio, 0)
  cache.close()
}

async function testShopifyBiCacheReplaceWindowRollsBackOnInsertFailure() {
  const tmpDir = createTempDir()
  const sqlitePath = path.join(tmpDir, 'data', 'issues.sqlite')
  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(sqlitePath)

  cache.replaceWindow({
    dateFrom: '2026-04-01',
    dateTo: '2026-04-30',
    orders: [{
      order_id: 'order-rollback',
      order_no: 'LC300',
      shop_domain: '2vnpww-33.myshopify.com',
      processed_date: '2026-04-10',
      primary_product_type: 'Dress',
      first_published_at_in_order: '2026-03-01',
      is_regular_order: true,
      is_gift_card_order: false,
      gmv_usd: 120,
      revenue_usd: 100,
      net_revenue_usd: 90,
    }],
    orderLines: [{
      order_id: 'order-rollback',
      order_no: 'LC300',
      line_key: 'order-rollback:SKU-3:0',
      sku: 'SKU-3-M',
      skc: 'SKU-3',
      spu: 'SKU',
      product_id: 'prod-3',
      variant_id: 'var-3',
      quantity: 1,
      discounted_total_usd: 100,
      is_insurance_item: false,
      is_price_adjustment: false,
      is_shipping_cost: false,
    }],
    refundEvents: [],
  })

  assert.throws(() => {
    cache.replaceWindow({
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
      orders: [
        {
          order_id: 'order-rollback-new',
          order_no: null as unknown as string,
          shop_domain: '2vnpww-33.myshopify.com',
          processed_date: '2026-04-10',
          primary_product_type: 'Dress',
          first_published_at_in_order: '2026-03-01',
          is_regular_order: true,
          is_gift_card_order: false,
          gmv_usd: 10,
          revenue_usd: 10,
          net_revenue_usd: 10,
        },
      ],
      orderLines: [],
      refundEvents: [],
    })
  })

  const cards = cache.queryP2Overview({
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'month',
  }).cards
  assert.equal(cards.order_count, 1)
  assert.equal(cards.sales_qty, 1)
  assert.equal(cards.gmv, 120)
  assert.equal(cards.net_received_amount, 100)
  assert.equal(cards.net_revenue_amount, 90)
  cache.close()
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
  await testSqliteMirrorDeletesMissingRecords()
  await testSqliteMirrorRangeSyncDoesNotDeleteMissingRecords()
  await testSyncSqliteFailureMarksRunFailed()
  await testSyncTargetToSqliteReadsTargetTable()
  await testSyncTargetToSqlitePrunesMissingTargetRecords()
  await testSyncRefreshesBigQueryCache()
  await testSyncBigQueryCacheFailureDoesNotBlockSqliteMirror()
  await testSyncRefreshesShopifyBiV2Cache()
  await testSyncRefreshesShopifyBiV2CacheForRefundFlowOrders()
  await testShopifyBiCacheCreatesV2TablesWithoutDroppingLegacyCache()
  await testShopifyBiCacheReplacesDateWindowTransactionally()
  await testShopifyBiCacheRefundFlowUsesRefundDateWindow()
  await testShopifyBiCacheReplaceWindowRollsBackOnInsertFailure()
  console.log('Sync tests passed')
}

await run()
