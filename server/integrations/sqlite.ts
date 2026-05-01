import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TtlCache } from '../domain/p3/cache.js'
import type {
  IssueProvider,
  OrderEnrichmentRepository,
  OrderLineContext,
  P3Filters,
  ProductSalesPoint,
  SalesRepository,
  SourceBundle,
  StandardIssueRecord,
  SummaryMetrics,
  TrendPoint,
} from '../domain/p3/models.js'

type SqliteLogger = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

export type SqliteMirrorRecord = {
  record_id: string
  source_record_id: string
  source_record_index: number
  synced_at: string
  fields: Record<string, unknown>
}

export type SqliteSyncStats = {
  inserted: number
  updated: number
  deleted: number
  sqlite_failed: number
}

export type SqliteSyncMode = {
  pruneMissing: boolean
}

type PersistedRow = {
  record_id: string
  source_record_id: string
  source_record_index: number
  synced_at: string
  fields_json: string
}

export type SqliteShopifyOrderLine = {
  order_no: string
  processed_date: string
  sku: string | null
  skc: string | null
  spu: string | null
  quantity: number
}

export type SqliteShopifyRefundEvent = {
  order_no: string
  sku: string | null
  refund_date: string
}

export type BigQueryCacheSyncStats = {
  order_lines_upserted: number
  refund_events_upserted: number
}

type ShopifyOrderLineRow = SqliteShopifyOrderLine & {
  synced_at: string
}

type ShopifyRefundEventRow = SqliteShopifyRefundEvent & {
  synced_at: string
}

const ISSUE_VIEW_TO_MAJOR_TYPE = {
  '1-3待跟进表-货品瑕疵': 'product',
  '1-2待跟进表-漏发、发错': 'warehouse',
  '1-4待跟进表-物流问题': 'logistics',
} as const

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function normalizeText(value: unknown): string | null {
  if (value == null) {
    return null
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => normalizeText(item)).filter(Boolean)
    return parts.length ? parts.join(', ') : null
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['text', 'name', 'email', 'value']) {
      if (key in record) {
        return normalizeText(record[key])
      }
    }
    return null
  }
  const text = String(value).trim()
  return text || null
}

function inferMajorIssueType(fields: Record<string, unknown>) {
  const view = normalizeText(fields['命中视图'])
  if (view && view in ISSUE_VIEW_TO_MAJOR_TYPE) {
    return ISSUE_VIEW_TO_MAJOR_TYPE[view as keyof typeof ISSUE_VIEW_TO_MAJOR_TYPE]
  }

  if (normalizeText(fields['瑕疵原因'])) {
    return 'product'
  }
  if (normalizeText(fields['错/漏发原因'])) {
    return 'warehouse'
  }
  if (normalizeText(fields['物流-跟进结果'])) {
    return 'logistics'
  }
  return null
}

function inferMinorIssueType(
  fields: Record<string, unknown>,
  majorIssueType: NonNullable<ReturnType<typeof inferMajorIssueType>>,
) {
  const primary = normalizeText(fields['客诉类型'])
  if (primary) {
    return primary
  }
  if (majorIssueType === 'warehouse') {
    return normalizeText(fields['错/漏发原因']) ?? '仓库问题-其他'
  }
  if (majorIssueType === 'product') {
    return normalizeText(fields['瑕疵原因']) ?? '产品问题-其他'
  }
  return normalizeText(fields['物流-跟进结果']) ?? '物流问题-其他'
}

