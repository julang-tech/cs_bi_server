import fs from 'node:fs'
import path from 'node:path'
import { BigQuery } from '@google-cloud/bigquery'
import { loadSyncConfig, resolveRuntimePath, type SyncConfig } from '../../integrations/sync-config.js'
import { FeishuTableClient, type FeishuField, type FeishuRecord } from '../../integrations/feishu.js'
import {
  SqliteMirrorRepository,
  type SqliteShopifyOrderLine,
  type SqliteShopifyRefundEvent,
  type SqliteMirrorRecord,
  type SqliteSyncStats,
} from '../../integrations/sqlite.js'
import {
  SqliteShopifyBiCacheRepository,
  type ShopifyBiOrder,
  type ShopifyBiOrderLine,
  type ShopifyBiRefundEvent,
} from '../../integrations/shopify-bi-cache.js'
import type { SourceConfig } from '../../integrations/sync-config.js'
import {
  inferLogisticsStatusFromShopify,
  matchSkuAmount,
  ShopifyClient,
  type ShopifyLikeClient,
} from '../../integrations/shopify.js'
import {
  buildDateFilter,
  filterRowsByDate,
  mergeRecordsByOrderAndSku,
  summarizeResults,
  transformSourceRecord,
  type OrderSkuLookup,
  type SyncDateFilterInput,
  type TransformResult,
} from './transform.js'

export type SyncState = {
  source_to_target_ids: Record<string, string[]>
}

export type SyncCounters = {
  scanned: number
  created: number
  updated: number
  skipped: number
  failed: number
}

export type SyncCommandOptions = {
  config: string
  date?: string
  from?: string
  to?: string
  refreshBigQueryCache?: boolean
}

export type SyncCsvOptions = {
  source: string
  target?: string
  date?: string
  from?: string
  to?: string
}

type FeishuSyncClient = Pick<
  FeishuTableClient,
  'listRecords' | 'listFields' | 'createRecord' | 'updateRecord' | 'batchCreateRecords'
>

type SyncServiceDeps = {
  createClient?: (config: SyncConfig, logger: SyncLogger) => FeishuSyncClient
  createShopifyClient?: (config: SyncConfig, logger: SyncLogger) => ShopifyLikeClient | null
  createSqliteRepository?: (dbPath: string) => SqliteMirrorRepository
  createBigQueryClient?: (config: SyncConfig, logger: SyncLogger) => BigQueryLike | null
}

type SyncLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

type SyncSqliteSummary = {
  enabled: boolean
  ok: boolean
  path: string | null
  inserted: number
  updated: number
  deleted: number
  sqlite_failed: number
}

type SyncBigQueryCacheSummary = {
  enabled: boolean
  ok: boolean
  date_from: string | null
  date_to: string | null
  order_lines_upserted: number
  refund_events_upserted: number
  failed: number
  error?: string
}

type SyncShopifyBiCacheSummary = {
  enabled: boolean
  ok: boolean
  date_from: string
  date_to: string
  orders_upserted: number
  order_lines_upserted: number
  refund_events_upserted: number
  failed: number
  skipped?: boolean
  error?: string
}

type BigQueryRows = Array<Record<string, unknown>>

type BigQueryLike = {
  query(options: unknown): Promise<unknown>
}

type PerSourceCount = {
  source_name: string
  transformer_kind: SourceConfig['transformer_kind']
  source_rows: number
  transformed_records: number
}

type EnrichmentDiagnostic = {
  source_key: string
  record_index: number
  order_no: string
  backfilled_fields: string[]
  kept_empty_fields: string[]
  skipped_reasons: string[]
}

type EnrichmentSummary = {
  eligible_records: number
  enriched_records: number
  untouched_records: number
  fully_backfilled_records: number
  partial_backfilled_records: number
  no_match_records: number
}

const SHOPIFY_BACKFILL_FIELDS = [
  '客户姓名',
  '客户邮箱',
  '下单日期',
  '订单金额',
  '物流号',
  '订单发货时间',
  '后台订单链接',
  '物流状态',
  'SKU金额',
] as const

const BIGQUERY_CACHE_WINDOW_DAYS = 400

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function applyBigQueryProxyConfig(config?: SyncConfig['bigquery']) {
  if (!config?.proxy?.enabled) {
    return
  }
  if (config.proxy.http_proxy) {
    process.env.HTTP_PROXY = config.proxy.http_proxy
  }
  if (config.proxy.https_proxy) {
    process.env.HTTPS_PROXY = config.proxy.https_proxy
  }
  if (config.proxy.no_proxy) {
    process.env.NO_PROXY = config.proxy.no_proxy
  }
}

function extractRows(result: unknown): BigQueryRows {
  if (!Array.isArray(result)) {
    return []
  }
  const [rows] = result as [unknown, ...unknown[]]
  return Array.isArray(rows) ? (rows as BigQueryRows) : []
}

function formatDateUtc(date: Date) {
  return date.toISOString().slice(0, 10)
}

function resolveBigQueryCacheWindow(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - BIGQUERY_CACHE_WINDOW_DAYS)
  return {
    dateFrom: formatDateUtc(start),
    dateTo: formatDateUtc(end),
  }
}

function normalizeNullableText(value: unknown) {
  const text = String(value ?? '').trim()
  return text || null
}

function normalizeBoolean(value: unknown) {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  const text = String(value ?? '').trim().toLowerCase()
  return ['1', 'true', 't', 'yes', 'y'].includes(text)
}

function stableSyntheticId(parts: unknown[]) {
  return parts.map((part) => String(part ?? '').trim()).join(':')
}

function readState(statePath: string): SyncState {
  if (!fs.existsSync(statePath)) {
    return { source_to_target_ids: {} }
  }

  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    source_to_target_ids?: Record<string, string[]>
  }
  return {
    source_to_target_ids: raw.source_to_target_ids ?? {},
  }
}

function writeState(statePath: string, state: SyncState) {
  ensureParentDir(statePath)
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        source_to_target_ids: state.source_to_target_ids,
      },
      null,
      2,
    ),
  )
}

export function createLogger(logPath: string): SyncLogger {
  ensureParentDir(logPath)

  function emit(level: 'INFO' | 'WARN' | 'ERROR', message: string) {
    const line = `${new Date().toISOString()} ${level} ${message}`
    console.log(line)
    fs.appendFileSync(logPath, `${line}\n`)
  }

  return {
    info(message) {
      emit('INFO', message)
    },
    warn(message) {
      emit('WARN', message)
    },
    error(message) {
      emit('ERROR', message)
    },
  }
}

function stringify(value: unknown): string {
  if (value == null) {
    return ''
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => stringify(item))
      .filter(Boolean)
      .join(', ')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['text', 'name', 'email', 'value']) {
      if (key in record) {
        return stringify(record[key])
      }
    }
    return ''
  }
  return String(value).trim()
}

function isEmptyFieldValue(value: unknown): boolean {
  if (value == null) {
    return true
  }
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((item) => isEmptyFieldValue(item))
  }
  return stringify(value) === ''
}

