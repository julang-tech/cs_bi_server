export type P1Filters = {
  date_from: string
  date_to: string
  grain: 'day' | 'week' | 'month'
  agent_name: string
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeDashboardPayload(payload: unknown) {
  if (!isRecord(payload)) {
    return payload
  }

  const summary = isRecord(payload.summary) ? payload.summary : {}

  return {
    ...payload,
    summary: {
      inbound_email_count: 0,
      outbound_email_count: 0,
      first_email_count: 0,
      unreplied_email_count: 0,
      avg_queue_hours: 0,
      first_response_timeout_count: 0,
      ...summary,
    },
  }
}

export type P1DashboardService = {
  getDashboard(filters: P1Filters): Promise<unknown>
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
    if (!this.baseUrl) {
      throw new P1ConfigError('P1_API_BASE_URL is not configured.')
    }
    if (!this.apiKey) {
      throw new P1ConfigError('P1_API_KEY or CLOUD_ACCESS_KEY is not configured.')
    }

    const url = new URL('/api/bi/p1/dashboard', this.baseUrl)
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== '') {
        url.searchParams.set(key, value)
      }
    })

    const response = await this.fetchImpl(url, {
      headers: {
        'x-api-key': this.apiKey,
      },
    })

    if (!response.ok) {
      throw new P1UpstreamError(response.status, response.statusText)
    }

    return normalizeDashboardPayload(await response.json())
  }
}

export function createP1Service(options: {
  baseUrl: string
  apiKey: string
}) {
  return new P1Service(options)
}