function parseIsoDate(rawValue: unknown) {
  const text = normalizeText(rawValue)
  if (!text) {
    return null
  }

  if (/^\d+$/.test(text)) {
    const timestamp = Number(text)
    const millis = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp
    const date = new Date(millis)
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10)
    }
  }

  const normalized = text.replace(/\//g, '-')
  const date = new Date(normalized.includes('T') ? normalized : normalized.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toISOString().slice(0, 10)
}

function stringifyJson(value: unknown) {
  return JSON.stringify(value ?? null)
}

function normalizeSku(value: unknown) {
  return normalizeText(value)?.toUpperCase() ?? ''
}

function startOfWeekMonday(dateText: string) {
  const date = new Date(`${dateText}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) {
    return dateText
  }
  const day = date.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  date.setUTCDate(date.getUTCDate() + diff)
  return date.toISOString().slice(0, 10)
}

function bucketDate(dateText: string, grain: P3Filters['grain']) {
  if (grain === 'day') {
    return dateText
  }
  if (grain === 'week') {
    return startOfWeekMonday(dateText)
  }
  return dateText.slice(0, 7) + '-01'
}

function uniqueOrderCount(rows: Array<{ order_no: string }>) {
  return new Set(rows.map((row) => row.order_no)).size
}

export class SqliteMirrorRepository {
  private readonly db: DatabaseSync

  constructor(private readonly dbPath: string) {
    ensureParentDir(dbPath)
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    this.ensureSchema()
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feishu_target_records (
        record_id TEXT NOT NULL,
        source_record_id TEXT NOT NULL,
        source_record_index INTEGER NOT NULL,
        synced_at TEXT NOT NULL,
        deleted_at TEXT,
        fields_json TEXT NOT NULL,
        order_no TEXT,
        record_date TEXT,
        customer_email TEXT,
        complaint_sku TEXT,
        complaint_type TEXT,
        complaint_solution TEXT,
        pending_note TEXT,
        hit_view TEXT,
        warehouse_reason TEXT,
        product_reason TEXT,
        logistics_process TEXT,
        logistics_result TEXT,
        resolution_note TEXT,
        logistics_no TEXT,
        logistics_status TEXT,
        status TEXT,
        PRIMARY KEY (source_record_id, source_record_index)
      );
    `)
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_target_records_record_id ON feishu_target_records(record_id);',
    )
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_feishu_target_records_active ON feishu_target_records(deleted_at, order_no);',
    )
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shopify_order_lines (
        order_no TEXT NOT NULL,
        processed_date TEXT NOT NULL,
        sku TEXT,
        skc TEXT,
        spu TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (order_no, sku, skc, spu)
      );
    `)
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_shopify_order_lines_date ON shopify_order_lines(processed_date);',
    )
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_shopify_order_lines_product ON shopify_order_lines(sku, skc, spu);',
    )
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shopify_refund_events (
        order_no TEXT NOT NULL,
        sku TEXT,
        refund_date TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (order_no, sku, refund_date)
      );
    `)
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_shopify_refund_events_order ON shopify_refund_events(order_no);',
    )
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bigquery_cache_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        date_from TEXT NOT NULL,
        date_to TEXT NOT NULL,
        ok INTEGER NOT NULL,
        order_lines_upserted INTEGER NOT NULL DEFAULT 0,
        refund_events_upserted INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
    `)
  }

  syncRecords(records: SqliteMirrorRecord[], mode: SqliteSyncMode = { pruneMissing: true }): SqliteSyncStats {
    const stats: SqliteSyncStats = {
      inserted: 0,
      updated: 0,
      deleted: 0,
      sqlite_failed: 0,
    }

    const isFullTargetMirrorRebuild =
      mode.pruneMissing &&
      records.every(
        (record) =>
          record.record_id === record.source_record_id && record.source_record_index === 0,
      )

    const upsert = this.db.prepare(`
      INSERT INTO feishu_target_records (
        record_id,
        source_record_id,
        source_record_index,
        synced_at,
        deleted_at,
        fields_json,
        order_no,
        record_date,
        customer_email,
        complaint_sku,
        complaint_type,
        complaint_solution,
        pending_note,
        hit_view,
        warehouse_reason,
        product_reason,
        logistics_process,
        logistics_result,
        resolution_note,
        logistics_no,
        logistics_status,
        status
      ) VALUES (
        :record_id,
        :source_record_id,
        :source_record_index,
        :synced_at,
        NULL,
        :fields_json,
        :order_no,
        :record_date,
        :customer_email,
        :complaint_sku,
        :complaint_type,
        :complaint_solution,
        :pending_note,
        :hit_view,
        :warehouse_reason,
        :product_reason,
        :logistics_process,
        :logistics_result,
        :resolution_note,
        :logistics_no,
        :logistics_status,
        :status
      )
      ON CONFLICT(source_record_id, source_record_index) DO UPDATE SET
        record_id = excluded.record_id,
        synced_at = excluded.synced_at,
        deleted_at = NULL,
        fields_json = excluded.fields_json,
        order_no = excluded.order_no,
        record_date = excluded.record_date,
        customer_email = excluded.customer_email,
        complaint_sku = excluded.complaint_sku,
        complaint_type = excluded.complaint_type,
        complaint_solution = excluded.complaint_solution,
        pending_note = excluded.pending_note,
        hit_view = excluded.hit_view,
        warehouse_reason = excluded.warehouse_reason,
        product_reason = excluded.product_reason,
        logistics_process = excluded.logistics_process,
        logistics_result = excluded.logistics_result,
        resolution_note = excluded.resolution_note,
        logistics_no = excluded.logistics_no,
        logistics_status = excluded.logistics_status,
        status = excluded.status;
    `)

    const remove = this.db.prepare(
      'DELETE FROM feishu_target_records WHERE source_record_id = ? AND source_record_index = ?',
    )

    this.db.exec('BEGIN')
    try {
      let existingRows = this.db
        .prepare(`
          SELECT record_id, source_record_id, source_record_index
          FROM feishu_target_records
        `)
        .all() as Array<{
          record_id: string
          source_record_id: string
          source_record_index: number
        }>

      if (
        isFullTargetMirrorRebuild &&
        existingRows.some((row) => row.record_id !== row.source_record_id)
      ) {
        this.db.prepare('DELETE FROM feishu_target_records').run()
        stats.deleted += existingRows.length
        existingRows = []
      }

      const existingKeys = new Set(
        existingRows.map((row) => `${row.source_record_id}#${row.source_record_index}`),
      )
      const nextKeys = new Set(
        records.map((record) => `${record.source_record_id}#${record.source_record_index}`),
      )

      for (const item of records) {
        const key = `${item.source_record_id}#${item.source_record_index}`
        const fields = item.fields
        upsert.run({
          record_id: item.record_id,
          source_record_id: item.source_record_id,
          source_record_index: item.source_record_index,
          synced_at: item.synced_at,
          fields_json: stringifyJson(fields),
          order_no: normalizeText(fields['订单号']),
          record_date: parseIsoDate(fields['记录日期']),
          customer_email: normalizeText(fields['客户邮箱']),
          complaint_sku: normalizeText(fields['客诉SKU']),
          complaint_type: normalizeText(fields['客诉类型']),
          complaint_solution: normalizeText(fields['客诉方案']),
          pending_note: normalizeText(fields['待跟进客诉备注']),
          hit_view: normalizeText(fields['命中视图']),
          warehouse_reason: normalizeText(fields['错/漏发原因']),
          product_reason: normalizeText(fields['瑕疵原因']),
          logistics_process: normalizeText(fields['物流-跟进过程']),
          logistics_result: normalizeText(fields['物流-跟进结果']),
          resolution_note: normalizeText(fields['解决方案']),
          logistics_no: normalizeText(fields['物流号']),
          logistics_status: normalizeText(fields['物流状态']),
          status: normalizeText(fields['问题处理状态']),
        })

        if (existingKeys.has(key)) {
          stats.updated += 1
        } else {
          stats.inserted += 1
        }
      }

      if (mode.pruneMissing) {
        for (const row of existingRows) {
          const key = `${row.source_record_id}#${row.source_record_index}`
          if (nextKeys.has(key)) {
            continue
          }
          remove.run(row.source_record_id, row.source_record_index)
          stats.deleted += 1
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return stats
  }

  listActiveRows() {
    const rows = this.db
      .prepare(`
        SELECT record_id, source_record_id, source_record_index, synced_at, fields_json
        FROM feishu_target_records
        WHERE deleted_at IS NULL
        ORDER BY source_record_id ASC, source_record_index ASC
      `)
      .all() as PersistedRow[]

    return rows.map((row) => ({
      record_id: row.record_id,
      source_record_id: row.source_record_id,
      source_record_index: row.source_record_index,
      synced_at: row.synced_at,
      fields: JSON.parse(row.fields_json) as Record<string, unknown>,
    }))
  }

  replaceBigQueryCacheWindow(input: {
    dateFrom: string
    dateTo: string
    orderLines: SqliteShopifyOrderLine[]
    refundEvents: SqliteShopifyRefundEvent[]
    startedAt?: string
    finishedAt?: string
  }): BigQueryCacheSyncStats {
    const startedAt = input.startedAt ?? new Date().toISOString()
    const finishedAt = input.finishedAt ?? new Date().toISOString()
    const syncedAt = finishedAt
    const deleteOrderLines = this.db.prepare(
      'DELETE FROM shopify_order_lines WHERE processed_date BETWEEN ? AND ?',
    )
    const deleteRefundEvents = this.db.prepare(
      'DELETE FROM shopify_refund_events WHERE refund_date BETWEEN ? AND ?',
    )
    const insertOrderLine = this.db.prepare(`
      INSERT INTO shopify_order_lines (
        order_no, processed_date, sku, skc, spu, quantity, synced_at
      ) VALUES (
        :order_no, :processed_date, :sku, :skc, :spu, :quantity, :synced_at
      )
      ON CONFLICT(order_no, sku, skc, spu) DO UPDATE SET
        processed_date = excluded.processed_date,
        quantity = excluded.quantity,
        synced_at = excluded.synced_at;
    `)
    const insertRefundEvent = this.db.prepare(`
      INSERT INTO shopify_refund_events (
        order_no, sku, refund_date, synced_at
      ) VALUES (
        :order_no, :sku, :refund_date, :synced_at
      )
      ON CONFLICT(order_no, sku, refund_date) DO UPDATE SET
        synced_at = excluded.synced_at;
    `)
    const insertRun = this.db.prepare(`
      INSERT INTO bigquery_cache_runs (
        started_at, finished_at, date_from, date_to, ok,
        order_lines_upserted, refund_events_upserted, error
      ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL)
    `)

    this.db.exec('BEGIN')
    try {
      deleteOrderLines.run(input.dateFrom, input.dateTo)
      deleteRefundEvents.run(input.dateFrom, input.dateTo)
      for (const line of input.orderLines) {
        if (!line.order_no || !line.processed_date) {
          continue
        }
        insertOrderLine.run({
          order_no: line.order_no,
          processed_date: line.processed_date,
          sku: line.sku,
          skc: line.skc,
          spu: line.spu,
          quantity: line.quantity || 1,
          synced_at: syncedAt,
        })
      }
      for (const event of input.refundEvents) {
        if (!event.order_no || !event.refund_date) {
          continue
        }
        insertRefundEvent.run({
          order_no: event.order_no,
          sku: event.sku,
          refund_date: event.refund_date,
          synced_at: syncedAt,
        })
      }
      insertRun.run(
        startedAt,
        finishedAt,
        input.dateFrom,
        input.dateTo,
        input.orderLines.length,
        input.refundEvents.length,
      )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    return {
      order_lines_upserted: input.orderLines.length,
      refund_events_upserted: input.refundEvents.length,
    }
  }

  recordBigQueryCacheFailure(input: {
    dateFrom: string
    dateTo: string
    startedAt?: string
    finishedAt?: string
    error: string
  }) {
    this.db
      .prepare(`
        INSERT INTO bigquery_cache_runs (
          started_at, finished_at, date_from, date_to, ok, error
        ) VALUES (?, ?, ?, ?, 0, ?)
      `)
      .run(
        input.startedAt ?? new Date().toISOString(),
        input.finishedAt ?? new Date().toISOString(),
        input.dateFrom,
        input.dateTo,
        input.error,
      )
  }

  listOrderLines(filters: P3Filters): ShopifyOrderLineRow[] {
    const rows = this.db
      .prepare(`
        SELECT order_no, processed_date, sku, skc, spu, quantity, synced_at
        FROM shopify_order_lines
        WHERE processed_date BETWEEN ? AND ?
        ORDER BY processed_date ASC, order_no ASC
      `)
      .all(filters.date_from, filters.date_to) as ShopifyOrderLineRow[]

    return rows.filter((row) => {
      if (filters.sku && row.sku !== filters.sku) {
        return false
      }
      if (filters.skc && row.skc !== filters.skc) {
        return false
      }
      if (filters.spu && row.spu !== filters.spu) {
        return false
      }
      return true
    })
  }

  listOrderLinesByOrderNos(orderNos: string[]): ShopifyOrderLineRow[] {
    if (!orderNos.length) {
      return []
    }
    const rows = this.db
      .prepare('SELECT order_no, processed_date, sku, skc, spu, quantity, synced_at FROM shopify_order_lines')
      .all() as ShopifyOrderLineRow[]
    const allowed = new Set(orderNos)
    return rows.filter((row) => allowed.has(row.order_no))
  }

  listRefundEventsByOrderNos(orderNos: string[]): ShopifyRefundEventRow[] {
    if (!orderNos.length) {
      return []
    }
    const rows = this.db
      .prepare('SELECT order_no, sku, refund_date, synced_at FROM shopify_refund_events')
      .all() as ShopifyRefundEventRow[]
    const allowed = new Set(orderNos)
    return rows.filter((row) => allowed.has(row.order_no))
  }

  hasBigQueryCacheRows() {
    const row = this.db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM shopify_order_lines) AS order_lines, (SELECT COUNT(*) FROM shopify_refund_events) AS refund_events',
      )
      .get() as { order_lines: number; refund_events: number }
    return Number(row.order_lines ?? 0) > 0 || Number(row.refund_events ?? 0) > 0
  }

  unsafeDatabaseForTest() {
    return this.db
  }

  close() {
    this.db.close()
  }
}