function formatShopifyDatetime(value: string | null) {
  if (!value) {
    return null
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toISOString()
}

async function enrichResultsWithShopify(
  results: TransformResult[],
  config: SyncConfig,
  logger: SyncLogger,
  shopifyClient: ShopifyLikeClient | null,
) {
  const diagnostics: EnrichmentDiagnostic[] = []
  const summary: EnrichmentSummary = {
    eligible_records: 0,
    enriched_records: 0,
    untouched_records: 0,
    fully_backfilled_records: 0,
    partial_backfilled_records: 0,
    no_match_records: 0,
  }

  if (!shopifyClient) {
    return { results, diagnostics, summary }
  }

  // Pre-warm the order cache by fetching all unique orderNos in parallel with
  // a bounded concurrency. The previous sequential `await` per record made
  // enrichment ~75min for 3k unique orders; bounded parallelism brings it to
  // ~5-10min while staying well under Shopify Admin API rate limits.
  const uniqueOrderNos = new Set<string>()
  for (const result of results) {
    if (result.errors.length) continue
    for (const record of result.records) {
      const orderNo = stringify(record['订单号'])
      if (orderNo) uniqueOrderNos.add(orderNo)
    }
  }

  const orderCache = new Map<string, Awaited<ReturnType<ShopifyLikeClient['fetchOrder']>>>()
  const orderNoList = [...uniqueOrderNos]
  const SHOPIFY_CONCURRENCY = 24
  logger.info(
    `Pre-fetching ${orderNoList.length} unique Shopify orders with concurrency=${SHOPIFY_CONCURRENCY}.`,
  )
  let prefetched = 0
  let nextIndex = 0
  async function prefetchWorker() {
    while (true) {
      const i = nextIndex
      nextIndex += 1
      if (i >= orderNoList.length) return
      const orderNo = orderNoList[i]
      try {
        orderCache.set(orderNo, await shopifyClient!.fetchOrder(orderNo))
      } catch (err) {
        logger.warn(`Shopify fetchOrder failed for ${orderNo}: ${(err as Error).message}`)
        orderCache.set(orderNo, null)
      }
      prefetched += 1
      if (prefetched % 100 === 0 || prefetched === orderNoList.length) {
        logger.info(`Shopify prefetch progress: ${prefetched}/${orderNoList.length}`)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SHOPIFY_CONCURRENCY, orderNoList.length) }, () => prefetchWorker()),
  )
  logger.info(`Shopify prefetch done: ${orderCache.size} orders cached.`)

  const enrichedResults: TransformResult[] = []

  for (const result of results) {
    if (result.errors.length) {
      enrichedResults.push(result)
      continue
    }

    const enrichedRecords: Array<Record<string, unknown>> = []

    for (const [recordIndex, record] of result.records.entries()) {
      summary.eligible_records += 1
      const orderNo = stringify(record['订单号'])
      const skippedReasons: string[] = []
      const backfilledFields: string[] = []
      const keptEmptyFields: string[] = []

      if (!orderNo) {
        skippedReasons.push('missing_order_no')
        diagnostics.push({
          source_key: result.source_key,
          record_index: recordIndex,
          order_no: '',
          backfilled_fields: backfilledFields,
          kept_empty_fields: [...SHOPIFY_BACKFILL_FIELDS],
          skipped_reasons: skippedReasons,
        })
        summary.untouched_records += 1
        enrichedRecords.push(record)
        continue
      }

      // Cache is pre-warmed; lookup is synchronous now.
      const order = orderCache.get(orderNo) ?? null
      if (!order) {
        skippedReasons.push('shopify_order_not_found')
        summary.no_match_records += 1
        diagnostics.push({
          source_key: result.source_key,
          record_index: recordIndex,
          order_no: orderNo,
          backfilled_fields: backfilledFields,
          kept_empty_fields: [...SHOPIFY_BACKFILL_FIELDS],
          skipped_reasons: skippedReasons,
        })
        summary.untouched_records += 1
        enrichedRecords.push(record)
        continue
      }

      const nextRecord = { ...record }
      const fieldCandidates: Array<[string, unknown]> = [
        ['客户姓名', order.customer_name],
        ['客户邮箱', order.customer_email],
        ['下单日期', formatShopifyDatetime(order.order_date)],
        ['订单金额', order.order_amount],
        ['物流号', order.tracking_numbers[0] ?? null],
        ['订单发货时间', formatShopifyDatetime(order.shipped_at)],
        ['后台订单链接', order.admin_order_url],
        ['物流状态', inferLogisticsStatusFromShopify(order.fulfillment_status)],
        ['SKU金额', matchSkuAmount(order, stringify(record['客诉SKU']) || null)],
      ]

      for (const [fieldName, candidateValue] of fieldCandidates) {
        if (!isEmptyFieldValue(nextRecord[fieldName])) {
          continue
        }
        if (isEmptyFieldValue(candidateValue)) {
          keptEmptyFields.push(fieldName)
          continue
        }
        nextRecord[fieldName] = candidateValue
        backfilledFields.push(fieldName)
      }

      if (isEmptyFieldValue(record['客诉SKU'])) {
        const skuAmount = matchSkuAmount(order, null)
        if (!skuAmount) {
          skippedReasons.push('sku_amount_requires_complaint_sku_or_single_product_line')
        }
      }
      if (!order.tracking_numbers.length) {
        skippedReasons.push('no_tracking_number_in_shopify')
      }
      if (!order.shipped_at) {
        skippedReasons.push('no_fulfillment_timestamp_in_shopify')
      }
      if (Object.keys(record).length <= 4) {
        skippedReasons.push('sparse_generated_record')
      }

      diagnostics.push({
        source_key: result.source_key,
        record_index: recordIndex,
        order_no: orderNo,
        backfilled_fields: backfilledFields,
        kept_empty_fields: keptEmptyFields,
        skipped_reasons: skippedReasons,
      })

      if (backfilledFields.length) {
        summary.enriched_records += 1
        if (!keptEmptyFields.length) {
          summary.fully_backfilled_records += 1
        } else {
          summary.partial_backfilled_records += 1
        }
        logger.info(
          `${result.source_key} record ${recordIndex + 1}/${result.records.length} Shopify backfilled fields: ${backfilledFields.join(', ') || 'none'}.`,
        )
      } else {
        summary.untouched_records += 1
      }

      enrichedRecords.push(nextRecord)
    }

    enrichedResults.push({
      ...result,
      records: enrichedRecords,
    })
  }

  return {
    results: enrichedResults,
    diagnostics,
    summary,
  }
}

function parseCsvContent(content: string) {
  const rows: string[][] = []
  let row: string[] = []
  let current = ''
  let inQuotes = false

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    const next = content[index + 1]

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      row.push(current)
      current = ''
      continue
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1
      }
      row.push(current)
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row)
      }
      row = []
      current = ''
      continue
    }

    current += char
  }

  row.push(current)
  if (row.some((cell) => cell.length > 0)) {
    rows.push(row)
  }

  return rows
}

function parseCsvRows(filePath: string) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
  const parsedRows = parseCsvContent(content)
  const headers = parsedRows[0] ?? []

  const rows = parsedRows.slice(1).map((values, index) => {
    const row: Record<string, string> = {}
    headers.forEach((header, headerIndex) => {
      row[header] = values[headerIndex] ?? ''
    })
    return [`csv:${index + 1}`, row] as [string, Record<string, string>]
  })

  return {
    headers,
    rows,
  }
}

function getFieldOptionNames(field: FeishuField) {
  const rawOptions =
    (field.property?.options as Array<Record<string, unknown>> | undefined) ?? []

  return new Set(
    rawOptions
      .map((option) => String(option.name ?? '').trim())
      .filter(Boolean),
  )
}

