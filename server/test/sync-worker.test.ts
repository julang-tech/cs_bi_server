import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { createSyncWorker } from '../entrypoints/sync-worker.js'

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
  assert.deepEqual(calls, [
    {
      name: 'syncTargetToSqlite',
      options: { config: 'config/sync/config.example.json', refreshBigQueryCache: true },
    },
    {
      name: 'syncShopifyBiCacheIfDue',
      options: { config: 'config/sync/config.example.json' },
    },
  ])
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
  assert.deepEqual(calls, [
    {
      name: 'syncTargetToSqlite',
      options: { config: 'config/sync/config.example.json', refreshBigQueryCache: false },
    },
    {
      name: 'syncShopifyBiCacheIfDue',
      options: { config: 'config/sync/config.example.json' },
    },
  ])
}

async function testWorkerUsesIntervalAndSkipsOverlap() {
  const calls: number[] = []
  let resolves = 0

  const worker = createSyncWorker({
    configPath: 'config/sync/config.example.json',
    intervalMs: 30,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    service: {
      async syncTargetToSqlite() {
        calls.push(Date.now())
        resolves += 1
        await sleep(resolves === 1 ? 80 : 5)
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

  worker.start()
  await sleep(140)
  worker.stop()
  assert.equal(calls.length, 3)
}

async function run() {
  await testWorkerRunsImmediately()
  await testWorkerIntervalSplitsFeishuMirrorFromShopifyBiDueCheck()
  await testWorkerUsesIntervalAndSkipsOverlap()
  console.log('Sync worker tests passed')
}

await run()
