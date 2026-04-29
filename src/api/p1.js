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

const AGENTS = [
  {
    agent_name: 'Mira',
    outboundShare: 0.22,
    spanRate: 28.6,
    scheduleRate: 20.8,
    qa: { excellent: 82, pass: 144, fail: 6 },
  },
  {
    agent_name: 'Wendy',
    outboundShare: 0.19,
    spanRate: 24.5,
    scheduleRate: 18.9,
    qa: { excellent: 76, pass: 126, fail: 8 },
  },
  {
    agent_name: 'Lila',
    outboundShare: 0.17,
    spanRate: 21.7,
    scheduleRate: 17.2,
    qa: { excellent: 71, pass: 118, fail: 5 },
  },
  {
    agent_name: 'Chloe',
    outboundShare: 0.15,
    spanRate: 19.4,
    scheduleRate: 15.6,
    qa: { excellent: 64, pass: 109, fail: 7 },
  },
  {
    agent_name: 'Mia',
    outboundShare: 0.14,
    spanRate: 18.2,
    scheduleRate: 14.8,
    qa: { excellent: 59, pass: 98, fail: 4 },
  },
  {
    agent_name: 'Jovie',
    outboundShare: 0.13,
    spanRate: 17.4,
    scheduleRate: 13.9,
    qa: { excellent: 54, pass: 92, fail: 6 },
  },
]

function parseDateInput(value) {
  const [yearText, monthText, dayText] = value.split('-')
  return new Date(Number(yearText), Number(monthText) - 1, Number(dayText))
}

function formatDateInput(date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shiftDate(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function getBucketStep(grain) {
  if (grain === 'month') {
    return 30
  }
  return grain === 'week' ? 7 : 1
}

function getDateRange(filters) {
  const start = parseDateInput(filters.date_from)
  const end = parseDateInput(filters.date_to)
  const length = Math.max(1, Math.round((end - start) / 86_400_000) + 1)
  return { start, end, length }
}

function buildTrend(filters) {
  const { start, length } = getDateRange(filters)
  const step = getBucketStep(filters.grain)
  const bucketCount = Math.max(1, Math.ceil(length / step))

  return Array.from({ length: bucketCount }, (_, index) => {
    const bucketDate = shiftDate(start, index * step)
    const seasonal = 1 + Math.sin(index * 0.85) * 0.08
    const growth = 1 + index * 0.045
    const scale = step * seasonal * growth
    const inbound = Math.round((238 + index * 11) * scale)
    const outbound = Math.round(inbound * (0.78 + (index % 3) * 0.018))
    const timeout = Math.max(2, Math.round(inbound * (0.013 + (index % 4) * 0.002)))

    return {
      bucket: formatDateInput(bucketDate),
      inbound_email_count: inbound,
      outbound_email_count: outbound,
      avg_queue_hours: Number((2.15 + (index % 5) * 0.14).toFixed(2)),
      first_response_timeout_count: timeout,
    }
  })
}

function sumTrend(trend, key) {
  return trend.reduce((total, item) => total + item[key], 0)
}

function buildAgentWorkload(totalOutbound, agentName) {
  const agents = agentName
    ? AGENTS.filter((agent) => agent.agent_name === agentName)
    : AGENTS

  return agents.map((agent) => ({
    agent_name: agent.agent_name,
    outbound_email_count: Math.round(totalOutbound * agent.outboundShare),
    avg_outbound_emails_per_hour_by_span: agent.spanRate,
    avg_outbound_emails_per_hour_by_schedule: agent.scheduleRate,
    qa_reply_counts: agent.qa,
  }))
}

/**
 * @param {P1FiltersState} filters
 * @param {AbortSignal} [signal]
 * @returns {Promise<Object>}
 */
export async function fetchP1Dashboard(filters, signal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }

  await new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(resolve, 180)

    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeoutId)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })

  const trendRows = buildTrend(filters)
  const inboundTotal = sumTrend(trendRows, 'inbound_email_count')
  const outboundTotal = sumTrend(trendRows, 'outbound_email_count')
  const timeoutTotal = sumTrend(trendRows, 'first_response_timeout_count')
  const queueWeightedTotal = trendRows.reduce(
    (total, item) => total + item.avg_queue_hours * item.inbound_email_count,
    0,
  )

  return {
    filters: {
      date_from: filters.date_from,
      date_to: filters.date_to,
      grain: filters.grain,
      agent_name: filters.agent_name ?? '',
    },
    summary: {
      inbound_email_count: inboundTotal,
      outbound_email_count: outboundTotal,
      avg_queue_hours: inboundTotal ? Number((queueWeightedTotal / inboundTotal).toFixed(2)) : 0,
      first_response_timeout_count: timeoutTotal,
    },
    trends: {
      inbound_email_count: trendRows.map((item) => ({
        bucket: item.bucket,
        value: item.inbound_email_count,
      })),
      outbound_email_count: trendRows.map((item) => ({
        bucket: item.bucket,
        value: item.outbound_email_count,
      })),
      first_response_timeout_count: trendRows.map((item) => ({
        bucket: item.bucket,
        value: item.first_response_timeout_count,
      })),
    },
    agent_workload: buildAgentWorkload(outboundTotal, filters.agent_name),
    meta: {
      version: 'p1-chat-dashboard-mock',
      source: 'mock_mail_bq_contract',
      partial_data: true,
      notes: ['当前为前端开发期 mock 数据，字段结构与 P1 API 契约保持一致。'],
    },
  }
}
