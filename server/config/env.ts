import path from 'node:path'
import { config as loadDotenv } from 'dotenv'

loadDotenv()

export type AppEnv = {
  host: string
  port: number
  syncConfigPath: string
  p1ApiBaseUrl: string
  p1ApiKey: string
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
    p1ApiBaseUrl:
      process.env.P1_API_BASE_URL ??
      'https://cs-mail.n8n-julang-tech-dev.com',
    p1ApiKey:
      process.env.P1_API_KEY ??
      process.env.CLOUD_ACCESS_KEY ??
      '',
    repoRoot,
  }
}
