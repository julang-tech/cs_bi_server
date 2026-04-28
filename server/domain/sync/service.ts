import fs from 'node:fs'
import path from 'node:path'
import { loadSyncConfig, resolveRuntimePath, type SyncConfig } from '../../integrations/sync-config.js'
import { FeishuTableClient, type FeishuField, type FeishuRecord } from '../../integrations/feishu.js'
import {
  SqliteMirrorRepository,
  type SqliteMirrorRecord,
  type SqliteSyncStats,
} from '../../integrations/sqlite.js'
import {
  inferLogisticsStatusFromShopify,
  matchSkuAmount,
  ShopifyClient,
  type ShopifyLikeClient,
} from '../../integrations/shopify.js'
import {
  buildDateFilter,
  filterRowsByDate,
  summarizeResults,
  transformSourceRecord,
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
}

export type SyncCsvOptions = {
  source: string
  target?: string
  date?: string
  from?: string
  to?: string
}

type FeishuSyncClient = Pick<FeishuTableClient, 'listRecords' | 'listFields' | 'createRecord' | 'updateRecord'>

type SyncServiceDeps = {
  createClient?: (config: SyncConfig, logger: SyncLogger) => FeishuSyncClient
  createShopifyClient?: (config: SyncConfig, logger: SyncLogger) => ShopifyLikeClient | null
  createSqliteRepository?: (dbPath: string) => SqliteMirrorRepository
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

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
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

  const orderCache = new Map<string, Awaited<ReturnType<ShopifyLikeClient['fetchOrder']>>>()
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

      if (!orderCache.has(orderNo)) {
        orderCache.set(orderNo, await shopifyClient.fetchOrder(orderNo))
      }
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

    const syncedIds: string[] = []
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
          syncedIds.push(updatedId)
          mirroredRecords.push({
            record_id: updatedId,
            source_record_id: result.source_key,
            source_record_index: index,
            synced_at: new Date().toISOString(),
            fields: sanitizedRecord,
          })
          counters.updated += 1
          logger.info(
            `${result.source_key} target ${index + 1}/${result.records.length} updated (${counters.created} created, ${counters.updated} updated).`,
          )
          continue
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('RecordIdNotFound')) {
            throw error
          }
          logger.warn(
            `${result.source_key} target record ${existingId} no longer exists; recreating target ${index + 1}/${result.records.length}.`,
          )
        }
      }

      const createdId = await client.createRecord(config.target, sanitizedRecord)
      syncedIds.push(createdId)
      mirroredRecords.push({
        record_id: createdId,
        source_record_id: result.source_key,
        source_record_index: index,
        synced_at: new Date().toISOString(),
        fields: sanitizedRecord,
      })
      counters.created += 1
      logger.info(
        `${result.source_key} target ${index + 1}/${result.records.length} created as ${createdId} (${counters.created} created, ${counters.updated} updated).`,
      )
    }

    state.source_to_target_ids[result.source_key] = syncedIds
    writeState(statePath, state)
    if (existingIds.length > result.records.length) {
      logger.warn(
        `${result.source_key} previously synced to ${existingIds.length} target records, now only ${result.records.length} records generated; extra target records were left untouched.`,
      )
    }
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

  constructor(deps: SyncServiceDeps = {}) {
    this.createClient =
      deps.createClient ?? ((config, logger) => new FeishuTableClient(config, logger))
    this.createShopifyClient =
      deps.createShopifyClient ?? ((config) => (config.shopify ? new ShopifyClient(config.shopify) : null))
    this.createSqliteRepository =
      deps.createSqliteRepository ?? ((dbPath) => new SqliteMirrorRepository(dbPath))
  }

  async preview(options: SyncCommandOptions) {
    const config = loadSyncConfig(options.config)
    const statePath = resolveStatePath(options.config, config)
    const logPath = resolveRuntimePath(options.config, config.runtime.log_path)
    const logger = createLogger(logPath)
    const dateFilter = buildDateFilter(options)
    const client = this.createClient(config, logger)
    const shopifyClient = this.createShopifyClient(config, logger)
    logger.info(`Starting preview with config ${options.config}.`)
    const filteredRows = filterRowsByDate(
      (await client.listRecords(config.source)).map((record) => [record.record_id, record.fields] as [string, Record<string, unknown>]),
      dateFilter,
    )
    const transformed = filteredRows.map(([sourceKey, row]) => transformSourceRecord(sourceKey, row))
    const enriched = await enrichResultsWithShopify(transformed, config, logger, shopifyClient)
    logger.info(`Filtered ${filteredRows.length} source rows for preview.`)
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
      ...synced.counters,
      diagnostics: [...synced.diagnostics, ...enriched.diagnostics],
    }
  }

  async sync(options: SyncCommandOptions) {
    const config = loadSyncConfig(options.config)
    const statePath = resolveStatePath(options.config, config)
    const logPath = resolveRuntimePath(options.config, config.runtime.log_path)
    const logger = createLogger(logPath)
    const dateFilter = buildDateFilter(options)
    const client = this.createClient(config, logger)
    const shopifyClient = this.createShopifyClient(config, logger)
    const sqlitePath = resolveRuntimePath(options.config, config.runtime.sqlite_path)
    logger.info(`Starting sync with config ${options.config}.`)
    const filteredRows = filterRowsByDate(
      (await client.listRecords(config.source)).map((record) => [record.record_id, record.fields] as [string, Record<string, unknown>]),
      dateFilter,
    )
    const transformed = filteredRows.map(([sourceKey, row]) => transformSourceRecord(sourceKey, row))
    const enriched = await enrichResultsWithShopify(transformed, config, logger, shopifyClient)
    logger.info(`Filtered ${filteredRows.length} source rows for sync.`)
    const synced = await syncResults(enriched.results, config, statePath, false, client, logger)
    const sqlite = this.syncToSqlite(
      sqlitePath,
      synced.mirroredRecords,
      dateFilter === null,
      logger,
    )
    if (!sqlite.ok) {
      synced.counters.failed += 1
    }
    logger.info(
      `Sync finished: scanned=${synced.counters.scanned}, created=${synced.counters.created}, updated=${synced.counters.updated}, failed=${synced.counters.failed}, sqlite_inserted=${sqlite.inserted}, sqlite_updated=${sqlite.updated}, sqlite_deleted=${sqlite.deleted}, sqlite_failed=${sqlite.sqlite_failed}.`,
    )

    return {
      mode: 'sync',
      config,
      statePath,
      dateFilter,
      summary: summarizeResults(enriched.results),
      enrichment_summary: enriched.summary,
      sqlite,
      ...synced.counters,
      diagnostics: [...synced.diagnostics, ...enriched.diagnostics],
      state: synced.state,
    }
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
