import path from 'node:path'
import { config as loadDotenv } from 'dotenv'

loadDotenv()

export type AppEnv = {
  host: string
  port: number
  syncConfigPath: string
  repoRoot: string
}

export function loadEnv(): AppEnv {
  const repoRoot = process.cwd()

  return {
    host: process.env.APP_HOST ?? '127.0.0.1',
    port: Number(process.env.APP_PORT ?? '8787'),
    syncConfigPath:
      process.env.SYNC_CONFIG_PATH ??
      path.join(
        repoRoot,
        'config',
        'sync',
        'config.example.json',
      ),
    repoRoot,
  }
}
