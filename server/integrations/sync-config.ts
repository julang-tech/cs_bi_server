import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const tableConfigSchema = z.object({
  app_token: z.string(),
  table_id: z.string(),
  view_id: z.string().optional().nullable(),
})

export const TRANSFORMER_KINDS = [
  'refund_log',
  'reissue_6usd',
  'manual_return',
  'defect_feedback',
  'wrong_send_feedback',
  'logistics_issue',
] as const

export type TransformerKind = (typeof TRANSFORMER_KINDS)[number]

const transformerKindSchema = z.enum(TRANSFORMER_KINDS)

const sourceConfigSchema = tableConfigSchema.extend({
  name: z.string().optional(),
  transformer_kind: transformerKindSchema,
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

const logisticsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  timeout_seconds: z.number().int().positive().optional(),
  fpx: z.object({
    api_base_url: z.string().optional(),
    app_key: z.string().optional(),
    app_secret: z.string().optional(),
  }).optional(),
  yunexpress: z.object({
    api_base_url: z.string().optional(),
    app_id: z.string().optional(),
    app_secret: z.string().optional(),
    source_key: z.string().optional(),
  }).optional(),
  track17: z.object({
    api_key: z.string().optional(),
  }).optional(),
})

const rawSyncConfigSchema = z
  .object({
    feishu: z.object({
      app_id: z.string(),
      app_secret: z.string(),
    }),
    source: tableConfigSchema.optional(),
    sources: z.array(sourceConfigSchema).optional(),
    target: tableConfigSchema,
    runtime: z.object({
      state_path: z.string(),
      log_path: z.string(),
      sqlite_path: z.string(),
      refresh_interval_minutes: z.number().int().positive().optional(),
      daily_full_refresh_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      daily_full_refresh_timezone_offset_minutes: z.number().int().optional(),
      source_window_days: z.number().int().min(0).optional(),
      cache_tail_days: z.number().int().positive().optional(),
      refresh_caches_on_startup: z.boolean().optional(),
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
    logistics: logisticsConfigSchema.optional(),
  })
  .refine((value) => Boolean(value.source) || (value.sources && value.sources.length > 0), {
    message: 'Either `source` (single) or `sources` (array) must be provided.',
    path: ['sources'],
  })

export type TableConfig = z.infer<typeof tableConfigSchema>
export type SourceConfig = z.infer<typeof sourceConfigSchema>

type RawSyncConfig = z.infer<typeof rawSyncConfigSchema>

export type SyncConfig = Omit<RawSyncConfig, 'source' | 'sources'> & {
  /**
   * Back-compat single-source pointer. Equal to `sources[0]` reduced to a plain
   * `TableConfig` shape so legacy consumers that only need the table coordinates
   * (e.g. P3 runtime fetch, FeishuTableClient.listRecords) keep working.
   */
  source: TableConfig
  /**
   * Marked optional in the type (always populated by `loadSyncConfig`) so
   * older test fixtures and callers that build a `SyncConfig` literal by hand
   * keep type-checking without forcing them to declare every transformer kind.
   */
  sources?: SourceConfig[]
}

function normalizeSources(raw: RawSyncConfig): SourceConfig[] {
  if (raw.sources && raw.sources.length > 0) {
    return raw.sources
  }
  if (raw.source) {
    return [
      {
        ...raw.source,
        name: '退款登记',
        transformer_kind: 'refund_log',
      },
    ]
  }
  throw new Error('Sync config must define `source` or `sources`.')
}

export function loadSyncConfig(configPath: string): SyncConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const parsed = rawSyncConfigSchema.parse(raw)
  const sources = normalizeSources(parsed)
  const primary: TableConfig = {
    app_token: sources[0].app_token,
    table_id: sources[0].table_id,
    view_id: sources[0].view_id,
  }
  return {
    ...parsed,
    sources,
    source: primary,
  }
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
    sources: config.sources,
    target: config.target,
    runtime: {
      statePath: resolveRuntimePath(configPath, config.runtime.state_path),
      logPath: resolveRuntimePath(configPath, config.runtime.log_path),
      sqlitePath: resolveRuntimePath(configPath, config.runtime.sqlite_path),
      refreshIntervalMinutes: config.runtime.refresh_interval_minutes ?? 120,
      dailyFullRefreshTime: config.runtime.daily_full_refresh_time ?? '03:30',
      dailyFullRefreshTimezoneOffsetMinutes:
        config.runtime.daily_full_refresh_timezone_offset_minutes ?? 480,
      sourceWindowDays: config.runtime.source_window_days ?? 2,
      cacheTailDays: config.runtime.cache_tail_days ?? 7,
      refreshCachesOnStartup: config.runtime.refresh_caches_on_startup ?? true,
    },
    shopify: config.shopify,
    bigquery: config.bigquery,
    logistics: config.logistics,
    configPath,
  }
}
