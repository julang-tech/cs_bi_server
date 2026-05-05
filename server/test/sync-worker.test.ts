import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { buildSourceWindow, createSyncWorker, millisecondsUntilNextDailyRun } from '../entrypoints/sync-worker.js'
import { loadP3RuntimeConfig } from '../integrations/sync-config.js'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const sourceToTargetStub = async () => ({
  scanned: 0, created: 0, updated: 0, failed: 0,
})

function createConfigWithoutInterval() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bi-sync-worker-'))
  const configPath = path.join(tempDir, 'config', 'sync', 'config.json')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      feishu: { app_id: 'cli_xxx', app_secret: 'secret' },
      source: { app_token: 'source-app', table_id: 'source-table', view_id: 'source-view' },
      target: { app_token: 'target-app', table_id: 'target-table', view_id: 'target-view' },
      runtime: {
        state_path: './data/state.json',
        log_path: './data/sync.log',
        sqlite_path: './data/issues.sqlite',
      },
    }),
  )
  return { tempDir, configPath }
}

async function testWorkerRunsImmediately() {
  const calls: Array<{ name: string; options: unknown }> = []
  const worker = createSyncWorker({
    configPath: 'config/sync/config.example.json',
    intervalMs: 10_000,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    service: {
      async syncSourceToTarget(options) {
        calls.push({ name: 'syncSourceToTarget', options })
        return { scanned: 0, created: 0, updated: 0, failed: 0 }
      },
      async syncTargetToSqlite(options) {
        calls.push({ name: 'syncTargetToSqlite', options })
        return {
          created: 0,
          updated: 0,
          failed: 0,
          sqlite: {
            ok: true,
            inserted: 0,
            updated: 0,
            deleted: 0,
            sqlite_failed: 0,
          },
        }
      },
      async syncShopifyBiCacheIfDue(options) {
        calls.push({ name: 'syncShopifyBiCacheIfDue', options })
        return { enabled: true, ok: true, skipped: true, failed: 0 }
      },
    },
  })

  worker.start()
  await sleep(30)
  worker.stop()
  assert.equal(calls.length, 2)
  assert.equal(calls[0].name, 'syncSourceToTarget')
  const s2tOptions = calls[0].options as { config: string; from?: string; to?: string }
  assert.equal(s2tOptions.config, 'config/sync/config.example.json')
  assert.match(s2tOptions.from ?? '', ISO_DATE_RE)
  assert.match(s2tOptions.to ?? '', ISO_DATE_RE)
  assert.deepEqual(calls[1], {
    name: 'syncTargetToSqlite',
    options: { config: 'config/sync/config.example.json', refreshBigQueryCache: true, cacheTailDays: 7 },
  })
}

async function testWorkerDefaultIntervalIsOneHour() {
  const { tempDir, configPath } = createConfigWithoutInterval()
  try {
    const worker = createSyncWorker({
      configPath,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      service: {
        syncSourceToTarget: sourceToTargetStub,
        async syncTargetToSqlite() {
          return {
            created: 0,
            updated: 0,
            failed: 0,
            sqlite: {
              ok: true,
              inserted: 0,
              updated: 0,
              deleted: 0,
              sqlite_failed: 0,
            },
          }
        },
      },
    })

    const intervalMs = worker.start()
    worker.stop()
    assert.equal(intervalMs, 60 * 60 * 1000)
    assert.equal(loadP3RuntimeConfig(configPath).runtime.refreshIntervalMinutes, 60)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

async function testWorkerIntervalSplitsFeishuMirrorFromShopifyBiDueCheck() {
  const calls: Array<{ name: string; options: unknown }> = []
  const worker = createSyncWorker({
    configPath: 'config/sync/config.example.json',
    intervalMs: 10_000,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    service: {
      async syncSourceToTarget(options) {
        calls.push({ name: 'syncSourceToTarget', options })
        return { scanned: 0, created: 0, updated: 0, failed: 0 }
      },
      async syncTargetToSqlite(options) {
        calls.push({ name: 'syncTargetToSqlite', options })
        return {
          created: 0,
          updated: 0,
          failed: 0,
          sqlite: {
            ok: true,
            inserted: 0,
            updated: 0,
            deleted: 0,
            sqlite_failed: 0,
          },
          bigquery_cache: {
            enabled: true,
            ok: true,
            order_lines_upserted: 0,
            refund_events_upserted: 0,
            failed: 0,
          },
          shopify_bi_cache: {
            enabled: true,
            ok: true,
            orders_upserted: 0,
            order_lines_upserted: 0,
            refund_events_upserted: 0,
            failed: 0,
          },
        }
      },
      async syncShopifyBiCacheIfDue(options) {
        calls.push({ name: 'syncShopifyBiCacheIfDue', options })
        return { enabled: true, ok: true, skipped: true, failed: 0 }
      },
    },
  })

  await worker.runOnce('interval')
  assert.equal(calls.length, 3)
  assert.equal(calls[0].name, 'syncSourceToTarget')
  const intervalOptions = calls[0].options as { config: string; from?: string; to?: string }
  assert.match(intervalOptions.from ?? '', ISO_DATE_RE)
  assert.match(intervalOptions.to ?? '', ISO_DATE_RE)
  assert.deepEqual(calls[1], {
    name: 'syncTargetToSqlite',
    options: { config: 'config/sync/config.example.json', refreshBigQueryCache: false, cacheTailDays: 7 },
  })
  assert.deepEqual(calls[2], {
    name: 'syncShopifyBiCacheIfDue',
    options: { config: 'config/sync/config.example.json', cacheTailDays: 7 },
  })
}

async function testWorkerDailyFullRefreshForcesBigQueryCache() {
  const calls: Array<{ name: string; options: unknown }> = []
  const worker = createSyncWorker({
    configPath: 'config/sync/config.example.json',
    intervalMs: 10_000,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    service: {
      async syncSourceToTarget(options) {
        calls.push({ name: 'syncSourceToTarget', options })
        return { scanned: 0, created: 0, updated: 0, failed: 0 }
      },
      async syncTargetToSqlite(options) {
        calls.push({ name: 'syncTargetToSqlite', options })
        return {
          created: 0,
          updated: 0,
          failed: 0,
          sqlite: {
            ok: true,
            inserted: 0,
            updated: 0,
            deleted: 0,
            sqlite_failed: 0,
          },
        }
      },
      async syncShopifyBiCacheIfDue(options) {
        calls.push({ name: 'syncShopifyBiCacheIfDue', options })
        return { enabled: true, ok: true, skipped: true, failed: 0 }
      },
    },
  })

  await worker.runOnce('daily-full-refresh')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].name, 'syncSourceToTarget')
  const sourceOptions = calls[0].options as { config: string; from?: string; to?: string }
  assert.equal(sourceOptions.config, 'config/sync/config.example.json')
  assert.match(sourceOptions.from ?? '', ISO_DATE_RE)
  assert.match(sourceOptions.to ?? '', ISO_DATE_RE)
  assert.deepEqual(calls[1], {
    name: 'syncTargetToSqlite',
    options: { config: 'config/sync/config.example.json', refreshBigQueryCache: true, cacheTailDays: 7 },
  })
}

