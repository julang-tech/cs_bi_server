import assert from 'node:assert/strict'
import { buildApp } from '../entrypoints/app.js'
import { P1Service, P1UpstreamError, type P1Filters } from '../domain/p1/service.js'

function createP1Payload(filters: P1Filters) {
  return {
    filters,
    summary: {
      inbound_email_count: 10,
      outbound_email_count: 8,
      first_email_count: 6,
      unreplied_email_count: 1,
      avg_queue_hours: 2.5,
      first_response_timeout_count: 1,
    },
    trends: {
      inbound_email_count: [{ bucket: filters.date_from, value: 10 }],
      outbound_email_count: [{ bucket: filters.date_from, value: 8 }],
      first_response_timeout_count: [{ bucket: filters.date_from, value: 1 }],
    },
    agent_workload: [],
    meta: {
      version: 'p1-chat-dashboard-v1',
      source: 'mail',
      partial_data: false,
      notes: [],
    },
  }
}

async function testP1RouteReturnsServicePayload() {
  let receivedFilters: P1Filters | null = null
  const { app } = await buildApp({
    p1Service: {
      async getDashboard(filters: P1Filters) {
        receivedFilters = filters
        return createP1Payload(filters)
      },
    },
  })

  const response = await app.inject({
    method: 'GET',
    url: '/api/bi/p1/dashboard?date_from=2026-04-01&date_to=2026-04-30&agent_name=Mira',
  })
  const payload = response.json()

  assert.equal(response.statusCode, 200)
  assert.deepEqual(receivedFilters, {
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'day',
    agent_name: 'Mira',
  })
  assert.equal(payload.summary.inbound_email_count, 10)
  assert.equal(payload.meta.version, 'p1-chat-dashboard-v1')

  await app.close()
}

async function testP1RouteRejectsInvalidDateRange() {
  const { app } = await buildApp({
    p1Service: {
      async getDashboard(filters: P1Filters) {
        return createP1Payload(filters)
      },
    },
  })

  const response = await app.inject({
    method: 'GET',
    url: '/api/bi/p1/dashboard?date_from=2026-04-30&date_to=2026-04-01',
  })

  assert.equal(response.statusCode, 422)
  assert.equal(response.json().detail, 'date_from cannot be later than date_to.')

  await app.close()
}

async function testP1RouteMapsUpstreamFailure() {
  const { app } = await buildApp({
    p1Service: {
      async getDashboard() {
        throw new P1UpstreamError(401, 'Unauthorized')
      },
    },
  })

  const response = await app.inject({
    method: 'GET',
    url: '/api/bi/p1/dashboard?date_from=2026-04-01&date_to=2026-04-30',
  })

  assert.equal(response.statusCode, 502)
  assert.deepEqual(response.json(), {
    detail: 'P1 upstream request failed: 401 Unauthorized',
  })

  await app.close()
}

async function testP1ServiceForwardsApiKeyHeader() {
  let capturedUrl = ''
  let capturedHeader = ''
  const service = new P1Service({
    baseUrl: 'https://cs-mail.example.test',
    apiKey: 'secret-key',
    fetchImpl: async (input, init) => {
      capturedUrl = String(input)
      const headers = new Headers(init?.headers)
      capturedHeader = headers.get('x-api-key') ?? ''
      return new Response(JSON.stringify(createP1Payload({
        date_from: '2026-04-01',
        date_to: '2026-04-30',
        grain: 'week',
        agent_name: 'Mira',
      })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const payload = await service.getDashboard({
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'week',
    agent_name: 'Mira',
  }) as { summary: Record<string, unknown> }

  const url = new URL(capturedUrl)
  assert.equal(url.origin, 'https://cs-mail.example.test')
  assert.equal(url.pathname, '/api/bi/p1/dashboard')
  assert.equal(url.searchParams.get('date_from'), '2026-04-01')
  assert.equal(url.searchParams.get('date_to'), '2026-04-30')
  assert.equal(url.searchParams.get('grain'), 'week')
  assert.equal(url.searchParams.get('agent_name'), 'Mira')
  assert.equal(capturedHeader, 'secret-key')
  assert.equal(payload.summary.first_email_count, 6)
  assert.equal(payload.summary.unreplied_email_count, 1)
}

async function testP1ServiceBackfillsMissingSummaryFields() {
  const service = new P1Service({
    baseUrl: 'https://cs-mail.example.test',
    apiKey: 'secret-key',
    fetchImpl: async () => new Response(JSON.stringify({
      filters: {
        date_from: '2026-04-01',
        date_to: '2026-04-30',
        grain: 'day',
        agent_name: '',
      },
      summary: {
        inbound_email_count: 12,
        outbound_email_count: 9,
        avg_queue_hours: 2.1,
        first_response_timeout_count: 3,
      },
      trends: {},
      agent_workload: [],
      meta: { version: 'p1-chat-dashboard-v1' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })

  const payload = await service.getDashboard({
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'day',
    agent_name: '',
  }) as { summary: Record<string, unknown> }

  assert.equal(payload.summary.inbound_email_count, 12)
  assert.equal(payload.summary.first_email_count, 0)
  assert.equal(payload.summary.unreplied_email_count, 0)
}

await testP1RouteReturnsServicePayload()
await testP1RouteRejectsInvalidDateRange()
await testP1RouteMapsUpstreamFailure()
await testP1ServiceForwardsApiKeyHeader()
await testP1ServiceBackfillsMissingSummaryFields()

console.log('P1 API tests passed')
