import { request } from '../shared/utils/apiClient'
import type {
  P1BacklogMailList,
  P1BacklogMailNeedsReplyResult,
  P1Dashboard,
  P1Filters,
} from './types'

type P1BacklogMailFilters = Partial<P1Filters> & {
  limit?: number
  cursor?: string
  needs_reply?: boolean
}

type QueryParams = Record<string, string | number | boolean | null | undefined | string[]>

function withTimezoneOffset(filters: P1Filters | P1BacklogMailFilters): QueryParams {
  return {
    ...filters,
    tz_offset_minutes: -new Date().getTimezoneOffset(),
  }
}

export function fetchP1Dashboard(
  filters: P1Filters, signal?: AbortSignal,
): Promise<P1Dashboard> {
  return request<P1Dashboard>('/api/bi/p1/dashboard', withTimezoneOffset(filters), signal)
}

export function fetchP1BacklogMails(
  filters: P1BacklogMailFilters,
  signal?: AbortSignal,
): Promise<P1BacklogMailList> {
  return request<P1BacklogMailList>('/api/bi/p1/backlog-mails', withTimezoneOffset(filters), signal)
}

export async function markP1BacklogMailNeedsReply(
  mailId: number,
  needsReply: boolean,
  signal?: AbortSignal,
): Promise<P1BacklogMailNeedsReplyResult> {
  const response = await fetch(
    `/api/bi/p1/backlog-mails/${encodeURIComponent(String(mailId))}/needs-reply`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ needs_reply: needsReply, operator: 'dashboard' }),
      signal,
    },
  )
  if (!response.ok) {
    throw new Error(`请求失败：${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<P1BacklogMailNeedsReplyResult>
}
