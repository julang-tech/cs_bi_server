import { Command } from 'commander'
import { loadEnv } from '../config/env.js'
import { maskSyncConfig, SyncService } from '../domain/sync/service.js'

const env = loadEnv()
const service = new SyncService()
const program = new Command()

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
  .command('source-to-target')
  .description('Sync Feishu source table to target table with Shopify enrichment')
  .option('--config <path>', 'Path to sync config', env.syncConfigPath)
  .option('--date <date>', 'Only sync one date')
  .option('--from <date>', 'Start date')
  .option('--to <date>', 'End date')
  .action(async (options) => {
    const result = await service.syncSourceToTarget(options)
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
