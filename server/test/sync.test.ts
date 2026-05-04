import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SyncService, sanitizeTargetRecord, type SyncState } from '../domain/sync/service.js'
import {
  buildDateFilter,
  filterRowsByDate,
  inferComplaintTypeFromText,
  inferFollowUpTeam,
  mergeRecordsByOrderAndSku,
  transformSourceRecord,
} from '../domain/sync/transform.js'
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
    备注: '客户反馈物流超期',
  })

  assert.equal(result.errors.length, 0)
  assert.equal(result.records.length, 1)
  const record = result.records[0] as Record<string, unknown>
  assert.equal(record['订单号'], 'LC123')
  assert.equal(record['历史订单数'], '2')
  // View-driven follow-up team: 1-4物流问题 → 物流组 + 财务组
  assert.deepEqual(record['跟进组'], ['物流组', '财务组'])
  // 备注 直传 (no longer prefixed with 退款原因分类)
  assert.equal(record['待跟进客诉备注'], '客户反馈物流超期')
  assert.equal(record['客诉类型'], '物流问题-其他')
  assert.deepEqual(record['客诉方案'], ['全额退款'])
  assert.deepEqual(record['命中视图'], ['1-4待跟进表-物流问题'])
  assert.equal(record['问题处理状态'], '待处理')
  assert.equal(record['客服跟进人'], '张三')
}

function testTransformRefundLogKeepsReturnReceiptFlag() {
  const result = transformSourceRecord('src-return-receipt', {
    记录日期: '2026/01/02',
    订单号: 'LC123-R',
    '是否收到退货/退货单据': '是',
    具体操作要求: '退款',
  })

  assert.equal(result.errors.length, 0)
  const record = result.records[0] as Record<string, unknown>
  assert.equal(record['是否收到退货/退货单据'], '是')
  assert.equal(record['退货单号'], undefined)
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

function testTransformRefundProductProblemMapsToCustomerReason() {
  const result = transformSourceRecord('src-product-problem', {
    记录日期: '2026/01/02',
    订单号: 'LC126',
    退款原因分类: '产品问题',
    具体操作要求: '退款',
  })

  assert.equal(result.errors.length, 0)
  const record = result.records[0] as Record<string, unknown>
  assert.equal(record['客诉类型'], '客户原因-其他')
  assert.deepEqual(record['命中视图'], ['1-1待跟进表-退款'])
  assert.deepEqual(record['跟进组'], ['财务组'])
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
    shipments: [],
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
  assert.equal(inferLogisticsStatusFromShopify('FULFILLED'), null)
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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
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
          shipments: [],
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
  // After multi-source merge state is keyed by `merged:<order>|<sku>` to keep
  // upserts stable across runs even when multiple source rows collapse together.
  assert.deepEqual(state.source_to_target_ids['merged:LC200|SKU-1'], ['target-rec-1'])

  const secondSync = await service.syncSourceToTarget({ config: configPath })
  assert.equal(secondSync.updated, 1)
  assert.equal(updatedRecords.length, 1)
}

async function testSourceToTargetRebuildDeletesTargetAndWritesArtifacts() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  writeJson(path.join(tmpDir, 'data', 'state.json'), {
    source_to_target_ids: {
      'merged:LC200|SKU-1': ['old-target-rec'],
    },
  })

  const targetFields: FeishuField[] = [
    { field_id: '1', field_name: '订单号', field_type: 1, property: null },
    { field_id: '2', field_name: '记录日期', field_type: 5, property: null },
    { field_id: '3', field_name: '问题处理状态', field_type: 3, property: { options: [{ name: '待处理' }] } },
    { field_id: '4', field_name: '跟进组', field_type: 1, property: null },
    { field_id: '5', field_name: '客诉SKU', field_type: 1, property: null },
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
  const targetRecords: FeishuRecord[] = [
    { record_id: 'old-target-rec', fields: { 订单号: 'LC200' } },
    { record_id: 'stale-target-rec', fields: { 订单号: 'LC999' } },
  ]
  const operations: string[] = []

  const service = new SyncService({
    createClient: () => ({
      async listRecords(table) {
        if (table.table_id === 'target-table') return targetRecords
        return sourceRecords
      },
      async listFields() {
        return targetFields
      },
      async createRecord() {
        throw new Error('rebuild should use batchCreateRecords')
      },
      async updateRecord() {
        throw new Error('rebuild must not update old target ids')
      },
      async batchCreateRecords(_table, fieldsList) {
        operations.push(`create:${fieldsList.length}`)
        return fieldsList.map((fields) => `new-${String(fields['订单号'])}-${String(fields['客诉SKU'] ?? '')}`)
      },
      async batchDeleteRecords(_table: SyncConfig['target'], recordIds: string[]) {
        operations.push(`delete:${recordIds.join(',')}`)
      },
    }),
    createShopifyClient: () => null,
  })

  const result = await service.syncSourceToTarget({
    config: configPath,
    rebuildTarget: true,
    rebuildRunId: 'test-run',
    createConcurrency: 2,
    deleteConcurrency: 2,
  })

  assert.equal(result.mode, 'source-to-target-rebuild')
  assert.deepEqual(operations, ['delete:old-target-rec,stale-target-rec', 'create:1'])
  assert.equal(result.created, 1)
  assert.equal(result.deleted, 2)

  const artifactDir = path.join(tmpDir, 'data', 'source-to-target-rebuild', 'test-run')
  assert.ok(fs.existsSync(path.join(artifactDir, 'manifest.json')))
  assert.ok(fs.existsSync(path.join(artifactDir, 'records.jsonl')))
  assert.ok(fs.existsSync(path.join(artifactDir, 'state.next.json')))
  assert.match(fs.readFileSync(path.join(artifactDir, 'records.jsonl'), 'utf8'), /LC200/)

  const state = JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'state.json'), 'utf8')) as SyncState
  assert.deepEqual(state.source_to_target_ids, {
    'merged:LC200|SKU-1': ['new-LC200-SKU-1'],
  })
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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
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
          shipments: [],
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

