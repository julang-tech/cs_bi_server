import { Command } from 'commander'
import { loadEnv } from '../config/env.js'
import { maskSyncConfig, SyncService } from '../domain/sync/service.js'

const env = loadEnv()
const service = new SyncService()
const program = new Command()

function summarizeStateForOutput(result: Record<string, unknown>) {
  const state = result.state as { source_to_target_ids?: Record<string, string[]> } | undefined
  if (!state?.source_to_target_ids) {
    return result
  }
  return {
    ...result,
    state: {
      source_to_target_keys: Object.keys(state.source_to_target_ids).length,
      target_record_ids: Object.values(state.source_to_target_ids).reduce(
        (sum, ids) => sum + ids.length,
        0,
      ),
    },
  }
}

program.name('sync').description('Unified Feishu/OpenClaw sync entrypoint')

program
  .command('preview')
  .option('--config <path>', 'Path to sync config', env.syncConfigPath)
  .option('--date <date>', 'Only sync one date')
  .option('--from <date>', 'Start date')
  .option('--to <date>', 'End date')
  .action(async (options) => {
    const result = await service.preview(options)
    console.log(
      JSON.stringify(
        summarizeStateForOutput({
          ...result,
          config: maskSyncConfig(result.config),
        }),
        null,
        2,
      ),
    )
  })

program
  .command('sync')
  .description('Sync Feishu target table to SQLite and refresh BigQuery cache')
  .option('--config <path>', 'Path to sync config', env.syncConfigPath)
  .option('--date <date>', 'Only sync one date')
  .option('--from <date>', 'Start date')
  .option('--to <date>', 'End date')
  .option('--full', 'Full 400-day BigQuery cache refresh (default: 7-day tail)')
  .option('--cache-tail-days <days>', 'Trailing window for BigQuery cache refresh', '7')
  .action(async (options) => {
    const cacheTailDays = options.full
      ? undefined
      : Number.parseInt(options.cacheTailDays, 10)
    const result = await service.sync({ ...options, cacheTailDays })
    if (!result.sqlite.ok || !result.bigquery_cache.ok) {
      process.exitCode = 1
    }
    console.log(
      JSON.stringify(
        summarizeStateForOutput({
          ...result,
          config: maskSyncConfig(result.config),
        }),
        null,
        2,
      ),
    )
  })

program
  .command('source-to-target')
  .description('Sync Feishu source table to target table with Shopify enrichment')
  .option('--config <path>', 'Path to sync config', env.syncConfigPath)
  .option('--date <date>', 'Only sync one date')
  .option('--from <date>', 'Start date')
  .option('--to <date>', 'End date')
  .option('--rebuild-target', 'Delete target records and rebuild them from source artifacts')
  .option('--rebuild-run-id <id>', 'Resume or name a source-to-target rebuild artifact run')
  .option('--create-concurrency <count>', 'Concurrent target batch_create calls for rebuild mode', '4')
  .option('--delete-concurrency <count>', 'Concurrent target batch_delete calls for rebuild mode', '4')
  .action(async (options) => {
    const result = await service.syncSourceToTarget({
      ...options,
      createConcurrency: Number.parseInt(options.createConcurrency, 10),
      deleteConcurrency: Number.parseInt(options.deleteConcurrency, 10),
    })
    if (!result.sqlite.ok || !result.bigquery_cache.ok) {
      process.exitCode = 1
    }
    console.log(
      JSON.stringify(
        {
          ...result,
          config: maskSyncConfig(result.config),
        },
        null,
        2,
      ),
    )
  })

program
  .command('sync-csv')
  .requiredOption('--source <path>', 'Source CSV path')
  .option('--target <path>', 'Target CSV path')
  .option('--date <date>', 'Only sync one date')
  .option('--from <date>', 'Start date')
  .option('--to <date>', 'End date')
  .action(async (options) => {
    const result = await service.syncCsv(options)
    console.log(JSON.stringify(result, null, 2))
  })

program.parseAsync(process.argv)
