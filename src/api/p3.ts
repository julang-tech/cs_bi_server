import { request } from '../shared/utils/apiClient'
import type {
  P3Filters, P3Dashboard, P3IssueShareItem, P3ProductRankingRow,
} from './types'

export function fetchDashboard(
  filters: P3Filters, signal?: AbortSignal,
): Promise<P3Dashboard> {
  return request<P3Dashboard>('/api/bi/p3/dashboard', filters as never, signal)
}

export function fetchDrilldownOptions(
  filters: P3Filters, signal?: AbortSignal,
): Promise<{ options: P3IssueShareItem[] }> {
  return request('/api/bi/p3/drilldown-options', filters as never, signal)
}

export function fetchProductRanking(
  filters: P3Filters, signal?: AbortSignal,
): Promise<{ ranking: P3ProductRankingRow[] }> {
  return request('/api/bi/p3/product-ranking', filters as never, signal)
}
