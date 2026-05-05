import { loadEnv } from '../config/env.js'
import { SyncService, createLogger } from '../domain/sync/service.js'
import { loadSyncConfig, resolveRuntimePath } from '../integrations/sync-config.js'

type WorkerLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

type WorkerService = {
  syncSourceToTarget: (options: { config: string; from?: string; to?: string }) => Promise<{
    scanned: number
    created: number
    updated: number
    failed: number
  }>
  syncTargetToSqlite: (options: { config: string; refreshBigQueryCache?: boolean; cacheTailDays?: number }) => Promise<{
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
    shopify_bi_cache?: {
      enabled: boolean
      ok: boolean
      orders_upserted: number
      order_lines_upserted: number
      refund_events_upserted: number
      failed: number
    }
  }>
  syncShopifyBiCacheIfDue?: (options: { config: string; cacheTailDays?: number }) => Promise<{
    enabled: boolean
    ok: boolean
    skipped?: boolean
    failed: number
  }>
}

type SyncWorkerTrigger = 'startup' | 'interval' | 'daily-full-refresh'

const DEFAULT_DAILY_FULL_REFRESH_TIME = '03:30'
const DEFAULT_BUSINESS_TIMEZONE_OFFSET_MINUTES = 8 * 60
const DEFAULT_SOURCE_WINDOW_DAYS = 2
const DEFAULT_CACHE_TAIL_DAYS = 7
const DEFAULT_REFRESH_CACHES_ON_STARTUP = true

export function buildSourceWindow(options: {
  now: Date
  days: number
  timezoneOffsetMinutes?: number
}): { from: string; to: string } | null {
  if (options.days <= 0) {
    return null
  }
  const offsetMs = (options.timezoneOffsetMinutes ?? DEFAULT_BUSINESS_TIMEZONE_OFFSET_MINUTES) * 60 * 1000
  const businessNow = new Date(options.now.getTime() + offsetMs)
  const formatDate = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  const to = formatDate(businessNow)
  const fromDate = new Date(businessNow.getTime() - (options.days - 1) * 24 * 60 * 60 * 1000)
  return { from: formatDate(fromDate), to }
}

export function millisecondsUntilNextDailyRun(options: {
  now: Date
  time: string
  timezoneOffsetMinutes?: number
}) {
  const match = /^(\d{2}):(\d{2})$/.exec(options.time)
  if (!match) {
    throw new Error(`Invalid daily full refresh time: ${options.time}`)
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) {
    throw new Error(`Invalid daily full refresh time: ${options.time}`)
  }

  const offsetMinutes =
    options.timezoneOffsetMinutes ?? DEFAULT_BUSINESS_TIMEZONE_OFFSET_MINUTES
  const offsetMs = offsetMinutes * 60 * 1000
  const businessNow = new Date(options.now.getTime() + offsetMs)
  let targetUtcMs =
    Date.UTC(
      businessNow.getUTCFullYear(),
      businessNow.getUTCMonth(),
      businessNow.getUTCDate(),
      hour,
      minute,
      0,
      0,
    ) - offsetMs

  if (targetUtcMs <= options.now.getTime()) {
    targetUtcMs += 24 * 60 * 60 * 1000
  }

  return targetUtcMs - options.now.getTime()
}