async function testLiveLogisticsBackfillUsesCarrierStatus() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)

  const targetFields: FeishuField[] = [
    { field_id: '1', field_name: '订单号', field_type: 1, property: null },
    { field_id: '2', field_name: '记录日期', field_type: 5, property: null },
    { field_id: '3', field_name: '问题处理状态', field_type: 3, property: { options: [{ name: '待处理' }] } },
    { field_id: '4', field_name: '跟进组', field_type: 1, property: null },
    { field_id: '5', field_name: '物流状态', field_type: 1, property: null },
    { field_id: '6', field_name: '物流号', field_type: 1, property: null },
  ]

  const createdRecords: Array<Record<string, unknown>> = []

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return [
          {
            record_id: 'rec-live-logistics',
            fields: {
              记录日期: '2026/04/24',
              订单号: 'LC299',
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
        return 'target-rec-live-logistics'
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => ({
      async fetchOrder() {
        return {
          id: 'gid://shopify/Order/299',
          name: 'LC299',
          customer_name: 'Live Logistics',
          customer_email: 'live@example.com',
          order_date: '2026-04-20T10:00:00Z',
          order_amount: '100.00',
          currency: 'USD',
          fulfillment_status: 'FULFILLED',
          tracking_numbers: ['4PX3000000000CN'],
          shipments: [
            {
              id: 'gid://shopify/Fulfillment/299',
              status: 'SUCCESS',
              display_status: 'FULFILLED',
              created_at: '2026-04-21T09:00:00Z',
              tracking: [{ company: '4PX', number: '4PX3000000000CN', url: null }],
            },
          ],
          shipped_at: '2026-04-21T09:00:00Z',
          admin_order_url: 'https://lc.example.com/admin/orders/299',
          line_items: [
            {
              sku: 'SKU-LIVE',
              quantity: 1,
              originalUnitPrice: { amount: '100.00', currencyCode: 'USD' },
              originalTotal: { amount: '100.00', currencyCode: 'USD' },
            },
          ],
        }
      },
    }),
    createLiveLogisticsClient: () => ({
      async queryFpx(input) {
        assert.equal(input.trackingNumber, '4PX3000000000CN')
        return {
          provider: 'fpx',
          lookup_status: 'success',
          logistics_status: 'delivered',
          raw: {},
        }
      },
    }),
  })

  await service.syncSourceToTarget({ config: configPath })
  assert.equal(createdRecords[0]?.['物流号'], '4PX3000000000CN')
  assert.equal(createdRecords[0]?.['物流状态'], '已签收')
}

async function testReceivedGoodsComplaintSkipsLiveLogisticsLookup() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)

  const targetFields: FeishuField[] = [
    { field_id: '1', field_name: '订单号', field_type: 1, property: null },
    { field_id: '2', field_name: '记录日期', field_type: 5, property: null },
    { field_id: '3', field_name: '问题处理状态', field_type: 3, property: { options: [{ name: '待处理' }] } },
    { field_id: '4', field_name: '跟进组', field_type: 1, property: null },
    { field_id: '5', field_name: '客诉类型', field_type: 1, property: null },
    { field_id: '6', field_name: '物流状态', field_type: 1, property: null },
    { field_id: '7', field_name: '物流号', field_type: 1, property: null },
  ]

  const createdRecords: Array<Record<string, unknown>> = []
  let liveLogisticsLookups = 0

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return [
          {
            record_id: 'rec-defect-delivered',
            fields: {
              记录日期: '2026/04/24',
              订单号: 'LC399',
              退款原因分类: '瑕疵问题',
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
        return 'target-rec-defect-delivered'
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => ({
      async fetchOrder() {
        return {
          id: 'gid://shopify/Order/399',
          name: 'LC399',
          customer_name: 'Received Goods',
          customer_email: 'received@example.com',
          order_date: '2026-04-20T10:00:00Z',
          order_amount: '100.00',
          currency: 'USD',
          fulfillment_status: 'FULFILLED',
          tracking_numbers: ['4PX3990000000CN'],
          shipments: [
            {
              id: 'gid://shopify/Fulfillment/399',
              status: 'SUCCESS',
              display_status: 'FULFILLED',
              created_at: '2026-04-21T09:00:00Z',
              tracking: [{ company: '4PX', number: '4PX3990000000CN', url: null }],
            },
          ],
          shipped_at: '2026-04-21T09:00:00Z',
          admin_order_url: 'https://lc.example.com/admin/orders/399',
          line_items: [
            {
              sku: 'SKU-DEFECT',
              quantity: 1,
              originalUnitPrice: { amount: '100.00', currencyCode: 'USD' },
              originalTotal: { amount: '100.00', currencyCode: 'USD' },
            },
          ],
        }
      },
    }),
    createLiveLogisticsClient: () => ({
      async queryFpx() {
        liveLogisticsLookups += 1
        return {
          provider: 'fpx',
          lookup_status: 'success',
          logistics_status: 'transit',
          raw: {},
        }
      },
    }),
  })

  await service.syncSourceToTarget({ config: configPath })
  assert.equal(createdRecords[0]?.['客诉类型'], '货品瑕疵-其他')
  assert.equal(createdRecords[0]?.['物流状态'], '已签收')
  assert.equal(liveLogisticsLookups, 0)
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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
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
          shipments: [],
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

async function testSourceImportDefaultsToCurrentYearFloor() {
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
      record_id: 'rec-2025',
      fields: {
        记录日期: '2025/12/31',
        订单号: 'LC2025',
        具体操作要求: '退款',
      },
    },
    {
      record_id: 'rec-2026',
      fields: {
        记录日期: '2026/01/01',
        订单号: 'LC2026',
        具体操作要求: '退款',
      },
    },
  ]
  const createdRecords: Array<Record<string, unknown>> = []

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return sourceRecords
      },
      async listFields() {
        return targetFields
      },
      async createRecord(_table, fields) {
        createdRecords.push(fields)
        return `target-${String(fields['订单号'])}`
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => null,
  })

  const result = await service.syncSourceToTarget({ config: configPath })
  assert.equal(result.per_source_counts[0]?.source_rows, 1)
  assert.equal(createdRecords.length, 1)
  assert.equal(createdRecords[0]?.['订单号'], 'LC2026')
}