function coerceDatetimeFieldValue(value: unknown): [boolean, unknown] {
  if (value == null || value === '') {
    return [false, value]
  }
  if (typeof value === 'number') {
    return [true, value < 10_000_000_000 ? value * 1000 : value]
  }

  const text = String(value).trim()
  if (!text) {
    return [false, value]
  }
  if (/^\d+$/.test(text)) {
    return coerceDatetimeFieldValue(Number(text))
  }

  const normalized = text.replace(/\//g, '-')
  const date = new Date(normalized.includes('T') ? normalized : normalized.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) {
    return [false, value]
  }
  return [true, date.getTime()]
}

function coerceSingleSelectFieldValue(field: FeishuField, value: unknown): [boolean, unknown] {
  if (value == null) {
    return [false, value]
  }
  const text = String(value).trim()
  if (!text) {
    return [false, value]
  }

  const options = getFieldOptionNames(field)
  if (options.size && !options.has(text)) {
    return [false, value]
  }
  return [true, text]
}

function coerceMultiSelectFieldValue(field: FeishuField, value: unknown): [boolean, unknown] {
  if (value == null) {
    return [false, value]
  }

  const normalized = Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : String(value)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)

  const options = getFieldOptionNames(field)
  const filtered = options.size ? normalized.filter((item) => options.has(item)) : normalized
  return filtered.length ? [true, filtered] : [false, value]
}

function coerceFieldValue(field: FeishuField, value: unknown): [boolean, unknown] {
  if (field.field_type === 3) {
    return coerceSingleSelectFieldValue(field, value)
  }
  if (field.field_type === 4) {
    return coerceMultiSelectFieldValue(field, value)
  }
  if (field.field_type === 5 || field.field_name.includes('日期') || field.field_name.includes('时间')) {
    return coerceDatetimeFieldValue(value)
  }
  if (field.field_type === 2) {
    if (value == null || value === '') {
      return [false, value]
    }
    if (typeof value === 'number') {
      return [true, value]
    }
    const text = String(value).trim()
    if (/^[+-]?\d+$/.test(text)) {
      return [true, Number(text)]
    }
    if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
      return [true, Number(text)]
    }
    return [false, value]
  }
  return [true, value]
}

export function sanitizeTargetRecord(
  sourceKey: string,
  record: Record<string, unknown>,
  targetFieldsByName: Record<string, FeishuField> | null,
) {
  if (!targetFieldsByName) {
    return {
      sanitizedRecord: record,
      dropped_unknown_fields: [] as string[],
      dropped_invalid_fields: [] as string[],
      source_key: sourceKey,
    }
  }

  const sanitizedRecord: Record<string, unknown> = {}
  const droppedUnknownFields: string[] = []
  const droppedInvalidFields: string[] = []

  for (const [key, value] of Object.entries(record)) {
    const field = targetFieldsByName[key]
    if (!field) {
      droppedUnknownFields.push(key)
      continue
    }
    const [ok, coerced] = coerceFieldValue(field, value)
    if (!ok) {
      droppedInvalidFields.push(key)
      continue
    }
    sanitizedRecord[key] = coerced
  }

  return {
    sanitizedRecord,
    dropped_unknown_fields: droppedUnknownFields,
    dropped_invalid_fields: droppedInvalidFields,
    source_key: sourceKey,
  }
}

function resolveStatePath(configPath: string, config: SyncConfig) {
  return resolveRuntimePath(configPath, config.runtime.state_path)
}

async function syncResults(
  results: TransformResult[],
  config: SyncConfig,
  statePath: string,
  dryRun: boolean,
  client: FeishuSyncClient | null,
  logger: SyncLogger,
) {
  const state = readState(statePath)
  const counters: SyncCounters = {
    scanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  }

  let targetFieldsByName: Record<string, FeishuField> | null = null
  if (client) {
    const targetFields = await client.listFields(config.target)
    targetFieldsByName = Object.fromEntries(
      targetFields.map((field) => [field.field_name, field]),
    )
    logger.info(`Loaded ${targetFields.length} target fields from ${config.target.table_id}.`)
  }

  const diagnostics: Array<Record<string, unknown>> = []
  const mirroredRecords: SqliteMirrorRecord[] = []
  logger.info(`Starting result sync loop (dry_run=${dryRun}).`)

  // Pending creates collected across all results, flushed once at the end via
  // Feishu batch_create (500 records per HTTP call) — replaces ~6000 sequential
  // POSTs with ~12 batch calls.
  type PendingCreate = {
    resultIndex: number
    recordIndex: number
    sourceKey: string
    sanitizedRecord: Record<string, unknown>
  }
  const pendingCreates: PendingCreate[] = []
  // Track which result_index → array of synced IDs (sparse — only non-create
  // entries get filled inline; create entries get filled after the batch flush).
  const syncedIdsByResult = new Map<number, Array<string | null>>()

  for (const [resultIndex, result] of results.entries()) {
    counters.scanned += 1
    if (resultIndex === 0 || (resultIndex + 1) % 10 === 0) {
      logger.info(`Processing source record ${resultIndex + 1}: ${result.source_key}`)
    }

    if (result.errors.length) {
      counters.failed += 1
      logger.error(`${result.source_key}: ${result.errors.join('; ')}`)
      diagnostics.push({
        source_key: result.source_key,
        errors: result.errors,
      })
      continue
    }

    const existingIds = state.source_to_target_ids[result.source_key] ?? []
    if (dryRun) {
      if (existingIds.length) {
        counters.updated += result.records.length
      } else {
        counters.created += result.records.length
      }
      continue
    }

    const syncedIds: Array<string | null> = new Array(result.records.length).fill(null)
    syncedIdsByResult.set(resultIndex, syncedIds)

    for (let index = 0; index < result.records.length; index += 1) {
      const rawRecord = result.records[index]
      const { sanitizedRecord, dropped_invalid_fields, dropped_unknown_fields } =
        sanitizeTargetRecord(result.source_key, rawRecord, targetFieldsByName)

      if (dropped_invalid_fields.length || dropped_unknown_fields.length) {
        logger.warn(
          `${result.source_key} sanitized target ${index + 1}/${result.records.length}: dropped unknown=${dropped_unknown_fields.length}, invalid=${dropped_invalid_fields.length}.`,
        )
        diagnostics.push({
          source_key: result.source_key,
          dropped_invalid_fields,
          dropped_unknown_fields,
        })
      }

      if (!client) {
        continue
      }

      const existingId = existingIds[index]
      if (existingId) {
        try {
          const updatedId = await client.updateRecord(config.target, existingId, sanitizedRecord)
          syncedIds[index] = updatedId
          mirroredRecords.push({
            record_id: updatedId,
            source_record_id: result.source_key,
            source_record_index: index,
            synced_at: new Date().toISOString(),
            fields: sanitizedRecord,
          })
          counters.updated += 1
          continue
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('RecordIdNotFound')) {
            throw error
          }
          logger.warn(
            `${result.source_key} target record ${existingId} no longer exists; queuing recreate for target ${index + 1}/${result.records.length}.`,
          )
        }
      }

      // Queue for batch create.
      pendingCreates.push({
        resultIndex,
        recordIndex: index,
        sourceKey: result.source_key,
        sanitizedRecord,
      })
    }

    if (existingIds.length > result.records.length) {
      logger.warn(
        `${result.source_key} previously synced to ${existingIds.length} target records, now only ${result.records.length} records generated; extra target records were left untouched.`,
      )
    }
  }

  // Flush all pending creates via Feishu batch_create.
  if (client && pendingCreates.length > 0) {
    logger.info(`Batch-creating ${pendingCreates.length} target records.`)
    const fieldsList = pendingCreates.map((p) => p.sanitizedRecord)
    const createdIds = await client.batchCreateRecords(config.target, fieldsList)
    if (createdIds.length !== pendingCreates.length) {
      throw new Error(
        `batchCreateRecords returned ${createdIds.length} ids for ${pendingCreates.length} requests`,
      )
    }
    for (let i = 0; i < pendingCreates.length; i += 1) {
      const pc = pendingCreates[i]
      const createdId = createdIds[i]
      const syncedIds = syncedIdsByResult.get(pc.resultIndex)
      if (syncedIds) syncedIds[pc.recordIndex] = createdId
      mirroredRecords.push({
        record_id: createdId,
        source_record_id: pc.sourceKey,
        source_record_index: pc.recordIndex,
        synced_at: new Date().toISOString(),
        fields: pc.sanitizedRecord,
      })
      counters.created += 1
    }
    logger.info(`Batch create finished: ${counters.created} created, ${counters.updated} updated.`)
  }

  // Persist state once at the end.
  for (const [resultIndex, syncedIds] of syncedIdsByResult.entries()) {
    const result = results[resultIndex]
    if (!result) continue
    state.source_to_target_ids[result.source_key] = syncedIds.filter(
      (id): id is string => id !== null,
    )
  }
  if (client && !dryRun) {
    writeState(statePath, state)
  }

  return {
    counters,
    diagnostics,
    mirroredRecords,
    state,
  }
}