export class SqliteP3BigQueryCacheRepository implements SalesRepository, OrderEnrichmentRepository {
  private readonly summaryCache = new TtlCache<SummaryMetrics>(300_000)
  private readonly trendCache = new TtlCache<TrendPoint[]>(300_000)
  private readonly productSalesCache = new TtlCache<ProductSalesPoint[]>(300_000)

  constructor(
    private readonly dbPath: string,
    private readonly logger?: SqliteLogger,
  ) {}

  async fetchSummary(filters: P3Filters): Promise<SummaryMetrics> {
    const cacheKey = JSON.stringify(['summary', filters])
    const cached = this.summaryCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const result = this.withRepository((repository) => ({
      sales_qty: uniqueOrderCount(repository.listOrderLines(filters)),
      complaint_count: 0,
    }))
    return this.summaryCache.set(cacheKey, result)
  }

  async fetchTrends(filters: P3Filters): Promise<TrendPoint[]> {
    const cacheKey = JSON.stringify(['trends', filters])
    const cached = this.trendCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const result = this.withRepository((repository) => {
      const buckets = new Map<string, Set<string>>()
      for (const row of repository.listOrderLines(filters)) {
        const bucket = bucketDate(row.processed_date, filters.grain)
        buckets.set(bucket, (buckets.get(bucket) ?? new Set()).add(row.order_no))
      }
      return [...buckets.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([bucket, orderNos]) => ({
          bucket,
          sales_qty: orderNos.size,
          complaint_count: 0,
        }))
    })
    return this.trendCache.set(cacheKey, result)
  }