async function testSourceToTargetBackfillsShopifyBiFinancials() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(path.join(tmpDir, 'data', 'issues.sqlite'))
  cache.replaceWindow({
    dateFrom: '2026-01-01',
    dateTo: '2026-01-31',
    orders: [{
      order_id: 'order-financials',
      order_no: 'LC900',
      shop_domain: '2vnpww-33.myshopify.com',
      processed_date: '2026-01-02',
      primary_product_type: 'Dress',
      first_published_at_in_order: '2025-12-01',
      is_regular_order: true,
      is_gift_card_order: false,
      gmv_usd: 180,
      revenue_usd: 160,
      net_revenue_usd: 120,
    }],
    orderLines: [
      {
        order_id: 'order-financials',
        order_no: 'LC900',
        line_key: 'order-financials:SKU-A:0',
        sku: 'SKU-A',
        skc: 'SKU',
        spu: 'SKU',
        product_id: 'prod-a',
        variant_id: 'var-a',
        quantity: 1,
        discounted_total_usd: 70,
        is_insurance_item: false,
        is_price_adjustment: false,
        is_shipping_cost: false,
      },
      {
        order_id: 'order-financials',
        order_no: 'LC900',
        line_key: 'order-financials:SKU-B:0',
        sku: 'SKU-B',
        skc: 'SKU',
        spu: 'SKU',
        product_id: 'prod-b',
        variant_id: 'var-b',
        quantity: 1,
        discounted_total_usd: 90,
        is_insurance_item: false,
        is_price_adjustment: false,
        is_shipping_cost: false,
      },
    ],
    refundEvents: [
      {
        refund_id: 'refund-financials-a',
        order_id: 'order-financials',
        order_no: 'LC900',
        sku: 'SKU-A',
        refund_date: '2026-01-03',
        refund_quantity: 1,
        refund_subtotal_usd: 30,
      },
      {
        refund_id: 'refund-financials-b',
        order_id: 'order-financials',
        order_no: 'LC900',
        sku: 'SKU-B',
        refund_date: '2026-01-04',
        refund_quantity: 1,
        refund_subtotal_usd: 50,
      },
    ],
  })
  cache.close()

  const targetFields: FeishuField[] = [
    { field_id: '1', field_name: '订单号', field_type: 1, property: null },
    { field_id: '2', field_name: '记录日期', field_type: 5, property: null },
    { field_id: '3', field_name: '问题处理状态', field_type: 3, property: { options: [{ name: '待处理' }] } },
    { field_id: '4', field_name: '跟进组', field_type: 1, property: null },
    { field_id: '5', field_name: '客诉SKU', field_type: 1, property: null },
    { field_id: '6', field_name: 'SKU金额', field_type: 2, property: null },
    { field_id: '7', field_name: '订单金额', field_type: 2, property: null },
    { field_id: '8', field_name: 'SKU退款金额', field_type: 2, property: null },
    { field_id: '9', field_name: '订单累计退款', field_type: 2, property: null },
  ]
  const createdRecords: Array<Record<string, unknown>> = []

  const service = new SyncService({
    createClient: () => ({
      async listRecords() {
        return [{
          record_id: 'rec-financials',
          fields: {
            记录日期: '2026/01/05',
            订单号: 'LC900',
            具体操作要求: '退款\nSKU-A',
          },
        }]
      },
      async listFields() {
        return targetFields
      },
      async createRecord(_table, fields) {
        createdRecords.push(fields)
        return 'target-financials'
      },
      async updateRecord(_table, recordId) {
        return recordId
      },
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => ({
      async fetchOrder() {
        return {
          id: 'gid://shopify/Order/900',
          name: 'LC900',
          customer_name: 'Financials',
          customer_email: 'financials@example.com',
          order_date: '2026-01-02T10:00:00Z',
          order_amount: '999.00',
          currency: 'USD',
          fulfillment_status: 'FULFILLED',
          tracking_numbers: [],
          shipments: [],
          shipped_at: null,
          admin_order_url: 'https://lc.example.com/admin/orders/900',
          line_items: [
            {
              sku: 'SKU-A',
              quantity: 1,
              originalUnitPrice: { amount: '999.00', currencyCode: 'USD' },
              originalTotal: { amount: '999.00', currencyCode: 'USD' },
            },
          ],
        }
      },
    }),
  })

  await service.syncSourceToTarget({ config: configPath })
  assert.equal(createdRecords[0]?.['SKU金额'], 70)
  assert.equal(createdRecords[0]?.['订单金额'], 180)
  assert.equal(createdRecords[0]?.['SKU退款金额'], 30)
  assert.equal(createdRecords[0]?.['订单累计退款'], 80)
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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
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

function testSqliteMirrorFullTargetSyncClearsLegacySourceMappings() {
  const tmpDir = createTempDir()
  const sqliteRepo = new SqliteMirrorRepository(path.join(tmpDir, 'data', 'issues.sqlite'))

  sqliteRepo.syncRecords([
    {
      record_id: 'target-rec-legacy',
      source_record_id: 'source-rec-legacy',
      source_record_index: 0,
      synced_at: '2026-04-24T00:00:00.000Z',
      fields: {
        记录日期: '2026/04/24',
        订单号: 'LC912',
      },
    },
  ])

  const result = sqliteRepo.syncRecords([
    {
      record_id: 'target-rec-legacy',
      source_record_id: 'target-rec-legacy',
      source_record_index: 0,
      synced_at: '2026-04-25T00:00:00.000Z',
      fields: {
        记录日期: '2026/04/25',
        订单号: 'LC912',
        问题处理状态: '处理中',
      },
    },
  ])

  assert.equal(result.inserted, 1)
  assert.equal(result.deleted, 1)

  const sqliteRows = sqliteRepo.listActiveRows()
  assert.equal(sqliteRows.length, 1)
  assert.equal(sqliteRows[0]?.record_id, 'target-rec-legacy')
  assert.equal(sqliteRows[0]?.source_record_id, 'target-rec-legacy')
  assert.equal(sqliteRows[0]?.fields['问题处理状态'], '处理中')
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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
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
  assert.equal(queryCount, 6)

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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query(options: unknown) {
        const query = String((options as { query?: string }).query ?? '')
        if (query.includes('MAX(_dbt_updated_at)')) {
          return [[{ data_as_of: '2026-05-04T06:00:00.000Z' }]]
        }
        if (query.includes('int_line_items_classified')) {
          const usesParsedSkuSpu =
            query.includes('parsed_skc AS skc') && query.includes('parsed_spu AS spu')
          return [[{
            order_id: 'order-v2-1',
            order_no: 'LC800',
            line_key: 'order-v2-1:SKU-800:0',
            sku: 'LWS-PT21BK-M',
            skc: usesParsedSkuSpu ? 'LWS-PT21BK' : 'prod-123',
            spu: usesParsedSkuSpu ? 'LWS-PT21BK' : 'prod-123',
            product_id: 'prod-123',
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
  assert.equal(
    (shopifyBiCache as { data_as_of?: string | null } | undefined)?.data_as_of,
    '2026-05-04T06:00:00.000Z',
  )

  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(path.join(tmpDir, 'data', 'issues.sqlite'))
  const table = cache.queryP2SpuTable({
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'month',
  }, 20)
  assert.equal(table.rows[0]?.spu, 'LWS-PT21BK')
  assert.notEqual(table.rows[0]?.spu, 'prod-123')
  const options = cache.queryP2SpuSkcOptions({
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'month',
  }).options
  assert.deepEqual(options.spus, ['LWS-PT21BK'])
  assert.deepEqual(options.skcs, ['LWS-PT21BK'])
  assert.deepEqual(options.pairs, [{ spu: 'LWS-PT21BK', skc: 'LWS-PT21BK' }])
  cache.close()
}

async function testSyncTargetToSqliteCanSkipBigQueryCacheRefreshes() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  let bigQueryCalls = 0

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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query() {
        bigQueryCalls += 1
        return [[]]
      },
    }),
  })

  const result = await service.syncTargetToSqlite({
    config: configPath,
    refreshBigQueryCache: false,
  })

  assert.equal(bigQueryCalls, 0)
  assert.equal(result.bigquery_cache.enabled, false)
  assert.equal(result.bigquery_cache.ok, true)
  assert.equal(result.shopify_bi_cache.enabled, false)
  assert.equal(result.shopify_bi_cache.ok, true)
}

async function testSyncShopifyBiCacheIfDueRefreshesWhenWindowCovered() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(path.join(tmpDir, 'data', 'issues.sqlite'))
  cache.replaceWindow({
    dateFrom: '2000-01-01',
    dateTo: '2999-12-31',
    orders: [],
    orderLines: [],
    refundEvents: [],
  })
  cache.close()
  let bigQueryCalls = 0

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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query() {
        bigQueryCalls += 1
        return [[]]
      },
    }),
  })

  const result = await service.syncShopifyBiCacheIfDue({ config: configPath })

  assert.equal(bigQueryCalls, 4)
  assert.equal(result.enabled, true)
  assert.equal(result.ok, true)
  assert.equal(result.skipped, false)
  assert.equal(result.failed, 0)
}

