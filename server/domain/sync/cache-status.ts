import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { loadSyncConfig, resolveRuntimePath } from '../../integrations/sync-config.js'

type SqliteScalarRow = Record<string, unknown>

function readScalar<T extends SqliteScalarRow>(
  db: DatabaseSync,
  sql: string,
  params: unknown[] = [],
) {
  return db.prepare(sql).get(...(params as never[])) as T | undefined
}

function tableExists(db: DatabaseSync, tableName: string) {
  const row = readScalar<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName],
  )
  return Number(row?.count ?? 0) > 0
}

function latestSuccessRun(db: DatabaseSync, tableName: string, whereClause = '') {
  if (!tableExists(db, tableName)) {
    return null
  }
  const row = readScalar<{ date_from: string; date_to: string; finished_at: string | null }>(
    db,
    `
      SELECT date_from, date_to, finished_at
      FROM ${tableName}
      WHERE ok = 1 ${whereClause}
      ORDER BY finished_at DESC, id DESC
      LIMIT 1
    `,
  )
  if (!row) {
    return null
  }
  return {
    date_from: row.date_from,
    date_to: row.date_to,
    finished_at: row.finished_at,
  }
}

function countRows(db: DatabaseSync, tableName: string, whereClause = '') {
  if (!tableExists(db, tableName)) {
    return null
  }
  const row = readScalar<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM ${tableName} ${whereClause}`,
  )
  return Number(row?.count ?? 0)
}

function maxText(db: DatabaseSync, tableName: string, column: string) {
  if (!tableExists(db, tableName)) {
    return null
  }
  const row = readScalar<{ value: string | null }>(
    db,
    `SELECT MAX(${column}) AS value FROM ${tableName}`,
  )
  return row?.value ?? null
}

export function getSyncCacheStatus(configPath: string) {
  const config = loadSyncConfig(configPath)
  const sqlitePath = resolveRuntimePath(configPath, config.runtime.sqlite_path)
  const exists = fs.existsSync(sqlitePath)
  const base = {
    generated_at: new Date().toISOString(),
    config_path: configPath,
    sqlite: {
      path: sqlitePath,
      exists,
    },
  }

  if (!exists) {
    return {
      ...base,
      feishu_target_records: {
        available: false,
        active_count: 0,
        last_synced_at: null,
      },
      bigquery_cache: {
        available: false,
        latest_success: null,
        max_order_date: null,
        max_refund_date: null,
        order_lines_count: 0,
        refund_events_count: 0,
      },
      shopify_bi_cache: {
        available: false,
        latest_success: null,
        max_order_date: null,
        max_refund_date: null,
        orders_count: 0,
        order_lines_count: 0,
        refund_events_count: 0,
      },
    }
  }

  const db = new DatabaseSync(sqlitePath)
  try {
    const hasFeishuTargetRecords = tableExists(db, 'feishu_target_records')
    const hasBigQueryRuns = tableExists(db, 'bigquery_cache_runs')
    const hasShopifyBiRuns = tableExists(db, 'shopify_bi_cache_runs')

    return {
      ...base,
      feishu_target_records: {
        available: hasFeishuTargetRecords,
        active_count:
          countRows(db, 'feishu_target_records', 'WHERE deleted_at IS NULL') ?? 0,
        last_synced_at: maxText(db, 'feishu_target_records', 'synced_at'),
      },
      bigquery_cache: {
        available: hasBigQueryRuns,
        latest_success: latestSuccessRun(db, 'bigquery_cache_runs'),
        max_order_date: maxText(db, 'shopify_order_lines', 'processed_date'),
        max_refund_date: maxText(db, 'shopify_refund_events', 'refund_date'),
        order_lines_count: countRows(db, 'shopify_order_lines') ?? 0,
        refund_events_count: countRows(db, 'shopify_refund_events') ?? 0,
      },
      shopify_bi_cache: {
        available: hasShopifyBiRuns,
        latest_success: latestSuccessRun(
          db,
          'shopify_bi_cache_runs',
          "AND scope = 'shopify_bi_v2'",
        ),
        max_order_date: maxText(db, 'shopify_bi_orders', 'processed_date'),
        max_refund_date: maxText(db, 'shopify_bi_refund_events', 'refund_date'),
        orders_count: countRows(db, 'shopify_bi_orders') ?? 0,
        order_lines_count: countRows(db, 'shopify_bi_order_lines') ?? 0,
        refund_events_count: countRows(db, 'shopify_bi_refund_events') ?? 0,
      },
    }
  } finally {
    db.close()
  }
}