  async fetchProductSales(filters: P3Filters): Promise<ProductSalesPoint[]> {
    const cacheKey = JSON.stringify(['product-sales', filters])
    const cached = this.productSalesCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const result = this.withRepository((repository) => {
      const grouped = new Map<string, { spu: string; skc: string; orderNos: Set<string> }>()
      for (const row of repository.listOrderLines(filters)) {
        if (!row.spu || !row.skc) {
          continue
        }
        const key = `${row.spu}\u0000${row.skc}`
        grouped.set(
          key,
          grouped.get(key) ?? { spu: row.spu, skc: row.skc, orderNos: new Set<string>() },
        )
        grouped.get(key)?.orderNos.add(row.order_no)
      }
      return [...grouped.values()].map((item) => ({
        spu: item.spu,
        skc: item.skc,
        sales_qty: item.orderNos.size,
      }))
    })
    return this.productSalesCache.set(cacheKey, result)
  }

  async enrichIssues(issues: StandardIssueRecord[]) {
    const orderNos = [...new Set(issues.map((issue) => issue.order_no).filter(Boolean))].sort()
    if (!orderNos.length) {
      return { issues, notes: [] }
    }

    return this.withRepository((repository) => {
      if (!repository.hasBigQueryCacheRows()) {
        return {
          issues: issues.map((issue) => ({
            ...issue,
            order_date: issue.order_date ?? issue.record_date ?? null,
          })),
          notes: ['SQLite BigQuery cache has no Shopify order/refund rows.'],
        }
      }

      const lineRows = repository.listOrderLinesByOrderNos(orderNos)
      const refundRows = repository.listRefundEventsByOrderNos(orderNos)
      const lineByOrder = new Map<string, OrderLineContext[]>()
      const orderDateByOrder = new Map<string, string>()
      const refundsByOrder = new Map<
        string,
        { earliest: string | null; bySku: Map<string, string> }
      >()

      for (const row of lineRows) {
        const lineItems = lineByOrder.get(row.order_no) ?? []
        if (row.sku) {
          lineItems.push({
            sku: row.sku,
            quantity: Number(row.quantity ?? 1),
            skc: row.skc,
            spu: row.spu,
          })
        }
        lineByOrder.set(row.order_no, lineItems)
        if (!orderDateByOrder.has(row.order_no) || row.processed_date < orderDateByOrder.get(row.order_no)!) {
          orderDateByOrder.set(row.order_no, row.processed_date)
        }
      }

      for (const row of refundRows) {
        const bucket = refundsByOrder.get(row.order_no) ?? {
          earliest: null,
          bySku: new Map<string, string>(),
        }
        if (!bucket.earliest || row.refund_date < bucket.earliest) {
          bucket.earliest = row.refund_date
        }
        const skuKey = normalizeSku(row.sku)
        if (skuKey) {
          const current = bucket.bySku.get(skuKey)
          if (!current || row.refund_date < current) {
            bucket.bySku.set(skuKey, row.refund_date)
          }
        }
        refundsByOrder.set(row.order_no, bucket)
      }

      const notes: string[] = []
      const enriched = issues.map((issue) => {
        const lineItems = lineByOrder.get(issue.order_no) ?? []
        const matchedLine = this.matchLineItem(issue, lineItems)
        const refundContext = refundsByOrder.get(issue.order_no)

        if (!lineItems.length) {
          notes.push(
            `Missing SQLite BigQuery cache order enrichment for ${issue.order_no}; fell back to record_date when available.`,
          )
        }

        return {
          ...issue,
          order_date: orderDateByOrder.get(issue.order_no) ?? issue.order_date ?? issue.record_date ?? null,
          refund_date: this.resolveRefundDate(issue, refundContext) ?? issue.refund_date ?? null,
          order_line_contexts: lineItems.length ? lineItems : issue.order_line_contexts,
          skc: matchedLine?.skc ?? issue.skc ?? null,
          spu: matchedLine?.spu ?? issue.spu ?? null,
        }
      })

      this.logger?.info?.(`Enriched ${enriched.length} P3 issues from SQLite BigQuery cache.`)
      return { issues: enriched, notes }
    })
  }

