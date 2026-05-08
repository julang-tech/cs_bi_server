import path from 'node:path'
import { config as loadDotenv } from 'dotenv'

loadDotenv()

export type FeishuAuthEnv = {
  enabled: boolean
  configured: boolean
  authRequired: boolean
  appId: string
  appSecret: string
  redirectUri: string
  sessionSecret: string
  allowedDomains: string[]
  scope: string
  cookieSecure: boolean
  devUser: { name: string; email?: string } | null
}

export type AppEnv = {
  host: string
  port: number
  syncConfigPath: string
  p1ApiBaseUrl: string
  p1ApiKey: string
  repoRoot: string
  feishuAuth: FeishuAuthEnv
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function loadFeishuAuthEnv(): FeishuAuthEnv {
  const appId = process.env.FEISHU_APP_ID ?? ''
  const appSecret = process.env.FEISHU_APP_SECRET ?? ''
  const sessionSecret = process.env.SESSION_SECRET ?? process.env.FEISHU_SESSION_SECRET ?? ''
  const enabled = process.env.FEISHU_AUTH_ENABLED === 'true' || Boolean(appId || appSecret)
  const configured = Boolean(appId && appSecret && sessionSecret)
  return {
    enabled,
    configured,
    authRequired: enabled && configured && process.env.FEISHU_AUTH_ENABLED !== 'false',
    appId,
    appSecret,
    redirectUri: process.env.FEISHU_REDIRECT_URI ?? '',
    sessionSecret,
    allowedDomains: parseList(process.env.FEISHU_ALLOWED_DOMAINS),
    scope: process.env.FEISHU_AUTH_SCOPE ?? '',
    cookieSecure: process.env.AUTH_COOKIE_SECURE === 'true',
    devUser: process.env.FEISHU_DEV_USER_NAME
      ? { name: process.env.FEISHU_DEV_USER_NAME, email: process.env.FEISHU_DEV_USER_EMAIL }
      : null,
  }
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
    feishuAuth: loadFeishuAuthEnv(),
  }
}
