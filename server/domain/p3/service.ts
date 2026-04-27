import fs from 'node:fs'
import { BigQuery } from '@google-cloud/bigquery'
import { TtlCache } from './cache.js'
import {
  buildDashboardPayload,
  buildDrilldownOptionsPayload,
  buildDrilldownPreviewPayload,
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
  SalesRepository,
} from './models.js'
import {
  BigQueryOrderEnrichmentRepository,
  BigQuerySalesRepository,
  SampleOrderEnrichmentRepository,
  SampleSalesRepository,
} from '../../integrations/bigquery.js'
import { FeishuIssueProvider, FixtureIssueProvider } from '../../integrations/feishu.js'
import { loadP3RuntimeConfig } from '../../integrations/sync-config.js'

export class P3Service {
  private readonly dashboardCache = new TtlCache<DashboardResponse>(300_000)
  private readonly drilldownOptionsCache = new TtlCache<DrilldownOptionsResponse>(300_000)
  private readonly drilldownPreviewCache = new TtlCache<DrilldownPreviewResponse>(300_000)

  constructor(
    private readonly salesRepository: SalesRepository,
    private readonly issueProvider: IssueProvider,
    private readonly enrichmentRepository: OrderEnrichmentRepository,
    private readonly setupNotes: string[] = [],
  ) {}

  async getDashboard(filters: P3Filters): Promise<DashboardResponse> {
    const cacheKey = JSON.stringify(['dashboard', filters])
    const cached = this.dashboardCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const result = await this.computeDashboard(filters)
    return this.dashboardCache.set(cacheKey, buildDashboardPayload(filters, result))
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
      buildDrilldownOptionsPayload(filters, result),
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

export function createP3Service(repoRoot: string, syncConfigPath: string) {
  let salesRepository: SalesRepository = new SampleSalesRepository(repoRoot)
  let issueProvider: IssueProvider = new FixtureIssueProvider(repoRoot)
  let enrichmentRepository: OrderEnrichmentRepository = new SampleOrderEnrichmentRepository()
  const setupNotes: string[] = []

  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  const hasBigQuery = Boolean(credentialsPath && fs.existsSync(credentialsPath))
  let bigQueryClient: BigQuery | null = null

  if (hasBigQuery) {
    bigQueryClient = new BigQuery()
    salesRepository = new BigQuerySalesRepository(bigQueryClient)
    enrichmentRepository = new BigQueryOrderEnrichmentRepository(bigQueryClient)
  } else {
    setupNotes.push(
      'BigQuery credentials not found; using local sample sales and enrichment data.',
    )
  }

  if (fs.existsSync(syncConfigPath)) {
    try {
      const config = loadP3RuntimeConfig(syncConfigPath)
      issueProvider = new FeishuIssueProvider(repoRoot, {
        feishu: config.feishu,
        source: config.source,
        target: config.target,
        runtime: {
          state_path: config.runtime.statePath,
          log_path: config.runtime.logPath,
        },
      })
    } catch {
      issueProvider = new FixtureIssueProvider(repoRoot)
      setupNotes.push('Failed to load Feishu runtime config; using local fixture issue bundle.')
    }
  } else {
    setupNotes.push('Sync config not found; using local fixture issue bundle.')
  }

  return new P3Service(salesRepository, issueProvider, enrichmentRepository, setupNotes)
}