  private resolveRefundDate(
    issue: StandardIssueRecord,
    refundContext: { earliest: string | null; bySku: Map<string, string> } | undefined,
  ) {
    if (!refundContext) {
      return null
    }
    if (issue.major_issue_type === 'logistics' || issue.is_order_level_only) {
      return refundContext.earliest
    }
    const skuKey = normalizeSku(issue.sku)
    return (skuKey ? refundContext.bySku.get(skuKey) : null) ?? refundContext.earliest
  }

  private matchLineItem(issue: StandardIssueRecord, lineItems: OrderLineContext[]) {
    if (issue.sku) {
      const issueSku = normalizeSku(issue.sku)
      const matched = lineItems.find((lineItem) => normalizeSku(lineItem.sku) === issueSku)
      if (matched) {
        return matched
      }
    }
    return lineItems[0]
  }

  private withRepository<T>(callback: (repository: SqliteMirrorRepository) => T): T {
    if (!fs.existsSync(this.dbPath)) {
      this.logger?.warn?.(`SQLite BigQuery cache not found at ${this.dbPath}.`)
    }
    const repository = new SqliteMirrorRepository(this.dbPath)
    try {
      return callback(repository)
    } finally {
      repository.close()
    }
  }
}

export class SqliteIssueProvider implements IssueProvider {
  private readonly cache = new TtlCache<SourceBundle>(300_000)

