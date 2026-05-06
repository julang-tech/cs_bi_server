import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { TtlCache } from './cache.js'
import {
  buildProductRankingPayload,
  buildDashboardPayload,
  buildDrilldownOptionsPayload,
  buildDrilldownPreviewPayload,
  computeProductRanking,
  computeDashboard,
  filterIssues,
} from './compute.js'
import type {
  DashboardResponse,
  DrilldownFilters,
  DrilldownOptionsResponse,
  DrilldownPreviewResponse,
  IssueProvider,
  OrderEnrichmentRepository,
  P3Filters,
  ProductRankingResponse,
  SalesRepository,
} from './models.js'
import {
  SampleOrderEnrichmentRepository,
  SampleSalesRepository,
} from '../../integrations/bigquery.js'
import { FeishuIssueProvider, FixtureIssueProvider } from '../../integrations/feishu.js'
import { SqliteShopifyBiCacheRepository } from '../../integrations/shopify-bi-cache.js'
import { SqliteIssueProvider } from '../../integrations/sqlite.js'
import { loadP3RuntimeConfig } from '../../integrations/sync-config.js'

function applyBigQueryProxyConfig(config?: {
  proxy?: {
    enabled?: boolean
    http_proxy?: string
    https_proxy?: string
    no_proxy?: string
  }
}) {
  if (!config?.proxy?.enabled) {
    return
  }

  if (config.proxy.http_proxy) {
    process.env.HTTP_PROXY = config.proxy.http_proxy
  }
  if (config.proxy.https_proxy) {
    process.env.HTTPS_PROXY = config.proxy.https_proxy
  }
  if (config.proxy.no_proxy) {
    process.env.NO_PROXY = config.proxy.no_proxy
  }
}

function hasActiveSqliteMirrorRows(sqlitePath: string) {
  if (!fs.existsSync(sqlitePath)) {
    return false
  }

  const db = new DatabaseSync(sqlitePath)
  try {
    const table = db
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'feishu_target_records'
      `)
      .get() as { name: string } | undefined
    if (!table) {
      return false
    }

    const row = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM feishu_target_records
        WHERE deleted_at IS NULL
      `)
      .get() as { count: number } | undefined
    return Number(row?.count ?? 0) > 0
  } catch {
    return false
  } finally {
    db.close()
  }
}

type P3Logger = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

export class P3Service {
  private readonly dashboardCache = new TtlCache<DashboardResponse>(300_000)
  private readonly drilldownOptionsCache = new TtlCache<DrilldownOptionsResponse>(300_000)
  private readonly drilldownPreviewCache = new TtlCache<DrilldownPreviewResponse>(300_000)
  private readonly productRankingCache = new TtlCache<ProductRankingResponse>(300_000)

  constructor(
    private readonly salesRepository: SalesRepository,
    private readonly issueProvider: IssueProvider,
    private readonly enrichmentRepository: OrderEnrichmentRepository,
    private readonly setupNotes: string[] = [],
    private readonly sourceModes: string[] = ['feishu/openclaw runtime fetch', 'shopify bigquery enrichment'],
  ) {}

  async getDashboard(filters: P3Filters): Promise<DashboardResponse> {
    const cacheKey = JSON.stringify(['dashboard', filters])
    const cached = this.dashboardCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const [result, dataAsOf] = await Promise.all([
      this.computeDashboard(filters),
      this.resolveSalesDataAsOf(filters),
    ])
    return this.dashboardCache.set(
      cacheKey,
      buildDashboardPayload(filters, result, this.sourceModes, dataAsOf),
    )
  }

  async getDrilldownOptions(filters: P3Filters): Promise<DrilldownOptionsResponse> {
    const cacheKey = JSON.stringify(['drilldown-options', filters])
    const cached = this.drilldownOptionsCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const result = await this.computeDashboard(filters)
    return this.drilldownOptionsCache.set(
      cacheKey,
      buildDrilldownOptionsPayload(filters, result, this.sourceModes),
    )
  }

  async getDrilldownPreview(filters: DrilldownFilters): Promise<DrilldownPreviewResponse> {
    const cacheKey = JSON.stringify(['drilldown-preview', filters])
    const cached = this.drilldownPreviewCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const filtered = await this.getFilteredIssues(filters)
    const payload = buildDrilldownPreviewPayload(
      filters,
      filtered.issues,
      filtered.notes,
      filtered.partial_data,
    )
    return this.drilldownPreviewCache.set(cacheKey, payload)
  }

