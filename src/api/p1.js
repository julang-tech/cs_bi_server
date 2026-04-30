/**
 * @typedef {'day' | 'week' | 'month'} Grain
 */

/**
 * @typedef {Object} P1FiltersState
 * @property {string} date_from
 * @property {string} date_to
 * @property {Grain} grain
 * @property {string} [agent_name]
 */

function buildQuery(params) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      search.set(key, String(value))
    }
  })
  return search.toString()
}

/**
 * @param {P1FiltersState} filters
 * @param {AbortSignal} [signal]
 * @returns {Promise<Object>}
 */
export async function fetchP1Dashboard(filters, signal) {
  const query = buildQuery(filters)
  const response = await fetch(query ? `/api/bi/p1/dashboard?${query}` : '/api/bi/p1/dashboard', {
    signal,
  })

  if (!response.ok) {
    throw new Error(`请求失败：${response.status} ${response.statusText}`)
  }

  return response.json()
}