export function createSyncWorker(options: {
  configPath: string
  service?: WorkerService
  logger?: WorkerLogger
  intervalMs?: number
  dailyFullRefreshTime?: string
  timezoneOffsetMinutes?: number
  sourceWindowDays?: number
  cacheTailDays?: number
  refreshCachesOnStartup?: boolean
}) {
  const config = loadSyncConfig(options.configPath)
  const service = options.service ?? new SyncService()
  const logger =
    options.logger ??
    createLogger(resolveRuntimePath(options.configPath, config.runtime.log_path))
  const intervalMs =
    options.intervalMs ?? (config.runtime.refresh_interval_minutes ?? 60) * 60 * 1000
  const dailyFullRefreshTime =
    options.dailyFullRefreshTime ??
    config.runtime.daily_full_refresh_time ??
    DEFAULT_DAILY_FULL_REFRESH_TIME
  const timezoneOffsetMinutes =
    options.timezoneOffsetMinutes ??
    config.runtime.daily_full_refresh_timezone_offset_minutes ??
    DEFAULT_BUSINESS_TIMEZONE_OFFSET_MINUTES
  const sourceWindowDays =
    options.sourceWindowDays ??
    config.runtime.source_window_days ??
    DEFAULT_SOURCE_WINDOW_DAYS
  const cacheTailDays =
    options.cacheTailDays ??
    config.runtime.cache_tail_days ??
    DEFAULT_CACHE_TAIL_DAYS
  const refreshCachesOnStartup =
    options.refreshCachesOnStartup ??
    config.runtime.refresh_caches_on_startup ??
    DEFAULT_REFRESH_CACHES_ON_STARTUP
  let interval: NodeJS.Timeout | null = null
  let dailyTimeout: NodeJS.Timeout | null = null
  let running = false

  async function runOnce(trigger: SyncWorkerTrigger) {
    if (running) {
      logger.warn(`Skipping ${trigger} sync tick because the previous run is still in progress.`)
      return
    }

    running = true
    logger.info(`Sync worker ${trigger} run started.`)
    try {
      // Step 1: source → target. All worker triggers use the same rolling
      // window (default last 2 days). Full source rewrites are intentionally
      // excluded from the scheduled path because the target table record ids
      // are environment-local state.
      const sourceWindow = buildSourceWindow({
        now: new Date(),
        days: sourceWindowDays,
        timezoneOffsetMinutes,
      })
      try {
        const sourceResult = await service.syncSourceToTarget({
          config: options.configPath,
          from: sourceWindow?.from,
          to: sourceWindow?.to,
        })
        logger.info(
          `Source-to-target finished (window=${sourceWindow ? `${sourceWindow.from}..${sourceWindow.to}` : 'full'}): scanned=${sourceResult.scanned}, created=${sourceResult.created}, updated=${sourceResult.updated}, failed=${sourceResult.failed}.`,
        )
      } catch (error) {
        logger.error(
          `Source-to-target sync failed (continuing to target-to-sqlite): ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      // Step 2: target → SQLite mirror. BigQuery / Shopify BI caches refresh
      // only the trailing window (default 7 days) — daily 03:30 just runs the
      // same incremental refresh, not a full 400-day re-pull. Full backfills
      // happen via scripts/full-sync.sh on demand. Startup may skip the cache
      // refresh entirely when refresh_caches_on_startup=false (e.g. right
      // after SCP'ing a fresh SQLite snapshot).
      const refreshBigQueryCache =
        trigger === 'startup' ? refreshCachesOnStartup : trigger !== 'interval'
      const result = await service.syncTargetToSqlite({
        config: options.configPath,
        refreshBigQueryCache,
        cacheTailDays,
      })
      const shopifyBiCache = trigger === 'interval' && service.syncShopifyBiCacheIfDue
        ? await service.syncShopifyBiCacheIfDue({
            config: options.configPath,
            cacheTailDays,
          })
        : undefined
      if (shopifyBiCache?.enabled) {
        logger.info(
          `Shopify BI cache due check finished: skipped=${shopifyBiCache.skipped ?? false}, ok=${shopifyBiCache.ok}, failed=${shopifyBiCache.failed}.`,
        )
      }
      if (!result.sqlite.ok) {
        logger.error('Sync worker run completed with SQLite failure.')
      } else if (result.bigquery_cache?.enabled && !result.bigquery_cache.ok) {
        logger.error('Sync worker run completed with BigQuery cache failure.')
      } else if (result.shopify_bi_cache?.enabled && !result.shopify_bi_cache.ok) {
        logger.error('Sync worker run completed with Shopify BI cache failure.')
      } else if (shopifyBiCache?.enabled && !shopifyBiCache.ok) {
        logger.error('Sync worker run completed with Shopify BI cache due-check failure.')
      } else {
        logger.info(
          `Sync worker run finished: created=${result.created}, updated=${result.updated}, failed=${result.failed}, sqlite_inserted=${result.sqlite.inserted}, sqlite_updated=${result.sqlite.updated}, sqlite_deleted=${result.sqlite.deleted}, bigquery_cache_enabled=${result.bigquery_cache?.enabled ?? false}, bigquery_order_lines=${result.bigquery_cache?.order_lines_upserted ?? 0}, bigquery_refund_events=${result.bigquery_cache?.refund_events_upserted ?? 0}, shopify_bi_cache_enabled=${shopifyBiCache?.enabled ?? result.shopify_bi_cache?.enabled ?? false}, shopify_bi_cache_skipped=${shopifyBiCache?.skipped ?? false}.`,
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

  function scheduleDailyFullRefresh() {
    const delayMs = millisecondsUntilNextDailyRun({
      now: new Date(),
      time: dailyFullRefreshTime,
      timezoneOffsetMinutes,
    })
    logger.info(
      `Sync worker scheduled daily full refresh in ${Math.round(delayMs / 1000)} seconds at ${dailyFullRefreshTime} UTC${timezoneOffsetMinutes >= 0 ? '+' : ''}${timezoneOffsetMinutes / 60}.`,
    )
    dailyTimeout = setTimeout(() => {
      void runOnce('daily-full-refresh').finally(scheduleDailyFullRefresh)
    }, delayMs)
  }

  function start() {
    void runOnce('startup')
    interval = setInterval(() => {
      void runOnce('interval')
    }, intervalMs)
    scheduleDailyFullRefresh()
    return intervalMs
  }

  function stop() {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
    if (dailyTimeout) {
      clearTimeout(dailyTimeout)
      dailyTimeout = null
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
