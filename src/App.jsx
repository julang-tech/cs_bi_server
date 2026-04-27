import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  fetchDashboard,
  fetchDrilldownOptions,
  fetchDrilldownPreview,
} from './api/p3'

const GRAIN_OPTIONS = [
  { value: 'day', label: '按天' },
  { value: 'week', label: '按周' },
  { value: 'month', label: '按月' },
]

const ISSUE_ORDER = ['product', 'logistics', 'warehouse']

const ISSUE_COPY = {
  product: {
    label: '产品问题',
    previewTitle: '产品问题预览表',
    badgeTone: 'warm',
    accent: 'issue-row--product',
  },
  logistics: {
    label: '物流问题',
    previewTitle: '物流问题预览表',
    badgeTone: 'cool',
    accent: 'issue-row--logistics',
  },
  warehouse: {
    label: '仓库问题',
    previewTitle: '仓库问题预览表',
    badgeTone: 'deep',
    accent: 'issue-row--warehouse',
  },
}

function formatDateInput(date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function createDefaultFilters() {
  return {
    grain: 'week',
    sku: '',
    skc: '',
    spu: '',
  }
}

function formatInteger(value) {
  return new Intl.NumberFormat('zh-CN').format(value ?? 0)
}

function formatPercent(value, digits = 2) {
  return `${((value ?? 0) * 100).toFixed(digits)}%`
}

function formatDeltaPercent(value) {
  return `${value > 0 ? '↑' : '↓'} ${Math.abs(value * 100).toFixed(1)}%`
}

function formatDeltaPp(value) {
  return `${value > 0 ? '↑' : '↓'} ${Math.abs(value * 100).toFixed(2)}pp`
}

function shiftDate(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function getResolvedDateWindow(grain) {
  const end = shiftDate(new Date(), -1)

  if (grain === 'day') {
    const previousEnd = shiftDate(end, -1)
    return {
      current: {
        date_from: formatDateInput(end),
        date_to: formatDateInput(end),
      },
      previous: {
        date_from: formatDateInput(previousEnd),
        date_to: formatDateInput(previousEnd),
      },
      label: '昨日',
    }
  }

  if (grain === 'week') {
    const currentStart = shiftDate(end, -6)
    const previousEnd = shiftDate(currentStart, -1)
    const previousStart = shiftDate(previousEnd, -6)
    return {
      current: {
        date_from: formatDateInput(currentStart),
        date_to: formatDateInput(end),
      },
      previous: {
        date_from: formatDateInput(previousStart),
        date_to: formatDateInput(previousEnd),
      },
      label: '截至昨日近7天',
    }
  }

  const currentStart = shiftDate(end, -29)
  const previousEnd = shiftDate(currentStart, -1)
  const previousStart = shiftDate(previousEnd, -29)
  return {
    current: {
      date_from: formatDateInput(currentStart),
      date_to: formatDateInput(end),
    },
    previous: {
      date_from: formatDateInput(previousStart),
      date_to: formatDateInput(previousEnd),
    },
    label: '截至昨日近30天',
  }
}

function buildDelta(currentValue, previousValue, mode = 'percent') {
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

function buildSparklinePoints(items) {
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

function buildSparklineArea(items) {
  if (!items.length) {
    return ''
  }

  const points = buildSparklinePoints(items)
  const firstX = items.length === 1 ? 50 : 0
  const lastX = items.length === 1 ? 50 : 100
  return `${firstX},100 ${points} ${lastX},100`
}

function sortIssueShare(items, options, salesQty) {
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

function selectProductRows(preview) {
  if (preview?.top_spus?.length) {
    return {
      title: 'SPU 预览',
      valueKey: 'spu',
      rows: preview.top_spus,
    }
  }

  return {
    title: 'SKC 预览',
    valueKey: 'skc',
    rows: preview?.top_skcs ?? [],
  }
}

function MiniSparkline({ items }) {
  if (!items?.length) {
    return <div className="mini-placeholder">当前卡片不展示趋势折线</div>
  }

  const points = buildSparklinePoints(items)
  const area = buildSparklineArea(items)

  return (
    <div className="mini-chart" aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="summary-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <polyline fill="url(#summary-gradient)" points={area} />
        <polyline className="mini-chart__line" fill="none" points={points} />
      </svg>
    </div>
  )
}

function SummaryCard({ title, value, description, badge, tone, trendItems }) {
  return (
    <article className={`summary-card summary-card--${tone}`}>
      <div className="summary-card__header">
        <h2>{title}</h2>
        <span className={`summary-badge summary-badge--${badge.tone}`}>{badge.label}</span>
      </div>
      <div className="summary-card__value">{value}</div>
      <p className="summary-card__description">{description}</p>
      <MiniSparkline items={trendItems} />
    </article>
  )
}

function TableSection({ title, hint, columns, rows, emptyCopy, rowTone, onRowClick }) {
  return (
    <section className="table-card">
      <div className="table-card__header">
        <h3>{title}</h3>
        {hint ? <span className="table-card__hint">{hint}</span> : null}
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const content = (
                  <>
                    {columns.map((column) => (
                      <td key={column.key} data-label={column.label}>
                        {column.render ? column.render(row, index) : row[column.key]}
                      </td>
                    ))}
                  </>
                )

                if (onRowClick) {
                  return (
                    <tr
                      key={`${title}-${index}`}
                      className={`is-clickable ${rowTone ? rowTone(row) : ''}`}
                      onClick={() => onRowClick(row)}
                    >
                      {content}
                    </tr>
                  )
                }

                return <tr key={`${title}-${index}`}>{content}</tr>
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state empty-state--table">{emptyCopy}</div>
      )}
    </section>
  )
}

function App() {
  const defaultFilters = useMemo(() => createDefaultFilters(), [])
  const previewRef = useRef(null)
  const [filters, setFilters] = useState(defaultFilters)
  const [submittedFilters, setSubmittedFilters] = useState(defaultFilters)
  const [dashboard, setDashboard] = useState(null)
  const [previousDashboard, setPreviousDashboard] = useState(null)
  const [options, setOptions] = useState([])
  const [preview, setPreview] = useState(null)
  const [activeIssueType, setActiveIssueType] = useState('product')
  const [dashboardLoading, setDashboardLoading] = useState(true)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [dashboardError, setDashboardError] = useState('')
  const [previewError, setPreviewError] = useState('')

  useEffect(() => {
    const controller = new AbortController()

    async function loadDashboard() {
      setDashboardLoading(true)
      setDashboardError('')
      const resolvedWindow = getResolvedDateWindow(submittedFilters.grain)
      const currentFilters = { ...submittedFilters, ...resolvedWindow.current }
      const previousFilters = { ...submittedFilters, ...resolvedWindow.previous }

      try {
        const [dashboardResponse, previousDashboardResponse] = await Promise.all([
          fetchDashboard(currentFilters, controller.signal),
          fetchDashboard(previousFilters, controller.signal),
        ])
        setDashboard(dashboardResponse)
        setPreviousDashboard(previousDashboardResponse)

        try {
          const drilldownOptions = await fetchDrilldownOptions(
            currentFilters,
            controller.signal,
          )
          setOptions(drilldownOptions.options ?? [])
        } catch (error) {
          if (error.name !== 'AbortError') {
            setOptions([])
          }
        }

        setPreview(null)
        setPreviewError('')
      } catch (error) {
        if (error.name !== 'AbortError') {
          setDashboard(null)
          setPreviousDashboard(null)
          setOptions([])
          setPreview(null)
          setDashboardError(error.message || 'P3 总览加载失败，请稍后重试。')
        }
      } finally {
        if (!controller.signal.aborted) {
          setDashboardLoading(false)
        }
      }
    }

    loadDashboard()

    return () => controller.abort()
  }, [submittedFilters])

  useEffect(() => {
    if (!activeIssueType) {
      return undefined
    }

    const controller = new AbortController()

    async function loadPreview() {
      setPreviewLoading(true)
      setPreviewError('')
      const resolvedWindow = getResolvedDateWindow(submittedFilters.grain)

      try {
        const previewResponse = await fetchDrilldownPreview(
          {
            ...submittedFilters,
            ...resolvedWindow.current,
            major_issue_type: activeIssueType,
          },
          controller.signal,
        )
        setPreview(previewResponse.preview ?? null)
      } catch (error) {
        if (error.name !== 'AbortError') {
          setPreview(null)
          setPreviewError(error.message || '下钻预览加载失败，请稍后重试。')
        }
      } finally {
        if (!controller.signal.aborted) {
          setPreviewLoading(false)
        }
      }
    }

    loadPreview()

    return () => controller.abort()
  }, [activeIssueType, submittedFilters])

  useEffect(() => {
    if (activeIssueType && previewRef.current) {
      previewRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [activeIssueType])

  const summary = dashboard?.summary
  const previousSummary = previousDashboard?.summary
  const meta = dashboard?.meta
  const resolvedWindow = useMemo(
    () => getResolvedDateWindow(submittedFilters.grain),
    [submittedFilters.grain],
  )

  const issueRows = useMemo(
    () => sortIssueShare(dashboard?.issue_share, options, dashboard?.summary?.sales_qty ?? 0),
    [dashboard?.issue_share, options, dashboard?.summary?.sales_qty],
  )

  const productRows = useMemo(() => selectProductRows(preview), [preview])
  const activeIssueMeta = ISSUE_COPY[activeIssueType] ?? ISSUE_COPY.product
  const salesDelta = buildDelta(summary?.sales_qty, previousSummary?.sales_qty, 'percent')
  const complaintDelta = buildDelta(
    summary?.complaint_count,
    previousSummary?.complaint_count,
    'percent',
  )
  const complaintRateDelta = buildDelta(
    summary?.complaint_rate,
    previousSummary?.complaint_rate,
    'pp',
  )

  const issueColumns = [
    {
      key: 'label',
      label: '客诉原因',
      render: (row) => (
        <span className={`issue-label ${ISSUE_COPY[row.major_issue_type].accent}`}>
          {row.label}
        </span>
      ),
    },
    {
      key: 'estimatedRate',
      label: '客诉率',
      render: (row) => formatPercent(row.estimatedRate, 2),
    },
    {
      key: 'ratio',
      label: '客诉占比',
      render: (row) => formatPercent(row.ratio, 1),
    },
  ]

  const reasonColumns = [
    {
      key: 'rank',
      label: '排名',
      render: (_, index) => <span className="rank-pill">{index + 1}</span>,
    },
    {
      key: 'reason',
      label: '原因',
    },
    {
      key: 'count',
      label: '客诉量',
      render: (row) => formatInteger(row.count),
    },
  ]

  const productColumns = [
    {
      key: 'rank',
      label: '排名',
      render: (_, index) => <span className="rank-pill">{index + 1}</span>,
    },
    {
      key: 'item',
      label: productRows.title,
      render: (row) => row[productRows.valueKey] ?? '--',
    },
    {
      key: 'count',
      label: '客诉量',
      render: (row) => formatInteger(row.count),
    },
  ]

  const orderColumns = [
    {
      key: 'rank',
      label: '排名',
      render: (_, index) => <span className="rank-pill">{index + 1}</span>,
    },
    {
      key: 'order_no',
      label: '订单号',
    },
    {
      key: 'reason',
      label: '原因',
    },
  ]

  function handleFilterChange(event) {
    const { name, value } = event.target
    setFilters((current) => ({ ...current, [name]: value }))
  }

  function handleSubmit(event) {
    event.preventDefault()
    setSubmittedFilters({ ...filters })
  }

  function handleReset() {
    setFilters(defaultFilters)
    setSubmittedFilters(defaultFilters)
  }

  function handleGrainChange(grain) {
    const nextFilters = { ...filters, grain }
    setFilters(nextFilters)
    setSubmittedFilters(nextFilters)
  }

  return (
    <main className="dashboard-shell">
      <section className="toolbar-panel">
        <div className="segmented-control" role="tablist" aria-label="粒度切换">
          {GRAIN_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`segment-button ${
                submittedFilters.grain === option.value ? 'segment-button--active' : ''
              }`}
              onClick={() => handleGrainChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <form className="toolbar-form" onSubmit={handleSubmit}>
          <input
            type="text"
            name="sku"
            value={filters.sku}
            onChange={handleFilterChange}
            placeholder="SKU"
            aria-label="SKU"
          />
          <input
            type="text"
            name="skc"
            value={filters.skc}
            onChange={handleFilterChange}
            placeholder="SKC"
            aria-label="SKC"
          />
          <input
            type="text"
            name="spu"
            value={filters.spu}
            onChange={handleFilterChange}
            placeholder="SPU"
            aria-label="SPU"
          />
          <button type="submit" className="toolbar-button toolbar-button--primary">
            查询
          </button>
          <button type="button" className="toolbar-button" onClick={handleReset}>
            重置
          </button>
        </form>
      </section>

      <section className="scope-strip">
        <span>当前时间口径</span>
        <strong>{resolvedWindow.label}</strong>
      </section>

      {dashboardError ? <section className="status-banner status-banner--error">{dashboardError}</section> : null}
      {meta?.partial_data ? (
        <section className="status-banner status-banner--warning">
          当前结果含部分数据缺口，请结合运行时备注判断是否需要回查源数据。
        </section>
      ) : null}

      <section className="summary-grid">
        <SummaryCard
          title="销量"
          value={dashboardLoading ? '--' : formatInteger(summary?.sales_qty)}
          description="销售件数持续走高，需同步关注售后压力是否同步放大。"
          badge={{
            label: dashboardLoading ? '计算中' : salesDelta.text,
            tone: salesDelta.tone,
          }}
          tone="sales"
          trendItems={dashboard?.trends?.sales_qty ?? []}
        />
        <SummaryCard
          title="客诉量"
          value={dashboardLoading ? '--' : formatInteger(summary?.complaint_count)}
          description="客诉量上升低于销量增速，整体仍处于可控区间。"
          badge={{
            label: dashboardLoading ? '计算中' : complaintDelta.text,
            tone: complaintDelta.tone,
          }}
          tone="complaints"
          trendItems={dashboard?.trends?.complaint_count ?? []}
        />
        <SummaryCard
          title="客诉率"
          value={dashboardLoading ? '--' : formatPercent(summary?.complaint_rate, 2)}
          description="按总销量口径观察问题密度，优先识别异常商品与异常分类。"
          badge={{
            label: dashboardLoading ? '计算中' : complaintRateDelta.text,
            tone: complaintRateDelta.tone,
          }}
          tone="rate"
          trendItems={dashboard?.trends?.complaint_rate ?? []}
        />
      </section>

      <TableSection
        title="问题结构分析"
        hint="客诉率为按总销量估算的分类客诉率"
        columns={issueColumns}
        rows={issueRows}
        emptyCopy="暂无问题结构数据"
        rowTone={(row) => ISSUE_COPY[row.major_issue_type].accent}
        onRowClick={(row) => setActiveIssueType(row.major_issue_type)}
      />

      <section className="preview-panel" ref={previewRef}>
        <div className="preview-panel__header">
          <div>
            <h3>{activeIssueMeta.previewTitle}</h3>
            <p>
              点击上方问题结构表行即可切换预览分类。当前仅展示现有 P3 能力可直接支持的原因、商品或订单样本数据。
            </p>
          </div>
          <span className={`summary-badge summary-badge--${activeIssueMeta.badgeTone}`}>
            {activeIssueMeta.label}
          </span>
        </div>

        {previewLoading ? (
          <div className="empty-state">正在加载预览数据...</div>
        ) : previewError ? (
          <div className="empty-state empty-state--error">{previewError}</div>
        ) : activeIssueType === 'logistics' ? (
          <div className="preview-grid">
            <TableSection
              title="原因预览"
              columns={reasonColumns}
              rows={preview?.top_reasons ?? []}
              emptyCopy="暂无物流问题原因数据"
            />
            <TableSection
              title="订单样本"
              columns={orderColumns}
              rows={preview?.sample_orders ?? []}
              emptyCopy="暂无订单样本"
            />
          </div>
        ) : (
          <div className="preview-grid">
            <TableSection
              title="原因预览"
              columns={reasonColumns}
              rows={preview?.top_reasons ?? []}
              emptyCopy={`暂无${activeIssueMeta.label}原因数据`}
            />
            <TableSection
              title="商品预览"
              hint="当前展示接口可返回的商品聚合"
              columns={productColumns}
              rows={productRows.rows ?? []}
              emptyCopy={`暂无${activeIssueMeta.label}商品数据`}
            />
          </div>
        )}
      </section>

      <section className="meta-strip">
        <div className="meta-strip__item">
          <span>接口版本</span>
          <strong>{meta?.version ?? 'p3-formal-runtime'}</strong>
        </div>
        <div className="meta-strip__item">
          <span>数据源模式</span>
          <strong>
            {meta?.source_modes?.length ? meta.source_modes.join(' / ') : '暂无 source mode 信息'}
          </strong>
        </div>
      </section>
    </main>
  )
}

export default App
