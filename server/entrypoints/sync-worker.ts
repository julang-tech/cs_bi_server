import { loadEnv } from '../config/env.js'
import { SyncService, createLogger } from '../domain/sync/service.js'
import { loadSyncConfig, resolveRuntimePath } from '../integrations/sync-config.js'

type WorkerLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

type WorkerService = {
  syncTargetToSqlite: (options: { config: string }) => Promise<{
    created: number
    updated: number
    failed: number
    sqlite: {
      ok: boolean
      inserted: number
      updated: number
      deleted: number
      sqlite_failed: number
    }
    bigquery_cache?: {
      enabled: boolean
      ok: boolean
      order_lines_upserted: number
      refund_events_upserted: number
      failed: number
    }
  }>
}

export function createSyncWorker(options: {
  configPath: string
  service?: WorkerService
  logger?: WorkerLogger
  intervalMs?: number
}) {
  const config = loadSyncConfig(options.configPath)
  const service = options.service ?? new SyncService()
  const logger =
    options.logger ??
    createLogger(resolveRuntimePath(options.configPath, config.runtime.log_path))
  const intervalMs =
    options.intervalMs ?? (config.runtime.refresh_interval_minutes ?? 120) * 60 * 1000
  let interval: NodeJS.Timeout | null = null
  let running = false

  async function runOnce(trigger: 'startup' | 'interval') {
    if (running) {
      logger.warn(`Skipping ${trigger} sync tick because the previous run is still in progress.`)
      return
    }

    running = true
    logger.info(`Sync worker ${trigger} run started.`)
    try {
      const result = await service.syncTargetToSqlite({ config: options.configPath })
      if (!result.sqlite.ok) {
        logger.error('Sync worker run completed with SQLite failure.')
      } else if (result.bigquery_cache?.enabled && !result.bigquery_cache.ok) {
        logger.error('Sync worker run completed with BigQuery cache failure.')
      } else {
        logger.info(
          `Sync worker run finished: created=${result.created}, updated=${result.updated}, failed=${result.failed}, sqlite_inserted=${result.sqlite.inserted}, sqlite_updated=${result.sqlite.updated}, sqlite_deleted=${result.sqlite.deleted}, bigquery_cache_enabled=${result.bigquery_cache?.enabled ?? false}, bigquery_order_lines=${result.bigquery_cache?.order_lines_upserted ?? 0}, bigquery_refund_events=${result.bigquery_cache?.refund_events_upserted ?? 0}.`,
        )
      }
    } catch (error) {
      logger.error(
        `Sync worker run failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      running = false
    }
  }

  function start() {
    void runOnce('startup')
    interval = setInterval(() => {
      void runOnce('interval')
    }, intervalMs)
    return intervalMs
  }

  function stop() {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
  }

  return {
    start,
    stop,
    runOnce,
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const env = loadEnv()
  const worker = createSyncWorker({ configPath: env.syncConfigPath })
  worker.start()
}
