import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { createSyncWorker } from '../entrypoints/sync-worker.js'

async function testWorkerRunsImmediately() {
  const calls: string[] = []
  const worker = createSyncWorker({
    configPath: 'config/sync/config.example.json',
    intervalMs: 10_000,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    service: {
      async sync() {
        calls.push('sync')
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
  await sleep(30)
  worker.stop()
  assert.equal(calls.length, 1)
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
      async sync() {
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
  await testWorkerUsesIntervalAndSkipsOverlap()
  console.log('Sync worker tests passed')
}

await run()