async function testSyncShopifyBiCacheIfDueReturnsFailureWhenCoverageCheckFails() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    runtime: { sqlite_path: string }
  }
  config.runtime.sqlite_path = './data'
  writeJson(configPath, config)

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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query() {
        return [[]]
      },
    }),
  })

  const result = await service.syncShopifyBiCacheIfDue({ config: configPath })

  assert.equal(result.enabled, true)
  assert.equal(result.ok, false)
  assert.equal(result.skipped, false)
  assert.equal(result.failed, 1)
  assert.match(String(result.error ?? ''), /directory|database|open/i)
}

async function testSyncShopifyBiCacheIfDueRefreshesWhenWindowMissing() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  let bigQueryCalls = 0

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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query(options: unknown) {
        bigQueryCalls += 1
        const query = String((options as { query?: string }).query ?? '')
        if (query.includes('int_line_items_classified')) {
          return [[{
            order_id: 'order-due-1',
            order_no: 'LC900',
            line_key: 'order-due-1:line-1',
            sku: 'SKU-900-M',
            skc: 'SKC-900',
            spu: 'SPU-900',
            product_id: 'prod-900',
            variant_id: 'var-900',
            quantity: 1,
            discounted_total_usd: 100,
            is_insurance_item: false,
            is_price_adjustment: false,
            is_shipping_cost: false,
          }]]
        }
        if (query.includes('FROM `julang-dev-database.shopify_dwd.dwd_orders_fact_usd`')) {
          return [[{
            order_id: 'order-due-1',
            order_no: 'LC900',
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
            refund_id: 'refund-due-1',
            order_id: 'order-due-1',
            order_no: 'LC900',
            sku: 'SKU-900-M',
            refund_date: '2026-04-12',
            refund_quantity: 1,
            refund_subtotal_usd: 25,
          }]]
        }
        return [[]]
      },
    }),
  })

  const result = await service.syncShopifyBiCacheIfDue({ config: configPath })

  assert.equal(bigQueryCalls, 4)
  assert.equal(result.enabled, true)
  assert.equal(result.ok, true)
  assert.equal(result.skipped, false)
  assert.equal(result.orders_upserted, 1)
  assert.equal(result.order_lines_upserted, 1)
  assert.equal(result.refund_events_upserted, 1)
}

async function testSyncRefreshesShopifyBiV2CacheForRefundFlowOrders() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  let sawRefundDrivenOrderQuery = false
  let sawRefundDrivenOrderLineQuery = false

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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query(options: unknown) {
        const query = String((options as { query?: string }).query ?? '')
        if (query.includes('int_line_items_classified')) {
          sawRefundDrivenOrderLineQuery =
            query.includes('dwd_refund_events') &&
            /refund_date\s+BETWEEN\s+DATE\(@date_from\)\s+AND\s+DATE\(@date_to\)/.test(query)
          return sawRefundDrivenOrderLineQuery
            ? [[{
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
            : [[]]
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
  assert.equal(sawRefundDrivenOrderLineQuery, true)

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
  const skcFilteredCards = cache.queryP2Overview({
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'month',
    skc: 'SKC-801',
  }).cards
  assert.equal(skcFilteredCards.order_count, 0)
  assert.equal(skcFilteredCards.net_received_amount, 0)
  assert.equal(skcFilteredCards.refund_order_count, 1)
  assert.equal(skcFilteredCards.refund_amount, 40)
  cache.close()
}

async function testSyncShopifyBiV2CacheKeysRefundEventsByRefundLine() {
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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query(options: unknown) {
        const query = String((options as { query?: string }).query ?? '')
        if (query.includes('int_line_items_classified')) {
          return [[{
            order_id: 'order-refund-lines',
            order_no: 'LC802',
            line_key: 'order-refund-lines:line-1',
            sku: 'SKU-802-M',
            skc: 'SKC-802',
            spu: 'SPU-802',
            product_id: 'prod-802',
            variant_id: 'var-802',
            quantity: 1,
            discounted_total_usd: 100,
            is_insurance_item: false,
            is_price_adjustment: false,
            is_shipping_cost: false,
          }]]
        }
        if (query.includes('FROM `julang-dev-database.shopify_dwd.dwd_orders_fact_usd`')) {
          return [[{
            order_id: 'order-refund-lines',
            order_no: 'LC802',
            shop_domain: '2vnpww-33.myshopify.com',
            processed_date: '2026-04-10',
            primary_product_type: 'Dress',
            first_published_at_in_order: '2026-03-20',
            is_regular_order: true,
            is_gift_card_order: false,
            gmv_usd: 120,
            revenue_usd: 100,
            net_revenue_usd: 50,
          }]]
        }
        if (query.includes('dwd_refund_events')) {
          return [[
            {
              refund_id: 'gid://shopify/Refund/802',
              line_item_id: 'gid://shopify/LineItem/802-1',
              order_id: 'order-refund-lines',
              order_no: 'LC802',
              sku: 'SKU-802-M',
              refund_date: '2026-04-12',
              refund_quantity: 1,
              refund_subtotal_usd: 20,
            },
            {
              refund_id: 'gid://shopify/Refund/802',
              line_item_id: 'gid://shopify/LineItem/802-2',
              order_id: 'order-refund-lines',
              order_no: 'LC802',
              sku: 'SKU-802-L',
              refund_date: '2026-04-12',
              refund_quantity: 1,
              refund_subtotal_usd: 30,
            },
          ]]
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
      refund_events_upserted: number
      error?: string
    }
  }).shopify_bi_cache
  assert.equal(shopifyBiCache?.enabled, true)
  assert.equal(shopifyBiCache?.ok, true, shopifyBiCache?.error)
  assert.equal(shopifyBiCache?.refund_events_upserted, 2)

  const sqliteRepo = new SqliteMirrorRepository(path.join(tmpDir, 'data', 'issues.sqlite'))
  const rows = sqliteRepo
    .unsafeDatabaseForTest()
    .prepare('SELECT refund_id, sku FROM shopify_bi_refund_events ORDER BY sku')
    .all()
  assert.equal(rows.length, 2)
  assert.notEqual(
    String((rows[0] as { refund_id: unknown }).refund_id),
    String((rows[1] as { refund_id: unknown }).refund_id),
  )
  sqliteRepo.close()
}

async function testSyncShopifyBiCacheQueriesUseStableSourceIds() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const queries: string[] = []

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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query(options: unknown) {
        queries.push(String((options as { query?: string }).query ?? ''))
        return [[]]
      },
    }),
  })

  await service.syncTargetToSqlite({ config: configPath })

  const orderLineQuery = queries.find((query) => query.includes('int_line_items_classified')) ?? ''
  assert.match(orderLineQuery, /line_item_id|JSON_VALUE\(TO_JSON_STRING\(li\), '\$\.line_item_id'\)/)
  assert.match(orderLineQuery, /TO_HEX\(SHA256\(/)
  assert.doesNotMatch(orderLineQuery, /ROW_NUMBER\(\) OVER \(PARTITION BY li\.order_id ORDER BY li\.sku, li\.variant_id, li\.product_id\)/)

  const shopifyBiRefundQuery =
    queries.find(
      (query) =>
        query.includes('FROM `julang-dev-database.shopify_dwd.dwd_refund_events` re') &&
        query.includes('shopify_dwd.dwd_orders_fact_usd') &&
        query.includes('CAST(re.refund_date AS STRING) AS refund_date') &&
        query.includes('refund_subtotal_usd'),
    ) ?? ''
  assert.match(
    shopifyBiRefundQuery,
    /TO_HEX\(SHA256\(CONCAT\([\s\S]*COALESCE\(CAST\(re\.refund_id AS STRING\), ''\)[\s\S]*COALESCE\(CAST\(re\.line_item_id AS STRING\), ''\)[\s\S]*\)\)\) AS refund_id/,
  )
  assert.doesNotMatch(shopifyBiRefundQuery, /JSON_VALUE\(TO_JSON_STRING\(re\), '\$\.refund_id'\)/)
  assert.doesNotMatch(shopifyBiRefundQuery, /ROW_NUMBER\(\) OVER \(PARTITION BY re\.order_id, re\.sku, re\.refund_date ORDER BY re\.refund_subtotal\)/)
}

async function testSyncLegacyRefundCacheJoinsOrdersForOrderName() {
  const tmpDir = createTempDir()
  const configPath = createConfig(tmpDir)
  const queries: string[] = []

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
      async batchCreateRecords(_table, fieldsList) {
        const ids = []
        for (const fields of fieldsList) {
          const id = await this.createRecord(_table, fields)
          ids.push(id)
        }
        return ids
      },
    }),
    createShopifyClient: () => null,
    createBigQueryClient: () => ({
      async query(options: unknown) {
        queries.push(String((options as { query?: string }).query ?? ''))
        return [[]]
      },
    }),
  })

  await service.syncTargetToSqlite({ config: configPath })

  const legacyRefundQuery =
    queries.find(
      (query) =>
        query.includes('shopify_dwd.dwd_refund_events') &&
        query.includes('shopify_dwd.dwd_orders_fact`'),
    ) ?? ''
  assert.match(legacyRefundQuery, /FROM `julang-dev-database\.shopify_dwd\.dwd_refund_events` re/)
  assert.match(legacyRefundQuery, /JOIN `julang-dev-database\.shopify_dwd\.dwd_orders_fact` o/)
  assert.match(legacyRefundQuery, /o\.order_name AS order_no/)
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

