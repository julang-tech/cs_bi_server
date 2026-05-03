import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchP1Dashboard } from './p1'

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
})