export class SyncService {
  private readonly createClient: (config: SyncConfig, logger: SyncLogger) => FeishuSyncClient
  private readonly createShopifyClient: (config: SyncConfig, logger: SyncLogger) => ShopifyLikeClient | null
  private readonly createSqliteRepository: (dbPath: string) => SqliteMirrorRepository
  private readonly createBigQueryClient: (config: SyncConfig, logger: SyncLogger) => BigQueryLike | null

  constructor(deps: SyncServiceDeps = {}) {
    this.createClient =
      deps.createClient ?? ((config, logger) => new FeishuTableClient(config, logger))
    this.createShopifyClient =
      deps.createShopifyClient ?? ((config) => (config.shopify ? new ShopifyClient(config.shopify) : null))
    this.createSqliteRepository =
      deps.createSqliteRepository ?? ((dbPath) => new SqliteMirrorRepository(dbPath))
    this.createBigQueryClient =
      deps.createBigQueryClient ??
      ((config) => {
        const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
        if (!credentialsPath || !fs.existsSync(credentialsPath)) {
          return null
        }
        applyBigQueryProxyConfig(config.bigquery)
        return new BigQuery()
      })
  }

  async preview(options: SyncCommandOptions) {
    const config = loadSyncConfig(options.config)
    const statePath = resolveStatePath(options.config, config)
    const logPath = resolveRuntimePath(options.config, config.runtime.log_path)
    const logger = createLogger(logPath)
    const dateFilter = buildDateFilter(options)
    const client = this.createClient(config, logger)
    const shopifyClient = this.createShopifyClient(config, logger)
    const skuLookup = this.createOrderSkuLookup(options.config, logger)
    logger.info(`Starting preview with config ${options.config}.`)
    const { transformed, perSourceCounts } = await this.transformAllSources(
      config,
      client,
      dateFilter,
      skuLookup,
      logger,
    )
    const enriched = await enrichResultsWithShopify(transformed, config, logger, shopifyClient)
    logger.info(
      `Preview transformed rows: ${
        perSourceCounts
          .map((entry) => `${entry.source_name}=${entry.transformed_records}`)
          .join(', ')
      }.`,
    )
    const synced = await syncResults(enriched.results, config, statePath, true, null, logger)
    logger.info(
      `Preview finished: scanned=${synced.counters.scanned}, created=${synced.counters.created}, updated=${synced.counters.updated}, failed=${synced.counters.failed}.`,
    )

    return {
      mode: 'preview',
      config,
      state: readState(statePath),
      dateFilter,
      summary: summarizeResults(enriched.results),
      per_source_counts: perSourceCounts,
      enrichment_summary: enriched.summary,
      sqlite: {
        enabled: false,
        ok: true,
        path: null,
        inserted: 0,
        updated: 0,
        deleted: 0,
        sqlite_failed: 0,
      },
      bigquery_cache: {
        enabled: false,
        ok: true,
        date_from: null,
        date_to: null,
        order_lines_upserted: 0,
        refund_events_upserted: 0,
        failed: 0,
      },
      ...synced.counters,
      diagnostics: [...synced.diagnostics, ...enriched.diagnostics],
    }
  }

  async syncSourceToTarget(options: SyncCommandOptions) {
    const config = loadSyncConfig(options.config)
    const statePath = resolveStatePath(options.config, config)
    const logPath = resolveRuntimePath(options.config, config.runtime.log_path)
    const logger = createLogger(logPath)
    const dateFilter = buildDateFilter(options)
    const client = this.createClient(config, logger)
    const shopifyClient = this.createShopifyClient(config, logger)
    const skuLookup = this.createOrderSkuLookup(options.config, logger)
    logger.info(`Starting source-to-target sync with config ${options.config}.`)
    const { transformed, perSourceCounts } = await this.transformAllSources(
      config,
      client,
      dateFilter,
      skuLookup,
      logger,
    )
    const enriched = await enrichResultsWithShopify(transformed, config, logger, shopifyClient)
    logger.info(
      `Source-to-target transformed rows: ${
        perSourceCounts
          .map((entry) => `${entry.source_name}=${entry.transformed_records}`)
          .join(', ')
      }.`,
    )
    const synced = await syncResults(enriched.results, config, statePath, false, client, logger)
    logger.info(
      `Source-to-target sync finished: scanned=${synced.counters.scanned}, created=${synced.counters.created}, updated=${synced.counters.updated}, failed=${synced.counters.failed}.`,
    )

    return {
      mode: 'source-to-target',
      config,
      statePath,
      dateFilter,
      summary: summarizeResults(enriched.results),
      per_source_counts: perSourceCounts,
      enrichment_summary: enriched.summary,
      sqlite: {
        enabled: false,
        ok: true,
        path: null,
        inserted: 0,
        updated: 0,
        deleted: 0,
        sqlite_failed: 0,
      },
      bigquery_cache: {
        enabled: false,
        ok: true,
        date_from: null,
        date_to: null,
        order_lines_upserted: 0,
        refund_events_upserted: 0,
        failed: 0,
      },
      ...synced.counters,
      diagnostics: [...synced.diagnostics, ...enriched.diagnostics],
      state: synced.state,
    }
  }

