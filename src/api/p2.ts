import { request } from '../shared/utils/apiClient'
import type {
  P2Filters, P2Overview, P2SpuRow,
} from './types'

export function fetchRefundOverview(
  filters: P2Filters, signal?: AbortSignal,
): Promise<P2Overview> {
  return request<P2Overview>('/api/bi/p2/refund-dashboard/overview', filters as never, signal)
}

export function fetchRefundSpuTable(
  filters: P2Filters, signal?: AbortSignal,
): Promise<{ rows: P2SpuRow[] }> {
  return request<{ rows: P2SpuRow[] }>('/api/bi/p2/refund-dashboard/spu-table', filters as never, signal)
}

export function fetchRefundSpuSkcOptions(
  filters: P2Filters, signal?: AbortSignal,
): Promise<{ options: { spus: string[]; skcs: string[]; pairs: Array<{ spu: string; skc: string }> } }> {
  return request('/api/bi/p2/refund-dashboard/spu-skc-options', filters as never, signal)
}