async function testShopifyBiCacheStoresDataAsOf() {
  const tmpDir = createTempDir()
  const sqlitePath = path.join(tmpDir, 'data', 'issues.sqlite')
  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(sqlitePath)

  cache.replaceWindow({
    dateFrom: '2026-05-04',
    dateTo: '2026-05-04',
    dataAsOf: '2026-05-04T06:00:00.000Z',
    orders: [],
    orderLines: [],
    refundEvents: [],
  })

  assert.equal(
    cache.getDataAsOf('2026-05-04', '2026-05-04'),
    '2026-05-04T06:00:00.000Z',
  )
  cache.close()
}

async function testShopifyBiCacheFallsBackDataAsOfToFinishedAt() {
  const tmpDir = createTempDir()
  const sqlitePath = path.join(tmpDir, 'data', 'issues.sqlite')
  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(sqlitePath)

  cache.replaceWindow({
    dateFrom: '2026-05-04',
    dateTo: '2026-05-04',
    orders: [],
    orderLines: [],
    refundEvents: [],
  })

  assert.match(
    cache.getDataAsOf('2026-05-04', '2026-05-04') ?? '',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  )
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

async function testShopifyBiCacheReplaceWindowRemovesStaleRefundDrivenOrderLines() {
  const tmpDir = createTempDir()
  const sqlitePath = path.join(tmpDir, 'data', 'issues.sqlite')
  const { SqliteShopifyBiCacheRepository } = await import('../integrations/shopify-bi-cache.js')
  const cache = new SqliteShopifyBiCacheRepository(sqlitePath)

  const order = {
    order_id: 'order-stale-lines',
    order_no: 'LC250',
    shop_domain: '2vnpww-33.myshopify.com',
    processed_date: '2026-03-20',
    primary_product_type: 'Dress',
    first_published_at_in_order: '2026-03-01',
    is_regular_order: true,
    is_gift_card_order: false,
    gmv_usd: 120,
    revenue_usd: 100,
    net_revenue_usd: 90,
  }
  const refundEvent = {
    refund_id: 'refund-stale-lines',
    order_id: 'order-stale-lines',
    order_no: 'LC250',
    sku: 'SKU-NEW-M',
    refund_date: '2026-04-02',
    refund_quantity: 1,
    refund_subtotal_usd: 50,
  }

  cache.replaceWindow({
    dateFrom: '2026-04-01',
    dateTo: '2026-04-30',
    orders: [order],
    orderLines: [
      {
        order_id: 'order-stale-lines',
        order_no: 'LC250',
        line_key: 'order-stale-lines:old',
        sku: 'SKU-OLD-M',
        skc: 'OLD-SKC',
        spu: 'OLD',
        product_id: 'prod-old',
        variant_id: 'var-old',
        quantity: 1,
        discounted_total_usd: 20,
        is_insurance_item: false,
        is_price_adjustment: false,
        is_shipping_cost: false,
      },
      {
        order_id: 'order-stale-lines',
        order_no: 'LC250',
        line_key: 'order-stale-lines:new',
        sku: 'SKU-NEW-M',
        skc: 'NEW-SKC',
        spu: 'NEW',
        product_id: 'prod-new',
        variant_id: 'var-new',
        quantity: 1,
        discounted_total_usd: 100,
        is_insurance_item: false,
        is_price_adjustment: false,
        is_shipping_cost: false,
      },
    ],
    refundEvents: [refundEvent],
  })

  cache.replaceWindow({
    dateFrom: '2026-04-01',
    dateTo: '2026-04-30',
    orders: [order],
    orderLines: [{
      order_id: 'order-stale-lines',
      order_no: 'LC250',
      line_key: 'order-stale-lines:new',
      sku: 'SKU-NEW-M',
      skc: 'NEW-SKC',
      spu: 'NEW',
      product_id: 'prod-new',
      variant_id: 'var-new',
      quantity: 1,
      discounted_total_usd: 100,
      is_insurance_item: false,
      is_price_adjustment: false,
      is_shipping_cost: false,
    }],
    refundEvents: [refundEvent],
  })

  const oldSkcCards = cache.queryP2Overview({
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'month',
    skc: 'OLD-SKC',
  }).cards
  assert.equal(oldSkcCards.refund_order_count, 0)
  assert.equal(oldSkcCards.refund_amount, 0)

  const newSkcCards = cache.queryP2Overview({
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'month',
    skc: 'NEW-SKC',
  }).cards
  assert.equal(newSkcCards.refund_order_count, 1)
  assert.equal(newSkcCards.refund_amount, 50)
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

// ===== Per-source transformer happy-path tests =====

function testTransformRefundLogFallbacks() {
  // Unknown 退款原因分类 → fallback complaint type + fallback view (1-1)
  const result = transformSourceRecord(
    'src-refund-fallback',
    {
      记录日期: '2026/05/01',
      订单号: 'LC400',
      退款原因分类: '其他',
      具体操作要求: '退款',
      备注: '客户表示款式不合心意',
    },
    'refund_log',
  )
  assert.equal(result.errors.length, 0)
  const record = result.records[0] as Record<string, unknown>
  assert.equal(record['客诉类型'], '客户原因-其他')
  assert.deepEqual(record['命中视图'], ['1-1待跟进表-退款'])
  // refund (1-1) → 财务组
  assert.deepEqual(record['跟进组'], ['财务组'])
  assert.equal(record['待跟进客诉备注'], '客户表示款式不合心意')
}

function testTransformReissue6Usd() {
  const result = transformSourceRecord(
    'src-reissue-1',
    {
      原订单号: 'LC401',
      日期: '2026/05/01',
      客户姓名: 'Alice',
      客诉SKU: 'LWS-ORIGINAL-BK-M',
      需补发SKU: 'LWS-PT21BK-M',
      补发订单号: 'LC401-RE',
      客诉原因: ['poor fit', 'Size too large'],
      备注: '客户愿意等补发',
      创建人: '李四',
    },
    'reissue_6usd',
  )
  assert.equal(result.errors.length, 0)
  const record = result.records[0] as Record<string, unknown>
  assert.equal(record['订单号'], 'LC401')
  assert.equal(record['客诉SKU'], 'LWS-ORIGINAL-BK-M')
  assert.equal(record['补发订单号'], 'LC401-RE')
  assert.equal(record['具体金额/操作要求'], '需补发SKU：LWS-PT21BK-M')
  assert.deepEqual(record['客诉方案'], ['6美元补发'])
  assert.deepEqual(record['命中视图'], ['1-5待跟进表-补发'])
  assert.deepEqual(record['跟进组'], ['仓库组'])
  assert.equal(record['客诉类型'], '客户原因-尺码不合适')
  assert.equal(record['客服跟进人'], '李四')
  assert.match(String(record['待跟进客诉备注'] ?? ''), /poor fit/)
  assert.match(String(record['待跟进客诉备注'] ?? ''), /客户愿意等补发/)
}

function testTransformReissue6UsdSplitsMultiSkuField() {
  const result = transformSourceRecord(
    'src-reissue-multi',
    {
      原订单号: 'LC401',
      日期: '2026/05/01',
      客诉SKU: 'LWS-PT21BK-M\nLWS-PT21TBL-M',
      需补发SKU: 'LWS-REISSUE-BK-M',
      客诉原因: ['poor fit'],
    },
    'reissue_6usd',
  )

  assert.equal(result.errors.length, 0)
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0]?.['客诉SKU'], 'LWS-PT21BK-M')
  assert.equal(result.records[1]?.['客诉SKU'], 'LWS-PT21TBL-M')
  assert.deepEqual(result.records[0]?.['客诉方案'], ['6美元补发'])
  assert.equal(result.records[0]?.['具体金额/操作要求'], '需补发SKU：LWS-REISSUE-BK-M')
}

