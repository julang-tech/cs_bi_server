import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TtlCache } from '../domain/p3/cache.js'
import type { IssueProvider, SourceBundle, StandardIssueRecord } from '../domain/p3/models.js'

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
  }

  syncRecords(records: SqliteMirrorRecord[], mode: SqliteSyncMode = { pruneMissing: true }): SqliteSyncStats {
    const stats: SqliteSyncStats = {
      inserted: 0,
      updated: 0,
      deleted: 0,
      sqlite_failed: 0,
    }

    const existingRows = this.db
      .prepare('SELECT source_record_id, source_record_index FROM feishu_target_records')
      .all() as Array<{ source_record_id: string; source_record_index: number }>
    const existingKeys = new Set(
      existingRows.map((row) => `${row.source_record_id}#${row.source_record_index}`),
    )
    const nextKeys = new Set(records.map((record) => `${record.source_record_id}#${record.source_record_index}`))

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

  close() {
    this.db.close()
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
