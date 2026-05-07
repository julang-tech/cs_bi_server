import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildApp } from '../entrypoints/app.js'
import {
  P1Service,
  P1UpstreamError,
  type P1BacklogMailFilters,
  type P1Filters,
} from '../domain/p1/service.js'

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
    url: '/api/bi/p1/dashboard?date_from=2026-04-01&date_to=2026-04-30&agent_name=Mira&tz_offset_minutes=480',
  })
  const payload = response.json()

  assert.equal(response.statusCode, 200)
  assert.deepEqual(receivedFilters, {
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    grain: 'day',
    agent_name: 'Mira',
    tz_offset_minutes: 480,
  })
  assert.equal(payload.summary.inbound_email_count, 10)
  assert.equal(payload.meta.version, 'p1-chat-dashboard-v1')

  await app.close()
}

async function testP1BacklogMailRoutesProxyService() {
  let receivedFilters: P1BacklogMailFilters | null = null
  let receivedMark: { mailId: number; needsReply: boolean } | null = null
  const { app } = await buildApp({
    p1Service: {
      async getDashboard(filters: P1Filters) {
        return createP1Payload(filters)
      },
      async getBacklogMails(filters: P1BacklogMailFilters) {
        receivedFilters = filters
        return { items: [], page: { next_cursor: null }, meta: { total: 0 } }
      },
      async markBacklogMailNeedsReply(mailId: number, needsReply: boolean) {
        receivedMark = { mailId, needsReply }
        return { mail_id: mailId, needs_reply: needsReply, is_manually_reviewed: true }
      },
    },
  })

  const listResponse = await app.inject({
    method: 'GET',
    url: '/api/bi/p1/backlog-mails?date_from=2026-05-03&date_to=2026-05-03&grain=day&tz_offset_minutes=480&limit=100',
  })
  assert.equal(listResponse.statusCode, 200)
  assert.deepEqual(receivedFilters, {
    date_from: '2026-05-03',
    date_to: '2026-05-03',
    grain: 'day',
    tz_offset_minutes: 480,
    limit: 100,
  })

  const snapshotResponse = await app.inject({
    method: 'GET',
    url: '/api/bi/p1/backlog-mails?tz_offset_minutes=480',
  })
  assert.equal(snapshotResponse.statusCode, 200)
  assert.deepEqual(receivedFilters, {
    tz_offset_minutes: 480,
    limit: 100,
  })

  const patchResponse = await app.inject({
    method: 'POST',
    url: '/api/bi/p1/backlog-mails/12345/needs-reply',
    payload: { needs_reply: false },
  })
  assert.equal(patchResponse.statusCode, 200)
  assert.deepEqual(receivedMark, { mailId: 12345, needsReply: false })

  await app.close()
}


async function testP1AgentMailNameMappingRoutesPersistConfigFile() {
  const previousCwd = process.cwd()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-agent-mapping-'))
  process.chdir(tempDir)
  try {
    const { app } = await buildApp({
      p1Service: {
        async getDashboard(filters: P1Filters) {
          return createP1Payload(filters)
        },
      },
    })

    const emptyResponse = await app.inject({
      method: 'GET',
      url: '/api/bi/p1/agent-mail-name-mappings',
    })
    assert.equal(emptyResponse.statusCode, 200)
    assert.deepEqual(emptyResponse.json(), { mappings: [] })

    const saveResponse = await app.inject({
      method: 'PUT',
      url: '/api/bi/p1/agent-mail-name-mappings',
      payload: {
        mappings: [
          { agent_name: ' Mira ', mail_names: ['Mia', 'Mia', ''] },
          { agent_name: '', mail_names: ['Nobody'] },
        ],
      },
    })
    assert.equal(saveResponse.statusCode, 200)
    assert.deepEqual(saveResponse.json(), {
      mappings: [{ agent_name: 'Mira', mail_names: ['Mia'] }],
    })

    const persisted = JSON.parse(fs.readFileSync(
      path.join(tempDir, 'config', 'data', 'p1-agent-mail-name-mapping.json'),
      'utf8',
    ))
    assert.deepEqual(persisted, saveResponse.json())

    await app.close()
  } finally {
    process.chdir(previousCwd)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
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
    tz_offset_minutes: 480,
  }) as { summary: Record<string, unknown> }

  const url = new URL(capturedUrl)
  assert.equal(url.origin, 'https://cs-mail.example.test')
  assert.equal(url.pathname, '/api/bi/p1/dashboard')
  assert.equal(url.searchParams.get('date_from'), '2026-04-01')
  assert.equal(url.searchParams.get('date_to'), '2026-04-30')
  assert.equal(url.searchParams.get('grain'), 'week')
  assert.equal(url.searchParams.get('agent_name'), 'Mira')
  assert.equal(url.searchParams.get('tz_offset_minutes'), '480')
  assert.equal(capturedHeader, 'secret-key')
  assert.equal(payload.summary.first_email_count, 6)
  assert.equal(payload.summary.unreplied_email_count, 1)
}

async function testP1ServiceMarksBacklogMailWithPost() {
  let capturedUrl = ''
  let capturedMethod = ''
  let capturedBody = ''
  const service = new P1Service({
    baseUrl: 'https://cs-mail.example.test',
    apiKey: 'secret-key',
    fetchImpl: async (input, init) => {
      capturedUrl = String(input)
      capturedMethod = init?.method ?? 'GET'
      capturedBody = String(init?.body ?? '')
      return new Response(JSON.stringify({
        mail_id: 12345,
        needs_reply: false,
        is_manually_reviewed: true,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const payload = await service.markBacklogMailNeedsReply(12345, false) as {
    mail_id: number
    needs_reply: boolean
    is_manually_reviewed: boolean
  }

  const url = new URL(capturedUrl)
  assert.equal(url.pathname, '/api/bi/p1/backlog-mails/12345/needs-reply')
  assert.equal(capturedMethod, 'POST')
  assert.deepEqual(JSON.parse(capturedBody), {
    needs_reply: false,
    operator: 'dashboard',
  })
  assert.deepEqual(payload, {
    mail_id: 12345,
    needs_reply: false,
    is_manually_reviewed: true,
  })
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

async function testP1ServiceBackfillsDataAsOfFromResponseDate() {
  const service = new P1Service({
    baseUrl: 'https://cs-mail.example.test',
    apiKey: 'secret-key',
    fetchImpl: async () => new Response(JSON.stringify({
      filters: {
        date_from: '2026-05-05',
        date_to: '2026-05-05',
        grain: 'day',
        agent_name: '',
      },
      summary: {},
      trends: {},
      agent_workload: [],
      meta: { version: 'p1-chat-dashboard-v2' },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        date: 'Tue, 05 May 2026 07:15:30 GMT',
      },
    }),
  })

  const payload = await service.getDashboard({
    date_from: '2026-05-05',
    date_to: '2026-05-05',
    grain: 'day',
    agent_name: '',
  }) as { meta: Record<string, unknown> }

  assert.equal(payload.meta.data_as_of, '2026-05-05T07:15:30.000Z')
}

await testP1RouteReturnsServicePayload()
await testP1BacklogMailRoutesProxyService()
await testP1AgentMailNameMappingRoutesPersistConfigFile()
await testP1RouteRejectsInvalidDateRange()
await testP1RouteMapsUpstreamFailure()
await testP1ServiceForwardsApiKeyHeader()
await testP1ServiceMarksBacklogMailWithPost()
await testP1ServiceBackfillsMissingSummaryFields()
await testP1ServiceBackfillsDataAsOfFromResponseDate()

console.log('P1 API tests passed')
