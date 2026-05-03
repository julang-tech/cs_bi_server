import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchP1BacklogMails,
  fetchP1Dashboard,
  markP1BacklogMailNeedsReply,
} from './p1'

describe('fetchP1Dashboard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sends timezone offset minutes east of UTC to the MailDB dashboard API', async () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480)
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({}),
    } as Response))
    vi.stubGlobal('fetch', fetchMock)

    await fetchP1Dashboard({
      date_from: '2026-05-02',
      date_to: '2026-05-02',
      grain: 'day',
      agent_name: '',
    })

    expect(fetchMock).toHaveBeenCalled()
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost')
    expect(url.pathname).toBe('/api/bi/p1/dashboard')
    expect(url.searchParams.get('tz_offset_minutes')).toBe('480')
  })

  it('fetches backlog mails with dashboard filters and timezone offset', async () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480)
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ items: [], page: { next_cursor: null }, meta: { total: 0 } }),
    } as Response))
    vi.stubGlobal('fetch', fetchMock)

    await fetchP1BacklogMails({
      date_from: '2026-05-03',
      date_to: '2026-05-03',
      grain: 'day',
      agent_name: '',
      limit: 100,
    })

    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost')
    expect(url.pathname).toBe('/api/bi/p1/backlog-mails')
    expect(url.searchParams.get('date_from')).toBe('2026-05-03')
    expect(url.searchParams.get('tz_offset_minutes')).toBe('480')
    expect(url.searchParams.get('limit')).toBe('100')
  })

  it('marks a backlog mail needs-reply state', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ mail_id: 12345, needs_reply: false, is_manually_reviewed: true }),
    } as Response))
    vi.stubGlobal('fetch', fetchMock)

    await markP1BacklogMailNeedsReply(12345, false)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/bi/p1/backlog-mails/12345/needs-reply',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ needs_reply: false, operator: 'dashboard' }),
      }),
    )
  })
})