  /**
   * Pulls every configured source table, applies the per-source transformer,
   * then merges output by (order_no, sku) so cross-source rows for the same
   * SKU collapse into a single target record.
   */
  private async transformAllSources(
    config: SyncConfig,
    client: FeishuSyncClient,
    dateFilter: ReturnType<typeof buildDateFilter>,
    skuLookup: OrderSkuLookup | undefined,
    logger: SyncLogger,
  ): Promise<{ transformed: TransformResult[]; perSourceCounts: PerSourceCount[] }> {
    const tagged: Array<{
      sourceName: string
      transformerKind: SourceConfig['transformer_kind']
      result: TransformResult
    }> = []
    const perSourceCounts: PerSourceCount[] = []

    const sources: SourceConfig[] =
      config.sources && config.sources.length > 0
        ? config.sources
        : [{
            ...config.source,
            name: '退款登记',
            transformer_kind: 'refund_log',
          }]
    for (const source of sources) {
      const sourceName = source.name ?? source.transformer_kind
      logger.info(`Listing source records: ${sourceName} (${source.table_id}).`)
      const records = await client.listRecords({
        app_token: source.app_token,
        table_id: source.table_id,
        view_id: source.view_id ?? null,
      })
      const filteredRows = filterRowsByDate(
        records.map((record) => [record.record_id, record.fields] as [string, Record<string, unknown>]),
        dateFilter,
      )
      const sourceResults = filteredRows.map(([sourceKey, row]) =>
        transformSourceRecord(`${source.transformer_kind}:${sourceKey}`, row, source.transformer_kind, {
          sourceName,
          lookupOrderSkus: skuLookup,
        }),
      )
      let recordsCount = 0
      for (const result of sourceResults) {
        recordsCount += result.records.length
        tagged.push({ sourceName, transformerKind: source.transformer_kind, result })
      }
      perSourceCounts.push({
        source_name: sourceName,
        transformer_kind: source.transformer_kind,
        source_rows: filteredRows.length,
        transformed_records: recordsCount,
      })
      logger.info(
        `Source ${sourceName}: ${filteredRows.length} rows → ${recordsCount} records (transformer=${source.transformer_kind}).`,
      )
    }

    // Carry through error-only results (no merging needed for those).
    const errorResults: TransformResult[] = []
    const recordsToMerge: Array<{
      sourceName: string
      transformerKind: SourceConfig['transformer_kind']
      record: Record<string, unknown>
    }> = []
    for (const { sourceName, transformerKind, result } of tagged) {
      if (result.errors.length) {
        errorResults.push(result)
        continue
      }
      for (const record of result.records) {
        recordsToMerge.push({ sourceName, transformerKind, record })
      }
    }

    const mergedRecords = mergeRecordsByOrderAndSku(recordsToMerge)
    const mergedResults: TransformResult[] = mergedRecords.map((record) => {
      const orderNo = String(record['订单号'] ?? '').trim()
      const sku = String(record['客诉SKU'] ?? '').trim()
      return {
        source_key: `merged:${orderNo}|${sku}`,
        records: [record],
        errors: [],
      }
    })

    const transformed = [...mergedResults, ...errorResults]
    logger.info(
      `Merged ${recordsToMerge.length} per-source records into ${mergedResults.length} target records (errors: ${errorResults.length}).`,
    )
    return { transformed, perSourceCounts }
  }

  /**
   * Builds an order → valid-SKU lookup backed by the local Shopify BI cache.
   * Returns `undefined` if the cache file is missing so transformers gracefully
   * fall back to row-level SKUs.
   */
  private createOrderSkuLookup(configPath: string, logger: SyncLogger): OrderSkuLookup | undefined {
    let config: SyncConfig
    try {
      config = loadSyncConfig(configPath)
    } catch {
      return undefined
    }
    const sqlitePath = resolveRuntimePath(configPath, config.runtime.sqlite_path)
    if (!fs.existsSync(sqlitePath)) {
      logger.info(`Shopify BI cache not found at ${sqlitePath}; logistics SKU lookup disabled.`)
      return undefined
    }
    let repository: SqliteShopifyBiCacheRepository | null = null
    try {
      repository = new SqliteShopifyBiCacheRepository(sqlitePath)
    } catch (error) {
      logger.warn(
        `Failed to open Shopify BI cache for SKU lookup: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
    const cache = new Map<string, string[]>()
    return (orderNo: string) => {
      if (!orderNo) return null
      if (cache.has(orderNo)) return cache.get(orderNo) ?? null
      try {
        const skus = repository!.listValidSkusByOrderNo(orderNo)
        cache.set(orderNo, skus)
        return skus
      } catch (error) {
        logger.warn(
          `Shopify BI cache lookup failed for ${orderNo}: ${error instanceof Error ? error.message : String(error)}`,
        )
        return null
      }
    }
  }

  async sync(options: SyncCommandOptions) {
    return this.syncTargetToSqlite(options)
  }

  async syncTargetToSqlite(options: SyncCommandOptions) {
    const config = loadSyncConfig(options.config)
    const logPath = resolveRuntimePath(options.config, config.runtime.log_path)
    const logger = createLogger(logPath)
    const dateFilter = buildDateFilter(options)
    const client = this.createClient(config, logger)
    const sqlitePath = resolveRuntimePath(options.config, config.runtime.sqlite_path)
    logger.info(`Starting target-to-sqlite sync with config ${options.config}.`)
    const targetRows = filterRowsByDate(
      (await client.listRecords(config.target)).map((record) => [record.record_id, record.fields] as [string, Record<string, unknown>]),
      dateFilter,
    )
    const now = new Date().toISOString()
    const mirroredRecords: SqliteMirrorRecord[] = targetRows.map(([recordId, fields]) => ({
      record_id: recordId,
      source_record_id: recordId,
      source_record_index: 0,
      synced_at: now,
      fields,
    }))
    logger.info(`Fetched ${targetRows.length} target rows for target-to-sqlite sync.`)
    const sqlite = this.syncToSqlite(
      sqlitePath,
      mirroredRecords,
      dateFilter === null,
      logger,
    )
    let failed = sqlite.ok ? 0 : 1
    const refreshBigQueryCache = options.refreshBigQueryCache ?? true
    const { dateFrom, dateTo } = resolveBigQueryCacheWindow()
    const bigqueryCache = refreshBigQueryCache
      ? await this.syncBigQueryCache(config, sqlitePath, logger)
      : {
          enabled: false,
          ok: true,
          date_from: dateFrom,
          date_to: dateTo,
          order_lines_upserted: 0,
          refund_events_upserted: 0,
          failed: 0,
        }
    if (!bigqueryCache.ok) {
      failed += 1
    }
    const shopifyBiCache = refreshBigQueryCache
      ? await this.syncShopifyBiCache(config, sqlitePath, logger)
      : {
          enabled: false,
          ok: true,
          date_from: dateFrom,
          date_to: dateTo,
          orders_upserted: 0,
          order_lines_upserted: 0,
          refund_events_upserted: 0,
          failed: 0,
        }
    if (!shopifyBiCache.ok) {
      failed += 1
    }
    logger.info(
      `Target-to-sqlite sync finished: scanned=${targetRows.length}, failed=${failed}, sqlite_inserted=${sqlite.inserted}, sqlite_updated=${sqlite.updated}, sqlite_deleted=${sqlite.deleted}, sqlite_failed=${sqlite.sqlite_failed}, bigquery_cache_enabled=${bigqueryCache.enabled}, bigquery_cache_ok=${bigqueryCache.ok}, bigquery_order_lines=${bigqueryCache.order_lines_upserted}, bigquery_refund_events=${bigqueryCache.refund_events_upserted}, shopify_bi_cache_enabled=${shopifyBiCache.enabled}, shopify_bi_cache_ok=${shopifyBiCache.ok}, shopify_bi_orders=${shopifyBiCache.orders_upserted}, shopify_bi_order_lines=${shopifyBiCache.order_lines_upserted}, shopify_bi_refund_events=${shopifyBiCache.refund_events_upserted}.`,
    )

    return {
      mode: 'sync',
      config,
      dateFilter,
      summary: {
        target_rows: targetRows.length,
        mirrored_records: mirroredRecords.length,
      },
      sqlite,
      bigquery_cache: bigqueryCache,
      shopify_bi_cache: shopifyBiCache,
      scanned: targetRows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      failed,
      diagnostics: [],
    }
  }

  async syncShopifyBiCacheIfDue(options: { config: string }) {
    const config = loadSyncConfig(options.config)
    const sqlitePath = resolveRuntimePath(options.config, config.runtime.sqlite_path)
    const logger = createLogger(resolveRuntimePath(options.config, config.runtime.log_path))
    const { dateFrom, dateTo } = resolveBigQueryCacheWindow()
    let repository: SqliteShopifyBiCacheRepository | null = null
    try {
      repository = new SqliteShopifyBiCacheRepository(sqlitePath)
      if (repository.hasCoverage(dateFrom, dateTo)) {
        logger.info(`Shopify BI cache skipped: existing coverage for ${dateFrom} to ${dateTo}.`)
        return {
          enabled: true,
          ok: true,
          date_from: dateFrom,
          date_to: dateTo,
          orders_upserted: 0,
          order_lines_upserted: 0,
          refund_events_upserted: 0,
          failed: 0,
          skipped: true,
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Shopify BI cache due-check failed: ${message}`)
      return {
        enabled: true,
        ok: false,
        date_from: dateFrom,
        date_to: dateTo,
        orders_upserted: 0,
        order_lines_upserted: 0,
        refund_events_upserted: 0,
        failed: 1,
        skipped: false,
        error: message,
      }
    } finally {
      repository?.close()
    }

    const result = await this.syncShopifyBiCache(config, sqlitePath, logger)
    return {
      ...result,
      skipped: false,
    }
  }

