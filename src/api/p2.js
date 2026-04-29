function buildQuery(params) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      search.set(key, String(value))
    }
  })
  return search.toString()
}

async function request(path, params, signal) {
  const query = buildQuery(params)
  const response = await fetch(query ? `${path}?${query}` : path, { signal })
  if (!response.ok) {
    throw new Error(`请求失败：${response.status} ${response.statusText}`)
  }
  return response.json()
}

export function fetchRefundOverview(filters, signal) {
  return request('/api/bi/p2/refund-dashboard/overview', filters, signal)
}

export function fetchRefundSpuTable(filters, signal) {
  return request('/api/bi/p2/refund-dashboard/spu-table', filters, signal)
}

