export type P1Filters = {
  date_from: string
  date_to: string
  grain: 'day' | 'week' | 'month'
  agent_name: string
  tz_offset_minutes?: number
}

export type P1BacklogMailFilters = {
  date_from?: string
  date_to?: string
  grain?: 'day' | 'week' | 'month'
  agent_name?: string
  tz_offset_minutes: number
  limit?: number
  cursor?: string
  needs_reply?: boolean
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeIsoTimestamp(value: string | null) {
  if (!value) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeDashboardPayload(payload: unknown, fallbackDataAsOf: string | null = null) {
  if (!isRecord(payload)) {
    return payload
  }

  const summary = isRecord(payload.summary) ? payload.summary : {}
  const meta = isRecord(payload.meta) ? payload.meta : {}
  const dataAsOf =
    normalizeIsoTimestamp(String(meta.data_as_of ?? meta.snapshot_at ?? '')) ??
    fallbackDataAsOf

  return {
    ...payload,
    summary: {
      inbound_email_count: 0,
      outbound_email_count: 0,
      first_email_count: 0,
      unreplied_email_count: 0,
      avg_queue_hours: 0,
      first_response_timeout_count: 0,
      late_reply_count: 0,
      unreplied_count: 0,
      avg_unreplied_wait_hours: 0,
      ...summary,
    },
    meta: {
      ...meta,
      ...(dataAsOf ? { data_as_of: dataAsOf } : {}),
    },
  }
}

export type P1DashboardService = {
  getDashboard(filters: P1Filters): Promise<unknown>
  getBacklogMails?: (filters: P1BacklogMailFilters) => Promise<unknown>
  markBacklogMailNeedsReply?: (
    mailId: number,
    needsReply: boolean,
    options?: { reason?: string; operator?: string },
  ) => Promise<unknown>
}

export class P1ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'P1ConfigError'
  }
}

export class P1UpstreamError extends Error {
  constructor(
    readonly statusCode: number,
    readonly statusText: string,
  ) {
    super(`P1 upstream request failed: ${statusCode} ${statusText}`)
    this.name = 'P1UpstreamError'
  }
}

export class P1Service implements P1DashboardService {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike

  constructor(options: {
    baseUrl: string
    apiKey: string
    fetchImpl?: FetchLike
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async getDashboard(filters: P1Filters) {
    const response = await this.requestUpstream('/api/bi/p1/dashboard', filters)
    const fallbackDataAsOf = normalizeIsoTimestamp(response.headers.get('date'))
    return normalizeDashboardPayload(await response.json(), fallbackDataAsOf)
  }

  async getBacklogMails(filters: P1BacklogMailFilters) {
    const response = await this.requestUpstream('/api/bi/p1/backlog-mails', filters)
    return response.json()
  }

  async markBacklogMailNeedsReply(
    mailId: number,
    needsReply: boolean,
    options: { reason?: string; operator?: string } = {},
  ) {
    const response = await this.requestUpstream(
      `/api/bi/p1/backlog-mails/${encodeURIComponent(String(mailId))}/needs-reply`,
      {},
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          needs_reply: needsReply,
          reason: options.reason,
          operator: options.operator ?? 'dashboard',
        }),
      },
    )
    return response.json()
  }

  private async requestUpstream(
    pathname: string,
    params: Record<string, unknown>,
    init: RequestInit = {},
  ) {
    if (!this.baseUrl) {
      throw new P1ConfigError('P1_API_BASE_URL is not configured.')
    }
    if (!this.apiKey) {
      throw new P1ConfigError('P1_API_KEY or CLOUD_ACCESS_KEY is not configured.')
    }

    const url = new URL(pathname, this.baseUrl)
    Object.entries(params).forEach(([key, value]) => {
      if (value !== '' && value !== undefined && value !== null) {
        url.searchParams.set(key, String(value))
      }
    })

    const headers = new Headers(init.headers)
    headers.set('x-api-key', this.apiKey)

    const response = await this.fetchImpl(url, {
      ...init,
      headers,
    })

    if (!response.ok) {
      throw new P1UpstreamError(response.status, response.statusText)
    }

    return response
  }
}

export function createP1Service(options: {
  baseUrl: string
  apiKey: string
}) {
  return new P1Service(options)
}