function testTransformManualReturn() {
  const result = transformSourceRecord(
    'src-manual-1',
    {
      订单号: 'LC402',
      记录日期: '2026/05/02',
      客诉SKU: 'LWS-PT21BK-L',
      客诉原因: ['style', 'don\'t like color'],
      方案: ['代金券', '补发'],
      备注: '实际原因：it arrived too late',
    },
    'manual_return',
  )
  assert.equal(result.errors.length, 0)
  const record = result.records[0] as Record<string, unknown>
  assert.deepEqual(record['命中视图'], ['1-1待跟进表-退款'])
  assert.deepEqual(record['客诉方案'], ['代金券', '补发'])
  assert.deepEqual(record['跟进组'], ['财务组'])
  assert.equal(record['客诉类型'], '客户原因-款式不喜欢')
  assert.equal(record['客诉SKU'], 'LWS-PT21BK-L')
  assert.match(String(record['待跟进客诉备注'] ?? ''), /it arrived too late/)
}

function testTransformManualReturnSplitsMultiSkuField() {
  const result = transformSourceRecord(
    'src-manual-multi',
    {
      订单号: 'LC402',
      记录日期: '2026/05/02',
      客诉SKU: 'LWS-PT21BK-L\nLWS-PT21TBL-L',
      客诉原因: ['style'],
    },
    'manual_return',
  )

  assert.equal(result.errors.length, 0)
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0]?.['客诉SKU'], 'LWS-PT21BK-L')
  assert.equal(result.records[1]?.['客诉SKU'], 'LWS-PT21TBL-L')
}

function testTransformDefectFeedback() {
  const result = transformSourceRecord(
    'src-defect-1',
    {
      订单号: 'LC403',
      反馈日期: '2026/05/03',
      产品sku: 'LWS-DF21BK-M',
      瑕疵说明: '收到时领口缝线开线了',
      照片核实: [{ file_token: 'file-defect-1', name: 'defect.jpg' }],
      协商方案: '接受120%代金券',
      反馈人: '王五',
    },
    'defect_feedback',
  )
  assert.equal(result.errors.length, 0)
  const record = result.records[0] as Record<string, unknown>
  assert.deepEqual(record['命中视图'], ['1-3待跟进表-货品瑕疵'])
  assert.deepEqual(record['客诉方案'], ['代金券'])
  assert.deepEqual(record['跟进组'], ['采购组', 'OEM组', '商品组', '财务组'])
  assert.equal(record['客诉类型'], '货品瑕疵-缝线问题')
  assert.equal(record['客诉SKU'], 'LWS-DF21BK-M')
  assert.match(String(record['待跟进客诉备注'] ?? ''), /缝线/)
  assert.match(String(record['待跟进客诉备注'] ?? ''), /协商方案：接受120%代金券/)
  assert.deepEqual(record['退货/瑕疵凭证原图'], [{ file_token: 'file-defect-1', name: 'defect.jpg' }])
  assert.equal(record['客服跟进人'], '王五')
}

function testTransformDefectFeedbackSplitsByShopifySkuWhenItemCountMatches() {
  const result = transformSourceRecord(
    'src-defect-count',
    {
      订单号: 'LC403',
      反馈日期: '2026/05/03',
      瑕疵说明: '2件都有破洞',
    },
    'defect_feedback',
    {
      lookupOrderSkus: (orderNo) => {
        assert.equal(orderNo, 'LC403')
        return ['LWS-DF21BK-M', 'LWS-DF21TBL-M']
      },
    },
  )

  assert.equal(result.errors.length, 0)
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0]?.['客诉SKU'], 'LWS-DF21BK-M')
  assert.equal(result.records[1]?.['客诉SKU'], 'LWS-DF21TBL-M')
}

function testTransformWrongSendFeedback() {
  const result = transformSourceRecord(
    'src-wrong-1',
    {
      订单号: 'LC404',
      反馈日期: '2026/05/04',
      产品sku: 'LWS-WR21BK-M',
      错发说明: '客户漏发了一件外套',
      '照片核实 (1)': [{ file_token: 'file-wrong-1', name: 'wrong.jpg' }],
      协商方案: '客户要求退款',
      反馈人: '赵六',
    },
    'wrong_send_feedback',
  )
  assert.equal(result.errors.length, 0)
  const record = result.records[0] as Record<string, unknown>
  assert.deepEqual(record['命中视图'], ['1-2待跟进表-漏发、发错'])
  assert.deepEqual(record['客诉方案'], ['全额退款'])
  assert.deepEqual(record['跟进组'], ['仓库组'])
  assert.equal(record['客诉类型'], '仓库-漏发')
  assert.equal(record['客诉SKU'], 'LWS-WR21BK-M')
  assert.match(String(record['待跟进客诉备注'] ?? ''), /协商方案：客户要求退款/)
  assert.deepEqual(record['退货/瑕疵凭证原图'], [{ file_token: 'file-wrong-1', name: 'wrong.jpg' }])
}

