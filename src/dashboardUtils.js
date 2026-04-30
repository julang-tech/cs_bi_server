export const GRAIN_OPTIONS = [
  { value: 'day', label: '按天' },
  { value: 'week', label: '按周' },
  { value: 'month', label: '按月' },
]

export const DATE_BASIS_OPTIONS = [
  { value: 'order_date', label: '订单时间' },
  { value: 'refund_date', label: '退款时间' },
]

export const RANKING_PAGE_SIZE_OPTIONS = [5, 10, 20, 50]

export const AGENT_OPTIONS = [
  { value: '', label: '全部客服' },
  { value: 'Mira', label: 'Mira' },
  { value: 'Wendy', label: 'Wendy' },
  { value: 'Lila', label: 'Lila' },
  { value: 'Chloe', label: 'Chloe' },
  { value: 'Mia', label: 'Mia' },
  { value: 'Jovie', label: 'Jovie' },
]

const ISSUE_ORDER = ['product', 'logistics', 'warehouse']

export const ISSUE_COPY = {
  product: {
    label: '产品问题',
    accent: 'issue-row--product',
  },
  logistics: {
    label: '物流问题',
    accent: 'issue-row--logistics',
  },
  warehouse: {
    label: '仓库问题',
    accent: 'issue-row--warehouse',
  },
}

export function formatDateInput(date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function createDefaultDateWindow() {
  const end = shiftDate(new Date(), -1)
  const start = shiftDate(end, -30)
  return {
    date_from: formatDateInput(start),
    date_to: formatDateInput(end),
  }
}

export function createDefaultFilters() {
  const dateWindow = createDefaultDateWindow()
  return {
    grain: 'week',
    date_basis: 'order_date',
    ...dateWindow,
  }
}

export function createDefaultP1Filters() {
  const dateWindow = createDefaultDateWindow()
  return {
    grain: 'day',
    ...dateWindow,
    agent_name: '',
  }
}

export function formatInteger(value) {
  return new Intl.NumberFormat('zh-CN').format(value ?? 0)
}

export function formatPercent(value, digits = 2) {
  return `${((value ?? 0) * 100).toFixed(digits)}%`
}

export function formatHours(value, digits = 1) {
  return `${(value ?? 0).toFixed(digits)}h`
}

export function formatDecimal(value, digits = 1) {
  return (value ?? 0).toFixed(digits)
}

function formatDeltaPercent(value) {
  return `${value > 0 ? '↑' : '↓'} ${Math.abs(value * 100).toFixed(1)}%`
}

function formatDeltaPp(value) {
  return `${value > 0 ? '↑' : '↓'} ${Math.abs(value * 100).toFixed(2)}pp`
}

export function shiftDate(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function parseDateInput(value) {
  const [yearText, monthText, dayText] = value.split('-')
  return new Date(Number(yearText), Number(monthText) - 1, Number(dayText))
}

function getGrainDays(grain) {
  if (grain === 'day') {
    return 1
  }
  return grain === 'week' ? 7 : 30
}

export function getMetricWindow(grain, dateTo) {
  const periodDays = getGrainDays(grain)
  const end = parseDateInput(dateTo)
  const start = shiftDate(end, -(periodDays - 1))
  return {
    date_from: formatDateInput(start),
    date_to: formatDateInput(end),
  }
}

export function getPreviousDateWindow(window) {
  const start = parseDateInput(window.date_from)
  const end = parseDateInput(window.date_to)
  const lengthDays = Math.max(1, Math.round((end - start) / 86_400_000) + 1)
  const previousEnd = shiftDate(start, -1)
  const previousStart = shiftDate(previousEnd, -(lengthDays - 1))
  return {
    date_from: formatDateInput(previousStart),
    date_to: formatDateInput(previousEnd),
  }
}

export function getMetricWindowLabel(grain) {
  if (grain === 'day') {
    return '末日'
  }
  return grain === 'week' ? '近7天' : '近30天'
}

export function buildDelta(currentValue, previousValue, mode = 'percent') {
  if (previousValue === null || previousValue === undefined) {
    return { tone: 'muted', text: '--' }
  }

  if (mode === 'pp') {
    const diff = (currentValue ?? 0) - (previousValue ?? 0)
    if (diff === 0) {
      return { tone: 'neutral', text: '0.00pp' }
    }
    return {
      tone: diff > 0 ? 'up' : 'down',
      text: formatDeltaPp(diff),
    }
  }

  if (!previousValue) {
    return { tone: 'muted', text: '--' }
  }

  const ratio = ((currentValue ?? 0) - previousValue) / previousValue
  if (ratio === 0) {
    return { tone: 'neutral', text: '0.0%' }
  }

  return {
    tone: ratio > 0 ? 'up' : 'down',
    text: formatDeltaPercent(ratio),
  }
}

export function buildSparklinePoints(items) {
  if (!items.length) {
    return ''
  }

  const max = Math.max(...items.map((item) => item.value), 0)
  const safeMax = max === 0 ? 1 : max

  return items
    .map((item, index) => {
      const x = items.length === 1 ? 50 : (index / (items.length - 1)) * 100
      const y = 100 - (item.value / safeMax) * 100
      return `${x},${y}`
    })
    .join(' ')
}

export function buildSparklineArea(items) {
  if (!items.length) {
    return ''
  }

  const points = buildSparklinePoints(items)
  const firstX = items.length === 1 ? 50 : 0
  const lastX = items.length === 1 ? 50 : 100
  return `${firstX},100 ${points} ${lastX},100`
}

export function buildChartPointData(items) {
  if (!items.length) {
    return []
  }

  const max = Math.max(...items.map((item) => item.value), 0)
  const safeMax = max === 0 ? 1 : max

  return items.map((item, index) => ({
    ...item,
    x: items.length === 1 ? 50 : (index / (items.length - 1)) * 100,
    y: 100 - (item.value / safeMax) * 100,
  }))
}

export function sortIssueShare(items, options, salesQty) {
  const optionsByType = new Map((options ?? []).map((item) => [item.major_issue_type, item]))
  const issueByType = new Map((items ?? []).map((item) => [item.major_issue_type, item]))

  return ISSUE_ORDER.map((type) => {
    const item = issueByType.get(type)
    const option = optionsByType.get(type)
    const count = item?.count ?? option?.count ?? 0
    return {
      major_issue_type: type,
      label: item?.label ?? option?.label ?? ISSUE_COPY[type].label,
      count,
      ratio: item?.ratio ?? option?.ratio ?? 0,
      estimatedRate: salesQty ? count / salesQty : 0,
      target_page: option?.target_page ?? null,
    }
  })
}
