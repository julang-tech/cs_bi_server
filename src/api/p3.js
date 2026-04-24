/**
 * @typedef {'product' | 'warehouse' | 'logistics'} MajorIssueType
 */

/**
 * @typedef {Object} FiltersState
 * @property {string} date_from
 * @property {string} date_to
 * @property {'day' | 'week' | 'month'} grain
 * @property {string} sku
 * @property {string} skc
 * @property {string} spu
 */

/**
 * @typedef {Object} DashboardResponse
 * @property {Object} filters
 * @property {Object} summary
 * @property {Object} trends
 * @property {Array<Object>} issue_share
 * @property {Object} meta
 */

/**
 * @typedef {Object} DrilldownOptionsResponse
 * @property {Object} filters
 * @property {Array<Object>} options
 * @property {Object} meta
 */

/**
 * @typedef {Object} DrilldownPreviewResponse
 * @property {Object} filters
 * @property {Object} preview
 * @property {Object} meta
 */

function buildQuery(params) {
  const search = new URLSearchParams()

  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      search.set(key, value)
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

/**
 * @param {FiltersState} filters
 * @param {AbortSignal} [signal]
 * @returns {Promise<DashboardResponse>}
 */
export function fetchDashboard(filters, signal) {
  return request('/api/bi/p3/dashboard', filters, signal)
}

/**
 * @param {FiltersState} filters
 * @param {AbortSignal} [signal]
 * @returns {Promise<DrilldownOptionsResponse>}
 */
export function fetchDrilldownOptions(filters, signal) {
  return request('/api/bi/p3/drilldown-options', filters, signal)
}

/**
 * @param {FiltersState & { major_issue_type: MajorIssueType }} filters
 * @param {AbortSignal} [signal]
 * @returns {Promise<DrilldownPreviewResponse>}
 */
export function fetchDrilldownPreview(filters, signal) {
  return request('/api/bi/p3/drilldown-preview', filters, signal)
}