  constructor(
    private readonly repoRoot: string,
    private readonly dbPath: string,
    private readonly logger?: SqliteLogger,
  ) {}

  async getSourceBundle(): Promise<SourceBundle> {
    const cached = this.cache.get('sqlite_source_bundle')
    if (cached) {
      return cached
    }

    if (!fs.existsSync(this.dbPath)) {
      const bundle = {
        issues: [],
        notes: [`SQLite mirror not found at ${this.dbPath}.`],
        partial_data: true,
      }
      return this.cache.set('sqlite_source_bundle', bundle)
    }

    const repository = new SqliteMirrorRepository(this.dbPath)
    try {
      const rows = repository.listActiveRows()
      const issues: StandardIssueRecord[] = []
      const notes: string[] = []

      for (const row of rows) {
        const normalized = normalizeSqliteMirroredRecord(row)
        if (!normalized) {
          notes.push(
            `Skipped sqlite mirrored record ${row.record_id}: unable to map to a standard issue.`,
          )
          continue
        }
        issues.push(normalized)
      }

      this.logger?.info?.(`Loaded ${issues.length} issues from SQLite mirror.`)
      return this.cache.set('sqlite_source_bundle', {
        issues,
        notes,
        partial_data: notes.length > 0,
      })
    } finally {
      repository.close()
    }
  }
}

