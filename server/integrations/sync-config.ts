import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const tableConfigSchema = z.object({
  app_token: z.string(),
  table_id: z.string(),
  view_id: z.string().optional().nullable(),
})

const shopifySiteConfigSchema = z.object({
  url: z.string().url(),
  token: z.string(),
  currency: z.string(),
  site_name: z.string(),
})

const bigQueryProxyConfigSchema = z.object({
  enabled: z.boolean().optional(),
  http_proxy: z.string().optional(),
  https_proxy: z.string().optional(),
  no_proxy: z.string().optional(),
})

const syncConfigSchema = z.object({
  feishu: z.object({
    app_id: z.string(),
    app_secret: z.string(),
  }),
  source: tableConfigSchema,
  target: tableConfigSchema,
  runtime: z.object({
    state_path: z.string(),
    log_path: z.string(),
    sqlite_path: z.string(),
    refresh_interval_minutes: z.number().int().positive().optional(),
  }),
  shopify: z.object({
    sites: z.object({
      lc: shopifySiteConfigSchema,
      fr: shopifySiteConfigSchema,
      uk: shopifySiteConfigSchema,
    }),
  }).optional(),
  bigquery: z.object({
    proxy: bigQueryProxyConfigSchema.optional(),
  }).optional(),
})

export type SyncConfig = z.infer<typeof syncConfigSchema>

export function loadSyncConfig(configPath: string): SyncConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  return syncConfigSchema.parse(raw)
}

export function resolveRuntimePath(configPath: string, runtimePath: string): string {
  if (path.isAbsolute(runtimePath)) {
    return runtimePath
  }

  const baseDir = path.dirname(path.dirname(configPath))
  return path.resolve(baseDir, runtimePath)
}

export function loadP3RuntimeConfig(configPath: string) {
  const config = loadSyncConfig(configPath)
  return {
    feishu: config.feishu,
    source: config.source,
    target: config.target,
    runtime: {
      statePath: resolveRuntimePath(configPath, config.runtime.state_path),
      logPath: resolveRuntimePath(configPath, config.runtime.log_path),
      sqlitePath: resolveRuntimePath(configPath, config.runtime.sqlite_path),
      refreshIntervalMinutes: config.runtime.refresh_interval_minutes ?? 120,
    },
    shopify: config.shopify,
    bigquery: config.bigquery,
    configPath,
  }
}