function testTransformWrongSendFeedbackFillsSingleShopifySku() {
  const result = transformSourceRecord(
    'src-wrong-single',
    {
      订单号: 'LC404',
      反馈日期: '2026/05/04',
      错发说明: '客户反馈漏发',
    },
    'wrong_send_feedback',
    {
      lookupOrderSkus: (orderNo) => {
        assert.equal(orderNo, 'LC404')
        return ['LWS-WR21BK-M']
      },
    },
  )

  assert.equal(result.errors.length, 0)
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0]?.['客诉SKU'], 'LWS-WR21BK-M')
}

function testTransformLogisticsIssueWithSkuLookup() {
  const result = transformSourceRecord(
    'src-logistics-1',
    {
      订单号: 'LC405',
      日期: '2026/05/05',
      物流号: 'TRK-405',
      物流问题: '包裹超期未送达',
      跟进1: '已联系承运商',
      跟进2: '承运商表示已重新派送',
      状态: ['已妥投', '重点关注'],
    },
    'logistics_issue',
    {
      sourceName: '物流问题',
      lookupOrderSkus: (orderNo) => {
        assert.equal(orderNo, 'LC405')
        return ['LWS-LG21BK-M', 'LWS-LG21BK-L']
      },
    },
  )
  assert.equal(result.errors.length, 0)
  // Logistics rows are order/package-level events; Shopify SKU lookup must not fan out.
  assert.equal(result.records.length, 1)
  const record = result.records[0] as Record<string, unknown>
  assert.deepEqual(record['命中视图'], ['1-4待跟进表-物流问题'])
  assert.deepEqual(record['跟进组'], ['物流组', '财务组'])
  assert.equal(record['客诉类型'], '物流问题-超期')
  assert.equal(record['物流号'], 'TRK-405')
  assert.equal(record['待跟进客诉备注'], '包裹超期未送达')
  assert.match(String(record['物流-跟进过程'] ?? ''), /已联系承运商/)
  assert.match(String(record['物流-跟进过程'] ?? ''), /重新派送/)
  assert.equal(record['物流-跟进结果'], '已妥投, 重点关注')
  assert.equal(record['客诉SKU'], undefined)
}

function testTransformLogisticsIssueSkipsRowsWithoutOrderNo() {
  const result = transformSourceRecord(
    'src-logistics-2',
    {
      日期: '2026/05/05',
      物流号: 'TRK-NO-ORDER',
      物流问题: '包裹丢失',
    },
    'logistics_issue',
  )
  assert.equal(result.records.length, 0)
  assert.match(result.errors[0] ?? '', /订单号/)
}

// ===== inferComplaintTypeFromText / inferFollowUpTeam =====

function testInferComplaintTypeFromText() {
  // Customer-reason inference (no view)
  assert.equal(inferComplaintTypeFromText('size too large'), '客户原因-尺码不合适')
  assert.equal(inferComplaintTypeFromText('don\'t like the style'), '客户原因-款式不喜欢')
  assert.equal(inferComplaintTypeFromText('颜色不喜欢'), '客户原因-款式不喜欢')
  assert.equal(inferComplaintTypeFromText(''), '客户原因-尺码不合适')

  // Logistics view
  assert.equal(inferComplaintTypeFromText('包裹超期', '1-4待跟进表-物流问题'), '物流问题-超期')
  assert.equal(inferComplaintTypeFromText('包裹丢了', '1-4待跟进表-物流问题'), '物流问题-丢包')
  assert.equal(inferComplaintTypeFromText('地址写错了', '1-4待跟进表-物流问题'), '物流问题-派发错地址')
  assert.equal(inferComplaintTypeFromText('其他原因', '1-4待跟进表-物流问题'), '物流问题-其他')

  // Defect view
  assert.equal(inferComplaintTypeFromText('缝线开了', '1-3待跟进表-货品瑕疵'), '货品瑕疵-缝线问题')
  assert.equal(inferComplaintTypeFromText('破洞', '1-3待跟进表-货品瑕疵'), '货品瑕疵-有破洞')
  assert.equal(inferComplaintTypeFromText('色差严重', '1-3待跟进表-货品瑕疵'), '货品瑕疵-色差')
  assert.equal(inferComplaintTypeFromText('扣子掉了', '1-3待跟进表-货品瑕疵'), '货品瑕疵-扣子问题')
  assert.equal(inferComplaintTypeFromText('未知', '1-3待跟进表-货品瑕疵'), '货品瑕疵-其他')

  // Wrong-send view
  assert.equal(inferComplaintTypeFromText('漏发', '1-2待跟进表-漏发、发错'), '仓库-漏发')
  assert.equal(inferComplaintTypeFromText('发错了款式', '1-2待跟进表-漏发、发错'), '仓库-发错SKU')
}

function testInferFollowUpTeam() {
  assert.deepEqual(inferFollowUpTeam(['1-1待跟进表-退款']), ['财务组'])
  assert.deepEqual(inferFollowUpTeam(['1-2待跟进表-漏发、发错']), ['仓库组'])
  assert.deepEqual(inferFollowUpTeam(['1-3待跟进表-货品瑕疵']), [
    '采购组',
    'OEM组',
    '商品组',
    '财务组',
  ])
  assert.deepEqual(inferFollowUpTeam(['1-4待跟进表-物流问题']), ['物流组', '财务组'])
  assert.deepEqual(inferFollowUpTeam(['1-5待跟进表-补发']), ['仓库组'])
  // Multi-view union, dedupe
  assert.deepEqual(
    inferFollowUpTeam(['1-3待跟进表-货品瑕疵', '1-4待跟进表-物流问题']),
    ['采购组', 'OEM组', '商品组', '财务组', '物流组'],
  )
  // Unknown view → fallback
  assert.deepEqual(inferFollowUpTeam([]), ['客服组'])
  assert.deepEqual(inferFollowUpTeam(['unknown-view']), ['客服组'])
}

// ===== merge tests =====

function testMergeNoOverlapPassThrough() {
  const merged = mergeRecordsByOrderAndSku([
    {
      sourceName: '退款登记',
      transformerKind: 'refund_log',
      record: { 订单号: 'LC500', 客诉SKU: 'A', 客诉类型: '客户原因-尺码不合适' },
    },
    {
      sourceName: '瑕疵反馈',
      transformerKind: 'defect_feedback',
      record: { 订单号: 'LC501', 客诉SKU: 'B', 客诉类型: '货品瑕疵-缝线' },
    },
  ])
  assert.equal(merged.length, 2)
  assert.equal(merged[0]['客诉类型'], '客户原因-尺码不合适')
  assert.equal(merged[1]['客诉类型'], '货品瑕疵-缝线')
}

