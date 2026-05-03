import { request } from '../shared/utils/apiClient'
import type { P1Filters, P1Dashboard } from './types'

export function fetchP1Dashboard(
  filters: P1Filters, signal?: AbortSignal,
): Promise<P1Dashboard> {
  return request<P1Dashboard>('/api/bi/p1/dashboard', {
    ...filters,
    tz_offset_minutes: -new Date().getTimezoneOffset(),
  }, signal)
}