  async getProductRanking(filters: P3Filters): Promise<ProductRankingResponse> {
    const cacheKey = JSON.stringify(['product-ranking', filters])
    const cached = this.productRankingCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const [salesRows, refundRows, filtered] = await Promise.all([
      this.salesRepository.fetchProductSales(filters),
      this.salesRepository.fetchProductRefunds(filters),
      this.getFilteredIssues(filters),
    ])

    const ranking = computeProductRanking(salesRows, refundRows, filtered.issues)
    const payload = buildProductRankingPayload(
      filters,
      ranking,
      filtered.notes,
      filtered.partial_data,
    )
    return this.productRankingCache.set(cacheKey, payload)
  }

  private async computeDashboard(filters: P3Filters) {
    const [salesSummary, salesTrends, filtered] = await Promise.all([
      this.salesRepository.fetchSummary(filters),
      this.salesRepository.fetchTrends(filters),
      this.getFilteredIssues(filters),
    ])

    return computeDashboard(
      filters,
      salesSummary,
      salesTrends,
      filtered.issues,
      filtered.notes,
      filtered.partial_data,
    )
  }

  private async resolveSalesDataAsOf(filters: P3Filters) {
    return (await this.salesRepository.getDataAsOf?.(filters.date_from, filters.date_to)) ?? null
  }

  private async getFilteredIssues(filters: P3Filters) {
    const sourceBundle = await this.issueProvider.getSourceBundle()
    const enriched = await this.enrichmentRepository.enrichIssues(sourceBundle.issues)
    const notes = [...this.setupNotes, ...sourceBundle.notes, ...enriched.notes]
    const partial_data =
      this.setupNotes.length > 0 || sourceBundle.partial_data || enriched.notes.length > 0
    const issues = filterIssues(enriched.issues, filters)
    return { issues, notes, partial_data }
  }
}

export function createP3Service(repoRoot: string, syncConfigPath: string, logger?: P3Logger) {
  let salesRepository: SalesRepository = new SampleSalesRepository(repoRoot)
  let issueProvider: IssueProvider = new FixtureIssueProvider(repoRoot)
  let enrichmentRepository: OrderEnrichmentRepository = new SampleOrderEnrichmentRepository()
  const setupNotes: string[] = []
  const sourceModes: string[] = []
  let runtimeConfig: ReturnType<typeof loadP3RuntimeConfig> | null = null

  if (fs.existsSync(syncConfigPath)) {
    try {
      runtimeConfig = loadP3RuntimeConfig(syncConfigPath)
      applyBigQueryProxyConfig(runtimeConfig.bigquery)
    } catch {
      runtimeConfig = null
    }
  }

  if (runtimeConfig) {
    const hasSqliteMirrorRows = hasActiveSqliteMirrorRows(runtimeConfig.runtime.sqlitePath)
    const sqliteCache = new SqliteShopifyBiCacheRepository(runtimeConfig.runtime.sqlitePath, logger)
    salesRepository = sqliteCache
    enrichmentRepository = sqliteCache
    sourceModes.push('sqlite shopify bi cache')

    try {
      if (hasSqliteMirrorRows) {
        issueProvider = new SqliteIssueProvider(repoRoot, runtimeConfig.runtime.sqlitePath, logger)
        sourceModes.unshift('sqlite mirrored target records')
      } else {
        issueProvider = new FeishuIssueProvider(repoRoot, {
          feishu: runtimeConfig.feishu,
          source: runtimeConfig.source,
          target: runtimeConfig.target,
          runtime: {
            state_path: runtimeConfig.runtime.statePath,
            log_path: runtimeConfig.runtime.logPath,
            sqlite_path: runtimeConfig.runtime.sqlitePath,
            refresh_interval_minutes: runtimeConfig.runtime.refreshIntervalMinutes,
          },
        })
        setupNotes.push(
          `SQLite mirror has no active target records at ${runtimeConfig.runtime.sqlitePath}; falling back to Feishu runtime fetch.`,
        )
        sourceModes.unshift('feishu/openclaw runtime fetch')
      }
    } catch {
      issueProvider = new FixtureIssueProvider(repoRoot)
      setupNotes.push('Failed to load Feishu runtime config; using local fixture issue bundle.')
      sourceModes.unshift('fixture issue bundle')
    }
  } else {
    setupNotes.push('Sync config not found; using local fixture issue bundle.')
    sourceModes.unshift('fixture issue bundle')
    setupNotes.push(
      'Sync config not found; using local sample sales and enrichment data.',
    )
    sourceModes.push('sample sales/enrichment data')
  }

  if (!sourceModes.length) {
    sourceModes.push('unknown source mode')
  }

  return new P3Service(
    salesRepository,
    issueProvider,
    enrichmentRepository,
    setupNotes,
    sourceModes,
  )
}