  private async syncBigQueryCache(
    config: SyncConfig,
    sqlitePath: string,
    logger: SyncLogger,
  ): Promise<SyncBigQueryCacheSummary> {
    const { dateFrom, dateTo } = resolveBigQueryCacheWindow()
    const client = this.createBigQueryClient(config, logger)
    if (!client) {
      logger.warn('BigQuery cache sync skipped: credentials not found.')
      return {
        enabled: false,
        ok: true,
        date_from: dateFrom,
        date_to: dateTo,
        order_lines_upserted: 0,
        refund_events_upserted: 0,
        failed: 0,
      }
    }

    const startedAt = new Date().toISOString()
    let repository: SqliteMirrorRepository | null = null
    try {
      logger.info(`Starting BigQuery cache sync for ${dateFrom} to ${dateTo}.`)
      const [orderLines, refundEvents] = await Promise.all([
        this.fetchBigQueryOrderLines(client, dateFrom, dateTo),
        this.fetchBigQueryRefundEvents(client, dateFrom, dateTo),
      ])
      repository = this.createSqliteRepository(sqlitePath)
      const stats = repository.replaceBigQueryCacheWindow({
        dateFrom,
        dateTo,
        orderLines,
        refundEvents,
        startedAt,
        finishedAt: new Date().toISOString(),
      })
      logger.info(
        `BigQuery cache synced to ${sqlitePath}: order_lines=${stats.order_lines_upserted}, refund_events=${stats.refund_events_upserted}.`,
      )
      return {
        enabled: true,
        ok: true,
        date_from: dateFrom,
        date_to: dateTo,
        ...stats,
        failed: 0,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`BigQuery cache sync failed: ${message}`)
      try {
        repository ??= this.createSqliteRepository(sqlitePath)
        repository.recordBigQueryCacheFailure({
          dateFrom,
          dateTo,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: message,
        })
      } catch (recordError) {
        logger.error(
          `BigQuery cache failure record failed: ${
            recordError instanceof Error ? recordError.message : String(recordError)
          }`,
        )
      }
      return {
        enabled: true,
        ok: false,
        date_from: dateFrom,
        date_to: dateTo,
        order_lines_upserted: 0,
        refund_events_upserted: 0,
        failed: 1,
        error: message,
      }
    } finally {
      repository?.close()
    }
  }

  private async syncShopifyBiCache(
    config: SyncConfig,
    sqlitePath: string,
    logger: SyncLogger,
  ): Promise<SyncShopifyBiCacheSummary> {
    const { dateFrom, dateTo } = resolveBigQueryCacheWindow()
    const client = this.createBigQueryClient(config, logger)
    if (!client) {
      logger.warn('Shopify BI cache sync skipped: credentials not found.')
      return {
        enabled: false,
        ok: true,
        date_from: dateFrom,
        date_to: dateTo,
        orders_upserted: 0,
        order_lines_upserted: 0,
        refund_events_upserted: 0,
        failed: 0,
      }
    }

    const startedAt = new Date().toISOString()
    let repository: SqliteShopifyBiCacheRepository | null = null
    try {
      logger.info(`Starting Shopify BI cache sync for ${dateFrom} to ${dateTo}.`)
      const [orders, orderLines, refundEvents] = await Promise.all([
        this.fetchShopifyBiOrders(client, dateFrom, dateTo),
        this.fetchShopifyBiOrderLines(client, dateFrom, dateTo),
        this.fetchShopifyBiRefundEvents(client, dateFrom, dateTo),
      ])
      repository = new SqliteShopifyBiCacheRepository(sqlitePath)
      const stats = repository.replaceWindow({
        dateFrom,
        dateTo,
        orders,
        orderLines,
        refundEvents,
        startedAt,
        finishedAt: new Date().toISOString(),
      })
      logger.info(
        `Shopify BI cache synced to ${sqlitePath}: orders=${stats.orders_upserted}, order_lines=${stats.order_lines_upserted}, refund_events=${stats.refund_events_upserted}.`,
      )
      return {
        enabled: true,
        ok: true,
        date_from: dateFrom,
        date_to: dateTo,
        ...stats,
        failed: 0,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Shopify BI cache sync failed: ${message}`)
      return {
        enabled: true,
        ok: false,
        date_from: dateFrom,
        date_to: dateTo,
        orders_upserted: 0,
        order_lines_upserted: 0,
        refund_events_upserted: 0,
        failed: 1,
        error: message,
      }
    } finally {
      repository?.close()
    }
  }

  private async fetchShopifyBiOrders(
    client: BigQueryLike,
    dateFrom: string,
    dateTo: string,
  ): Promise<ShopifyBiOrder[]> {
    const rows = extractRows(await client.query({
      query: `
SELECT
  CAST(o.order_id AS STRING) AS order_id,
  CAST(o.order_name AS STRING) AS order_no,
  CAST(o.shop_domain AS STRING) AS shop_domain,
  CAST(o.processed_date AS STRING) AS processed_date,
  CAST(o.primary_product_type AS STRING) AS primary_product_type,
  CAST(DATE(o.first_published_at_in_order) AS STRING) AS first_published_at_in_order,
  COALESCE(o.is_regular_order, FALSE) AS is_regular_order,
  COALESCE(o.is_gift_card_order, FALSE) AS is_gift_card_order,
  COALESCE(o.cs_bi_gmv_usd, 0) AS gmv_usd,
  COALESCE(o.cs_bi_revenue_usd, 0) AS revenue_usd,
  COALESCE(o.cs_bi_net_revenue_usd, 0) AS net_revenue_usd
FROM \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
  OR o.order_id IN (
    SELECT DISTINCT re.order_id
    FROM \`julang-dev-database.shopify_dwd.dwd_refund_events\` re
    WHERE re.refund_date BETWEEN DATE(@date_from) AND DATE(@date_to)
  )
      `,
      params: { date_from: dateFrom, date_to: dateTo },
    }))

    return rows.map((row) => ({
      order_id: String(row.order_id ?? ''),
      order_no: String(row.order_no ?? ''),
      shop_domain: normalizeNullableText(row.shop_domain),
      processed_date: String(row.processed_date ?? ''),
      primary_product_type: normalizeNullableText(row.primary_product_type),
      first_published_at_in_order: normalizeNullableText(row.first_published_at_in_order),
      is_regular_order: normalizeBoolean(row.is_regular_order),
      is_gift_card_order: normalizeBoolean(row.is_gift_card_order),
      gmv_usd: Number(row.gmv_usd ?? 0),
      revenue_usd: Number(row.revenue_usd ?? 0),
      net_revenue_usd: Number(row.net_revenue_usd ?? 0),
    })).filter((row) => row.order_id && row.order_no && row.processed_date)
  }