function testBuildSourceWindow() {
  // 2026-05-02 03:00 UTC = 2026-05-02 11:00 Beijing
  const now = new Date('2026-05-02T03:00:00.000Z')
  assert.deepEqual(
    buildSourceWindow({ now, days: 2, timezoneOffsetMinutes: 480 }),
    { from: '2026-05-01', to: '2026-05-02' },
  )
  assert.deepEqual(
    buildSourceWindow({ now, days: 1, timezoneOffsetMinutes: 480 }),
    { from: '2026-05-02', to: '2026-05-02' },
  )
  assert.equal(buildSourceWindow({ now, days: 0, timezoneOffsetMinutes: 480 }), null)

  // Across day boundary in Beijing time: 2026-05-01 17:00 UTC = 2026-05-02 01:00 Beijing
  assert.deepEqual(
    buildSourceWindow({
      now: new Date('2026-05-01T17:00:00.000Z'),
      days: 2,
      timezoneOffsetMinutes: 480,
    }),
    { from: '2026-05-01', to: '2026-05-02' },
  )
}

function testDailyRefreshDelayUsesBeijingBusinessTime() {
  assert.equal(
    millisecondsUntilNextDailyRun({
      now: new Date('2026-05-01T18:00:00.000Z'),
      time: '03:30',
      timezoneOffsetMinutes: 480,
    }),
    90 * 60 * 1000,
  )
  assert.equal(
    millisecondsUntilNextDailyRun({
      now: new Date('2026-05-01T19:30:00.000Z'),
      time: '03:30',
      timezoneOffsetMinutes: 480,
    }),
    24 * 60 * 60 * 1000,
  )
}

async function testWorkerUsesIntervalAndSkipsOverlap() {
  let calls = 0
  let markStarted!: () => void
  let releaseSync!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const release = new Promise<void>((resolve) => {
    releaseSync = resolve
  })
  const warnings: string[] = []

  const worker = createSyncWorker({
    configPath: 'config/sync/config.example.json',
    intervalMs: 10_000,
    logger: {
      info() {},
      warn(message) {
        warnings.push(message)
      },
      error() {},
    },
    service: {
      syncSourceToTarget: sourceToTargetStub,
      async syncTargetToSqlite() {
        calls += 1
        markStarted()
        await release
        return {
          created: 0,
          updated: 0,
          failed: 0,
          sqlite: {
            ok: true,
            inserted: 0,
            updated: 0,
            deleted: 0,
            sqlite_failed: 0,
          },
        }
      },
    },
  })

  const first = worker.runOnce('interval')
  await started
  await worker.runOnce('interval')
  assert.equal(calls, 1)
  assert.equal(
    warnings.some((message) =>
      message.includes('Skipping interval sync tick because the previous run is still in progress.'),
    ),
    true,
  )
  releaseSync()
  await first
  assert.equal(calls, 1)
}

async function run() {
  await testWorkerRunsImmediately()
  await testWorkerDefaultIntervalIsOneHour()
  await testWorkerIntervalSplitsFeishuMirrorFromShopifyBiDueCheck()
  await testWorkerDailyFullRefreshForcesBigQueryCache()
  testBuildSourceWindow()
  testDailyRefreshDelayUsesBeijingBusinessTime()
  await testWorkerUsesIntervalAndSkipsOverlap()
  console.log('Sync worker tests passed')
}

await run()