function testMergeMultiSelectUnion() {
  const merged = mergeRecordsByOrderAndSku([
    {
      sourceName: '退款登记',
      transformerKind: 'refund_log',
      record: {
        订单号: 'LC600',
        客诉SKU: 'A',
        命中视图: ['1-1待跟进表-退款'],
        客诉方案: ['部分退款'],
        跟进组: ['财务组'],
      },
    },
    {
      sourceName: '瑕疵反馈',
      transformerKind: 'defect_feedback',
      record: {
        订单号: 'LC600',
        客诉SKU: 'A',
        命中视图: ['1-3待跟进表-货品瑕疵'],
        客诉方案: ['补发'],
        跟进组: ['采购组', 'OEM组', '商品组', '财务组'],
      },
    },
  ])
  assert.equal(merged.length, 1)
  const m = merged[0]
  assert.deepEqual(m['命中视图'], ['1-1待跟进表-退款', '1-3待跟进表-货品瑕疵'])
  assert.deepEqual(m['客诉方案'], ['部分退款', '补发'])
  // 财务组 deduped
  assert.deepEqual(m['跟进组'], ['财务组', '采购组', 'OEM组', '商品组'])
}

function testMergeComplaintTypeNonRefundLogWins() {
  const merged = mergeRecordsByOrderAndSku([
    {
      sourceName: '退款登记',
      transformerKind: 'refund_log',
      record: {
        订单号: 'LC700',
        客诉SKU: 'A',
        客诉类型: '客户原因-尺码不合适',
        待跟进客诉备注: '客户说尺码不合适',
      },
    },
    {
      sourceName: '瑕疵反馈',
      transformerKind: 'defect_feedback',
      record: {
        订单号: 'LC700',
        客诉SKU: 'A',
        客诉类型: '货品瑕疵-缝线',
        待跟进客诉备注: '缝线开了',
      },
    },
  ])
  assert.equal(merged.length, 1)
  const m = merged[0]
  // Non-refund_log complaint type wins
  assert.equal(m['客诉类型'], '货品瑕疵-缝线')
  // Text fields concatenated with [source] prefix
  assert.match(String(m['待跟进客诉备注']), /\[退款登记\]/)
  assert.match(String(m['待跟进客诉备注']), /\[瑕疵反馈\]/)
  assert.match(String(m['待跟进客诉备注']), / \| /)
}

function testMergeKeepsRecordsWithEmptySkuDistinct() {
  // Two records with the same order_no but no 客诉SKU must remain distinct —
  // collapsing them by order_no alone would silently drop a complaint.
  const merged = mergeRecordsByOrderAndSku([
    {
      sourceName: '物流问题',
      transformerKind: 'logistics_issue',
      record: { 订单号: 'LC800', 客诉类型: '物流问题-超期', 待跟进客诉备注: '快递卡海关' },
    },
    {
      sourceName: '物流问题',
      transformerKind: 'logistics_issue',
      record: { 订单号: 'LC800', 客诉类型: '物流问题-丢件', 待跟进客诉备注: '客户没收到' },
    },
  ])
  assert.equal(merged.length, 2)
  assert.equal(merged[0]['客诉类型'], '物流问题-超期')
  assert.equal(merged[1]['客诉类型'], '物流问题-丢件')
}

async function run() {
  testTransformBasicFields()
  testTransformRefundLogKeepsReturnReceiptFlag()
  testTransformSplitsMultiSkuRows()
  testTransformInfersRefundSolutionAndView()
  testTransformRefundProductProblemMapsToCustomerReason()
  testTransformMissingRequiredFields()
  testTransformRefundLogFallbacks()
  testTransformReissue6Usd()
  testTransformReissue6UsdSplitsMultiSkuField()
  testTransformManualReturn()
  testTransformManualReturnSplitsMultiSkuField()
  testTransformDefectFeedback()
  testTransformDefectFeedbackSplitsByShopifySkuWhenItemCountMatches()
  testTransformWrongSendFeedback()
  testTransformWrongSendFeedbackFillsSingleShopifySku()
  testTransformLogisticsIssueWithSkuLookup()
  testTransformLogisticsIssueSkipsRowsWithoutOrderNo()
  testInferComplaintTypeFromText()
  testInferFollowUpTeam()
  testMergeNoOverlapPassThrough()
  testMergeMultiSelectUnion()
  testMergeComplaintTypeNonRefundLogWins()
  testMergeKeepsRecordsWithEmptySkuDistinct()
  testDateFilters()
  testTimestampDateFilter()
  testDateFilterRejectsMixedModes()
  testSanitizeTargetRecord()
  testResolveShopifySiteKey()
  testShopifyHelpers()
  await testSyncPreviewAndRun()
  await testSourceToTargetRebuildDeletesTargetAndWritesArtifacts()
  await testShopifyBackfillOnlyFillsEmptyFields()
  await testLiveLogisticsBackfillUsesCarrierStatus()
  await testReceivedGoodsComplaintSkipsLiveLogisticsLookup()
  await testSkuAmountStaysEmptyWhenComplaintSkuMissingOnMultiProductOrder()
  await testSyncCsv()
  await testSourceImportDefaultsToCurrentYearFloor()
  await testSourceToTargetBackfillsShopifyBiFinancials()
  await testSqliteMirrorDeletesMissingRecords()
  await testSqliteMirrorRangeSyncDoesNotDeleteMissingRecords()
  await testSyncSqliteFailureMarksRunFailed()
  await testSyncTargetToSqliteReadsTargetTable()
  await testSyncTargetToSqlitePrunesMissingTargetRecords()
  testSqliteMirrorFullTargetSyncClearsLegacySourceMappings()
  await testSyncRefreshesBigQueryCache()
  await testSyncBigQueryCacheFailureDoesNotBlockSqliteMirror()
  await testSyncRefreshesShopifyBiV2Cache()
  await testSyncTargetToSqliteCanSkipBigQueryCacheRefreshes()
  await testSyncShopifyBiCacheIfDueRefreshesWhenWindowCovered()
  await testSyncShopifyBiCacheIfDueReturnsFailureWhenCoverageCheckFails()
  await testSyncShopifyBiCacheIfDueRefreshesWhenWindowMissing()
  await testSyncRefreshesShopifyBiV2CacheForRefundFlowOrders()
  await testSyncShopifyBiV2CacheKeysRefundEventsByRefundLine()
  await testSyncShopifyBiCacheQueriesUseStableSourceIds()
  await testSyncLegacyRefundCacheJoinsOrdersForOrderName()
  await testShopifyBiCacheCreatesV2TablesWithoutDroppingLegacyCache()
  await testShopifyBiCacheReplacesDateWindowTransactionally()
  await testShopifyBiCacheStoresDataAsOf()
  await testShopifyBiCacheFallsBackDataAsOfToFinishedAt()
  await testShopifyBiCacheRefundFlowUsesRefundDateWindow()
  await testShopifyBiCacheReplaceWindowRemovesStaleRefundDrivenOrderLines()
  await testShopifyBiCacheReplaceWindowRollsBackOnInsertFailure()
  console.log('Sync tests passed')
}

await run()