  private async fetchShopifyBiOrderLines(
    client: BigQueryLike,
    dateFrom: string,
    dateTo: string,
  ): Promise<ShopifyBiOrderLine[]> {
    const rows = extractRows(await client.query({
      query: `
WITH eligible_orders AS (
  SELECT o.order_id
  FROM \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
  WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
    OR o.order_id IN (
      SELECT DISTINCT re.order_id
      FROM \`julang-dev-database.shopify_dwd.dwd_refund_events\` re
      WHERE re.refund_date BETWEEN DATE(@date_from) AND DATE(@date_to)
    )
),
parsed AS (
  SELECT
    li.*,
    o.order_name,
    o.usd_fx_rate,
    CASE
      WHEN li.sku IS NULL OR TRIM(li.sku) = '' THEN 'N/A'
      WHEN STRPOS(TRIM(li.sku), '-') > 0 THEN REGEXP_REPLACE(TRIM(li.sku), r'-[^-]+$', '')
      ELSE TRIM(li.sku)
    END AS parsed_skc
  FROM \`julang-dev-database.shopify_intermediate.int_line_items_classified\` li
  JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
    ON o.order_id = li.order_id
  JOIN eligible_orders eo
    ON eo.order_id = li.order_id
),
parsed2 AS (
  SELECT
    *,
    REGEXP_EXTRACT(parsed_skc, r'([^-]+)$') AS skc_last_segment,
    CASE
      WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
      ELSE ''
    END AS skc_prefix,
    CASE
      WHEN parsed_skc = 'N/A' THEN 'N/A'
      WHEN REGEXP_CONTAINS(REGEXP_EXTRACT(parsed_skc, r'([^-]+)$'), r'\\d') THEN
        CASE
          WHEN (
            CASE
              WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
              ELSE ''
            END
          ) != '' THEN CONCAT(
            CASE
              WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
              ELSE ''
            END,
            '-',
            COALESCE(
              REGEXP_EXTRACT(REGEXP_EXTRACT(parsed_skc, r'([^-]+)$'), r'^([a-zA-Z]*\\d+)'),
              REGEXP_EXTRACT(parsed_skc, r'([^-]+)$')
            )
          )
          ELSE COALESCE(
            REGEXP_EXTRACT(REGEXP_EXTRACT(parsed_skc, r'([^-]+)$'), r'^([a-zA-Z]*\\d+)'),
            REGEXP_EXTRACT(parsed_skc, r'([^-]+)$')
          )
        END
      ELSE
        CASE
          WHEN (
            CASE
              WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
              ELSE ''
            END
          ) != '' THEN
            CASE
              WHEN STRPOS(parsed_skc, '-') > 0 THEN REGEXP_REPLACE(parsed_skc, r'-[^-]+$', '')
              ELSE ''
            END
          ELSE REGEXP_EXTRACT(parsed_skc, r'([^-]+)$')
        END
    END AS parsed_spu
  FROM parsed
)
SELECT
  CAST(order_id AS STRING) AS order_id,
  CAST(order_name AS STRING) AS order_no,
  COALESCE(
    JSON_VALUE(TO_JSON_STRING(parsed2), '$.line_item_id'),
    JSON_VALUE(TO_JSON_STRING(parsed2), '$.id'),
    TO_HEX(SHA256(CONCAT(
      COALESCE(CAST(order_id AS STRING), ''),
      '|',
      COALESCE(CAST(sku AS STRING), ''),
      '|',
      COALESCE(CAST(product_id AS STRING), ''),
      '|',
      COALESCE(CAST(variant_id AS STRING), ''),
      '|',
      COALESCE(CAST(quantity AS STRING), ''),
      '|',
      COALESCE(CAST(discounted_total AS STRING), ''),
      '|',
      COALESCE(CAST(is_insurance_item AS STRING), ''),
      '|',
      COALESCE(CAST(is_price_adjustment AS STRING), ''),
      '|',
      COALESCE(CAST(is_shipping_cost AS STRING), '')
    )))
  ) AS line_key,
  CAST(sku AS STRING) AS sku,
  parsed_skc AS skc,
  parsed_spu AS spu,
  CAST(product_id AS STRING) AS product_id,
  CAST(variant_id AS STRING) AS variant_id,
  COALESCE(quantity, 0) AS quantity,
  COALESCE(CAST(discounted_total AS NUMERIC) * COALESCE(CAST(usd_fx_rate AS NUMERIC), 1), 0) AS discounted_total_usd,
  COALESCE(is_insurance_item, FALSE) AS is_insurance_item,
  COALESCE(is_price_adjustment, FALSE) AS is_price_adjustment,
  COALESCE(is_shipping_cost, FALSE) AS is_shipping_cost
FROM parsed2
      `,
      params: { date_from: dateFrom, date_to: dateTo },
    }))

    return rows.map((row) => {
      const orderId = String(row.order_id ?? '')
      const sku = normalizeNullableText(row.sku)
      const lineKey = String(
        row.line_key ?? stableSyntheticId([orderId, sku, row.variant_id, row.product_id]),
      )
      return {
        order_id: orderId,
        order_no: String(row.order_no ?? ''),
        line_key: lineKey,
        sku,
        skc: normalizeNullableText(row.skc),
        spu: normalizeNullableText(row.spu),
        product_id: normalizeNullableText(row.product_id),
        variant_id: normalizeNullableText(row.variant_id),
        quantity: Number(row.quantity ?? 0),
        discounted_total_usd: Number(row.discounted_total_usd ?? 0),
        is_insurance_item: normalizeBoolean(row.is_insurance_item),
        is_price_adjustment: normalizeBoolean(row.is_price_adjustment),
        is_shipping_cost: normalizeBoolean(row.is_shipping_cost),
      }
    }).filter((row) => row.order_id && row.order_no && row.line_key)
  }

