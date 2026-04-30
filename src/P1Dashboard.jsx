import { useEffect, useMemo, useState } from 'react'
import { fetchP1Dashboard } from './api/p1'
import { MultiLineTrendChart, SummaryCard, TableSection } from './dashboardComponents'
import {
  AGENT_OPTIONS,
  GRAIN_OPTIONS,
  createDefaultP1Filters,
  formatDecimal,
  formatHours,
  formatInteger,
  getMetricWindow,
  getMetricWindowLabel,
} from './dashboardUtils'

function WorkloadAverageChart({ rows }) {
  if (!rows.length) {
    return <div className="empty-state p1-workload-chart">暂无坐席均值数据</div>
  }

  const metrics = [
    {
      key: 'span',
      label: '首末封均值',
      className: 'p1-workload-bar--span',
      getValue: (row) => row.avg_outbound_emails_per_hour_by_span ?? 0,
    },
    {
      key: 'schedule',
      label: '工时表均值',
      className: 'p1-workload-bar--schedule',
      getValue: (row) => row.avg_outbound_emails_per_hour_by_schedule ?? 0,
    },
  ]
  const maxValue = Math.max(...metrics.flatMap((item) => rows.map((row) => item.getValue(row))), 1)

  return (
    <div className="p1-workload-chart">
      <div className="p1-trend-legend p1-workload-legend" aria-label="坐席均值图例">
        <span className="p1-legend-item p1-workload-legend--span">首末封均值</span>
        <span className="p1-legend-item p1-workload-legend--schedule">工时表均值</span>
      </div>
      <div className="p1-workload-bars" aria-label="坐席回复均值对比">
        {rows.map((row) => (
          <div key={row.agent_name} className="p1-workload-bars__row">
            <strong>{row.agent_name}</strong>
            <div className="p1-workload-bars__tracks">
              {metrics.map((item) => {
                const value = item.getValue(row)
                const width = `${Math.max(3, (value / maxValue) * 100)}%`

                return (
                  <div key={item.key} className="p1-workload-bars__track">
                    <span className={`p1-workload-bar ${item.className}`} style={{ width }} />
                    <span className="p1-workload-bars__value">{formatDecimal(value)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function P1Dashboard() {
  const defaultFilters = useMemo(() => createDefaultP1Filters(), [])
  const [filters, setFilters] = useState(defaultFilters)
  const [dashboard, setDashboard] = useState(null)
  const [metricDashboard, setMetricDashboard] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()

    async function loadDashboard() {
      setLoading(true)
      setError('')

      try {
        const metricWindow = getMetricWindow(filters.grain, filters.date_to)
        const metricFilters = { ...filters, ...metricWindow }
        const [dashboardResponse, metricDashboardResponse] = await Promise.all([
          fetchP1Dashboard(filters, controller.signal),
          fetchP1Dashboard(metricFilters, controller.signal),
        ])
        setDashboard(dashboardResponse)
        setMetricDashboard(metricDashboardResponse)
      } catch (loadError) {
        if (loadError.name !== 'AbortError') {
          setDashboard(null)
          setMetricDashboard(null)
          setError(loadError.message || 'P1 聊天数据加载失败，请稍后重试。')
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    loadDashboard()
    return () => controller.abort()
  }, [filters])

  const updateDateFilter = (field, value) => {
    if (!value) {
      return
    }

    setFilters((current) => {
      const next = { ...current, [field]: value }
      if (next.date_from > next.date_to) {
        return current
      }
      return next
    })
  }

  const summary = metricDashboard?.summary
  const rangeSummary = dashboard?.summary
  const metricWindowLabel = getMetricWindowLabel(filters.grain)
  const agentRows = dashboard?.agent_workload ?? []
  const timeoutTrendItems = dashboard?.trends?.first_response_timeout_count ?? []
  const timeoutRangeAverage = timeoutTrendItems.length
    ? timeoutTrendItems.reduce((total, item) => total + item.value, 0) / timeoutTrendItems.length
    : 0
  const trendSeries = [
    {
      key: 'inbound',
      label: '来邮数',
      items: dashboard?.trends?.inbound_email_count ?? [],
      formatter: formatInteger,
    },
    {
      key: 'outbound',
      label: '回邮数',
      items: dashboard?.trends?.outbound_email_count ?? [],
      formatter: formatInteger,
    },
  ]
  const timeoutTrendSeries = [
    {
      key: 'timeout',
      label: '超时次数',
      items: timeoutTrendItems,
      formatter: formatInteger,
    },
  ]
  const workloadColumns = [
    {
      key: 'agent_name',
      label: '客服姓名',
      render: (row) => <strong>{row.agent_name}</strong>,
    },
    {
      key: 'outbound_email_count',
      label: '总回邮数',
      render: (row) => formatInteger(row.outbound_email_count),
    },
    {
      key: 'avg_outbound_emails_per_hour_by_span',
      label: '每小时回邮数均值（首末封）',
      render: (row) => formatDecimal(row.avg_outbound_emails_per_hour_by_span),
    },
    {
      key: 'avg_outbound_emails_per_hour_by_schedule',
      label: '每小时回邮数均值（工时表）',
      render: (row) => formatDecimal(row.avg_outbound_emails_per_hour_by_schedule),
    },
    {
      key: 'qa_reply_counts',
      label: '质检结果回邮数',
      render: (row) => {
        const qa = row.qa_reply_counts ?? {}
        return `${formatInteger(qa.excellent)} / ${formatInteger(qa.pass)} / ${formatInteger(qa.fail)}`
      },
    },
  ]

  return (
    <main className="dashboard-shell p1-dashboard">
      <section className="toolbar-panel">
        <div className="toolbar-group">
          <span className="toolbar-label">时间粒度</span>
          <div className="segmented-control" role="tablist" aria-label="粒度切换">
            {GRAIN_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`segment-button ${filters.grain === option.value ? 'segment-button--active' : ''}`}
                onClick={() => setFilters((current) => ({ ...current, grain: option.value }))}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">客服姓名</span>
          <label className="select-control">
            <select
              value={filters.agent_name}
              onChange={(event) => setFilters((current) => ({ ...current, agent_name: event.target.value }))}
            >
              {AGENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="toolbar-group toolbar-group--dates">
          <span className="toolbar-label">日期范围</span>
          <div className="date-range-control">
            <label className="date-field">
              <span>开始</span>
              <input
                type="date"
                value={filters.date_from}
                max={filters.date_to}
                onChange={(event) => updateDateFilter('date_from', event.target.value)}
              />
            </label>
            <label className="date-field">
              <span>结束</span>
              <input
                type="date"
                value={filters.date_to}
                min={filters.date_from}
                onChange={(event) => updateDateFilter('date_to', event.target.value)}
              />
            </label>
          </div>
        </div>
      </section>

      {error ? <section className="status-banner status-banner--error">{error}</section> : null}
      {dashboard?.meta?.partial_data ? (
        <section className="status-banner status-banner--info">
          {dashboard.meta.notes?.[0] ?? '当前数据存在局部缺失。'}
        </section>
      ) : null}

      <section className="summary-grid p1-summary-grid">
        <SummaryCard
          title="来邮数"
          value={loading ? '--' : formatInteger(summary?.inbound_email_count)}
          rangeLabel="范围总量"
          rangeValue={loading ? '--' : formatInteger(rangeSummary?.inbound_email_count)}
          description="客户发送邮件的封数，按自然日汇总后作为总体待处理规模口径。"
          badge={{ label: '客户邮件封数', tone: 'cool' }}
          tone="sales"
        />
        <SummaryCard
          title="回邮数"
          value={loading ? '--' : formatInteger(summary?.outbound_email_count)}
          rangeLabel="范围总量"
          rangeValue={loading ? '--' : formatInteger(rangeSummary?.outbound_email_count)}
          description="客服回复邮件的封数，反映坐席实际处理量。"
          badge={{ label: '客服回复封数', tone: 'rose' }}
          tone="complaints"
        />
        <SummaryCard
          title="平均会话排队时长"
          value={loading ? '--' : formatHours(summary?.avg_queue_hours, 1)}
          rangeLabel="范围均值"
          rangeValue={loading ? '--' : formatHours(rangeSummary?.avg_queue_hours, 1)}
          description="客户邮件到人工回复的时间差均值，用于衡量响应效率。"
          badge={{ label: '客户首封到人工首回', tone: 'cool' }}
          tone="rate"
        />
        <SummaryCard
          title="首次响应超时次数"
          value={loading ? '--' : formatInteger(summary?.first_response_timeout_count)}
          rangeLabel="范围均值"
          rangeValue={loading ? '--' : formatDecimal(timeoutRangeAverage, 1)}
          extraMetrics={[
            {
              label: '首封邮件',
              value: loading ? '--' : formatInteger(rangeSummary?.first_email_count),
            },
            {
              label: '还没回复',
              value: loading ? '--' : formatInteger(rangeSummary?.unreplied_email_count),
            },
          ]}
          description="客户首封邮件到人工首回时间差大于 24 小时的次数，并补充范围内未回复规模。"
          badge={{ label: '>24h', tone: 'deep' }}
          tone="complaints"
        />
      </section>

      <div className="metric-window-note">
        主数值为截至 {filters.date_to} 的{metricWindowLabel}；范围总量和范围均值按当前日期范围计算。
      </div>

      <section className="p1-main-grid">
        <section className="table-card p1-trend-card">
          <div className="table-card__header">
            <div>
              <h3>总览趋势</h3>
              <p className="table-card__hint">展示来邮数和回邮数。</p>
            </div>
            <div className="p1-trend-legend" aria-label="趋势图例">
              <span className="p1-legend-item p1-legend-item--inbound">来邮数</span>
              <span className="p1-legend-item p1-legend-item--outbound">回邮数</span>
            </div>
          </div>
          {loading ? (
            <div className="empty-state">正在加载趋势数据...</div>
          ) : (
            <MultiLineTrendChart series={trendSeries} ariaLabel="来邮回邮趋势" />
          )}
        </section>

        <section className="table-card p1-trend-card">
          <div className="table-card__header">
            <div>
              <h3>首次响应超时趋势</h3>
              <p className="table-card__hint">单独展示客户首封到人工首回超过 24 小时的次数。</p>
            </div>
            <div className="p1-trend-legend" aria-label="超时趋势图例">
              <span className="p1-legend-item p1-legend-item--timeout">超时次数</span>
            </div>
          </div>
          {loading ? (
            <div className="empty-state">正在加载超时趋势...</div>
          ) : (
            <MultiLineTrendChart series={timeoutTrendSeries} ariaLabel="首次响应超时趋势" />
          )}
        </section>

        <TableSection
          title="坐席工作量分析"
          hint="质检结果回邮数展示顺序：优秀 / 达标 / 不合格"
          columns={workloadColumns}
          rows={loading ? [] : agentRows}
          emptyCopy={loading ? '正在加载坐席数据...' : '暂无坐席工作量数据'}
        >
          {loading ? (
            <div className="empty-state p1-workload-chart">正在加载坐席均值趋势...</div>
          ) : (
            <WorkloadAverageChart rows={agentRows} />
          )}
        </TableSection>
      </section>
    </main>
  )
}