export function normalizeSqliteMirroredRecord(record: SqliteMirrorRecord): StandardIssueRecord | null {
  const orderNo = normalizeText(record.fields['订单号'])
  if (!orderNo) {
    return null
  }

  const majorIssueType = inferMajorIssueType(record.fields)
  if (!majorIssueType) {
    return null
  }

  return {
    source_system: 'sqlite_mirror',
    source_subtable: normalizeText(record.fields['命中视图']) ?? '',
    source_record_id: record.source_record_id,
    major_issue_type: majorIssueType,
    minor_issue_type: inferMinorIssueType(record.fields, majorIssueType),
    order_no: orderNo,
    record_date: parseIsoDate(record.fields['记录日期']),
    order_date: null,
    sku: normalizeText(record.fields['客诉SKU']),
    skc: null,
    spu: null,
    customer_email: normalizeText(record.fields['客户邮箱']),
    country: null,
    solution: normalizeText(record.fields['客诉方案']),
    is_order_level_only: majorIssueType === 'logistics',
    order_line_contexts: [],
    logistics_no: normalizeText(record.fields['物流号']),
    logistics_status: normalizeText(record.fields['物流状态']),
    process_note: normalizeText(record.fields['物流-跟进过程']),
    result_note: normalizeText(record.fields['物流-跟进结果']),
    resolution_note: normalizeText(record.fields['解决方案']),
    status: normalizeText(record.fields['问题处理状态']),
  }
}