  private async fetchShopifyBiRefundEvents(
    client: BigQueryLike,
    dateFrom: string,
    dateTo: string,
  ): Promise<ShopifyBiRefundEvent[]> {
    const rows = extractRows(await client.query({
      query: `
SELECT
  TO_HEX(SHA256(CONCAT(
    COALESCE(CAST(re.refund_id AS STRING), ''),
    '|',
    COALESCE(CAST(re.line_item_id AS STRING), ''),
    '|',
    COALESCE(CAST(re.order_id AS STRING), ''),
    '|',
    COALESCE(CAST(re.sku AS STRING), ''),
    '|',
    COALESCE(CAST(re.refund_date AS STRING), ''),
    '|',
    COALESCE(CAST(re.quantity AS STRING), ''),
    '|',
    COALESCE(CAST(re.refund_subtotal AS STRING), '')
  ))) AS refund_id,
  CAST(re.refund_id AS STRING) AS source_refund_id,
  CAST(re.line_item_id AS STRING) AS line_item_id,
  CAST(re.order_id AS STRING) AS order_id,
  CAST(o.order_name AS STRING) AS order_no,
  CAST(re.sku AS STRING) AS sku,
  CAST(re.refund_date AS STRING) AS refund_date,
  CAST(re.quantity AS STRING) AS source_refund_quantity,
  CAST(re.refund_subtotal AS STRING) AS source_refund_subtotal,
  COALESCE(re.quantity, 0) AS refund_quantity,
  COALESCE(CAST(re.refund_subtotal AS NUMERIC) * COALESCE(CAST(o.usd_fx_rate AS NUMERIC), 1), 0) AS refund_subtotal_usd
FROM \`julang-dev-database.shopify_dwd.dwd_refund_events\` re
JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact_usd\` o
  ON re.order_id = o.order_id
WHERE re.refund_date BETWEEN DATE(@date_from) AND DATE(@date_to)
      `,
      params: { date_from: dateFrom, date_to: dateTo },
    }))

    return rows.map((row) => {
      const orderId = String(row.order_id ?? '')
      const sku = normalizeNullableText(row.sku)
      const refundDate = String(row.refund_date ?? '')
      const sourceRefundId = normalizeNullableText(row.source_refund_id ?? row.refund_id)
      const lineItemId = normalizeNullableText(row.line_item_id)
      const refundQuantity = Number(row.refund_quantity ?? 0)
      const refundSubtotalUsd = Number(row.refund_subtotal_usd ?? 0)
      const returnedRefundId = String(row.refund_id ?? '').trim()
      const isSqlHash = /^[0-9a-f]{64}$/i.test(returnedRefundId)
      const refundId =
        returnedRefundId && (!lineItemId || isSqlHash)
          ? returnedRefundId
          : stableSyntheticId([
              sourceRefundId,
              lineItemId,
              orderId,
              sku,
              refundDate,
              row.source_refund_quantity ?? refundQuantity,
              row.source_refund_subtotal ?? refundSubtotalUsd,
            ])
      return {
        refund_id: refundId,
        order_id: orderId,
        order_no: String(row.order_no ?? ''),
        sku,
        refund_date: refundDate,
        refund_quantity: refundQuantity,
        refund_subtotal_usd: refundSubtotalUsd,
      }
    }).filter((row) => row.refund_id && row.order_id && row.order_no && row.refund_date)
  }

  private async fetchBigQueryOrderLines(
    client: BigQueryLike,
    dateFrom: string,
    dateTo: string,
  ): Promise<SqliteShopifyOrderLine[]> {
    const rows = extractRows(await client.query({
      query: `
SELECT
  o.order_name AS order_no,
  CAST(o.processed_date AS STRING) AS processed_date,
  sku,
  COALESCE(sku_dim.skc_id, skc) AS skc,
  sku_dim.spu_id AS spu,
  1 AS quantity
FROM \`julang-dev-database.shopify_dwd.dwd_orders_fact\` o
LEFT JOIN UNNEST(IFNULL(o.skus, [])) AS sku WITH OFFSET sku_offset
LEFT JOIN UNNEST(IFNULL(o.skcs, [])) AS skc WITH OFFSET skc_offset
  ON skc_offset = sku_offset
LEFT JOIN \`julang-dev-database.product_information_database.dim_product_sku\` sku_dim
  ON sku_dim.sku_id = sku
WHERE o.processed_date BETWEEN DATE(@date_from) AND DATE(@date_to)
      `,
      params: {
        date_from: dateFrom,
        date_to: dateTo,
      },
    }))

    return rows.map((row) => ({
      order_no: String(row.order_no ?? ''),
      processed_date: String(row.processed_date ?? ''),
      sku: normalizeNullableText(row.sku),
      skc: normalizeNullableText(row.skc),
      spu: normalizeNullableText(row.spu),
      quantity: Number(row.quantity ?? 1),
    })).filter((row) => row.order_no && row.processed_date)
  }

  private async fetchBigQueryRefundEvents(
    client: BigQueryLike,
    dateFrom: string,
    dateTo: string,
  ): Promise<SqliteShopifyRefundEvent[]> {
    const rows = extractRows(await client.query({
      query: `
SELECT
  o.order_name AS order_no,
  re.sku,
  CAST(re.refund_date AS STRING) AS refund_date
FROM \`julang-dev-database.shopify_dwd.dwd_refund_events\` re
JOIN \`julang-dev-database.shopify_dwd.dwd_orders_fact\` o
  ON o.order_id = re.order_id
WHERE re.refund_date BETWEEN DATE(@date_from) AND DATE(@date_to)
      `,
      params: {
        date_from: dateFrom,
        date_to: dateTo,
      },
    }))

    return rows.map((row) => ({
      order_no: String(row.order_no ?? ''),
      sku: normalizeNullableText(row.sku),
      refund_date: String(row.refund_date ?? ''),
    })).filter((row) => row.order_no && row.refund_date)
  }

  private syncToSqlite(
    sqlitePath: string,
    records: SqliteMirrorRecord[],
    pruneMissing: boolean,
    logger: SyncLogger,
  ): SyncSqliteSummary {
    let repository: SqliteMirrorRepository | null = null
    try {
      repository = this.createSqliteRepository(sqlitePath)
      const stats = repository.syncRecords(records, { pruneMissing })
      logger.info(
        `SQLite mirror synced to ${sqlitePath}: inserted=${stats.inserted}, updated=${stats.updated}, deleted=${stats.deleted}, prune_missing=${pruneMissing}.`,
      )
      return {
        enabled: true,
        ok: true,
        path: sqlitePath,
        ...stats,
      }
    } catch (error) {
      logger.error(
        `SQLite mirror sync failed for ${sqlitePath}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return {
        enabled: true,
        ok: false,
        path: sqlitePath,
        inserted: 0,
        updated: 0,
        deleted: 0,
        sqlite_failed: 1,
      }
    } finally {
      repository?.close()
    }
  }

  async syncCsv(options: SyncCsvOptions) {
    const source = parseCsvRows(options.source)
    const target = options.target ? parseCsvRows(options.target) : null
    const dateFilter = buildDateFilter(options as SyncDateFilterInput)
    const filteredRows = filterRowsByDate(source.rows, dateFilter)
    const results = filteredRows.map(([sourceKey, row]) => transformSourceRecord(sourceKey, row))
    console.log(
      `${new Date().toISOString()} INFO Starting sync-csv for ${options.source} (filtered ${filteredRows.length}/${source.rows.length} rows).`,
    )

    return {
      mode: 'sync-csv',
      source: {
        path: options.source,
        rowCount: source.rows.length,
        headers: source.headers,
      },
      target: target
        ? {
            path: options.target,
            rowCount: target.rows.length,
            headers: target.headers,
          }
        : null,
      dateFilter,
      summary: summarizeResults(results),
      samples: results.slice(0, 3).flatMap((result) => result.records.slice(0, 2)),
    }
  }
}

export function maskSyncConfig(config: SyncConfig) {
  return {
    ...config,
    feishu: {
      ...config.feishu,
      app_secret: config.feishu.app_secret ? '***' : '',
    },
  }
}

export function createMockFeishuRecord(record_id: string, fields: Record<string, unknown>): FeishuRecord {
  return { record_id, fields }
}
