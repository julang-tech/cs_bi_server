import { useMemo, useState, type CSSProperties } from 'react'
import { computeChartGeometry } from '../../shared/utils/computeChartGeometry'
import { Table } from '../../shared/components/Table'
import { formatDecimal, formatInteger } from '../../shared/utils/format'
import type { P1AgentRow, P1AgentTrendRow } from '../../api/types'

type MetricKey =
  | 'avg_outbound_emails_per_hour_by_span'
  | 'avg_outbound_emails_per_hour_by_schedule'

const METRIC_OPTIONS: Array<{ key: string; label: string; value: MetricKey }> = [
  { key: 'span', label: '首末封均值', value: 'avg_outbound_emails_per_hour_by_span' },
  { key: 'schedule', label: '工时表均值', value: 'avg_outbound_emails_per_hour_by_schedule' },
]

const PALETTE = ['#52728d', '#b65c68', '#3c8f89', '#b17220', '#7c6597', '#8a6f5a']

interface WorkloadAnalysisProps {
  workloadRows: P1AgentRow[]
  trendRows: P1AgentTrendRow[]
  loading: boolean
}

interface TooltipState {
  bucket: string
  index: number
  x: number
  y: number
}

export function WorkloadAnalysis({ workloadRows, trendRows, loading }: WorkloadAnalysisProps) {
  const [metricKey, setMetricKey] = useState<MetricKey>('avg_outbound_emails_per_hour_by_span')
  const [hiddenAgents, setHiddenAgents] = useState<Set<string>>(new Set())
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  function toggleAgent(name: string) {
    setHiddenAgents((cur) => {
      const next = new Set(cur)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const visibleRows = trendRows.filter((r) => !hiddenAgents.has(r.agent_name))
  const allValues = visibleRows.flatMap((r) => r.items.map((i) => i[metricKey] ?? 0))
  const yMin = Math.min(...allValues, 0)
  const yMax = Math.max(...allValues, 0)
  const longestRow = useMemo(
    () => trendRows.length
      ? trendRows.reduce((cur, r) => (r.items.length > cur.items.length ? r : cur), trendRows[0])
      : null,
    [trendRows],
  )

  const projections = useMemo(() => {
    return trendRows.map((row) => ({
      agent_name: row.agent_name,
      items: row.items,
      geometry: computeChartGeometry({
        items: row.items.map((i) => ({ value: i[metricKey] ?? 0 })),
        yMinOverride: yMin,
        yMaxOverride: yMax,
      }),
    }))
  }, [trendRows, metricKey, yMin, yMax])

  const longestProjection = useMemo(
    () => projections.find((p) => p.agent_name === longestRow?.agent_name) ?? projections[0],
    [projections, longestRow],
  )

  const workloadColumns = [
    {
      key: 'agent_name',
      label: '客服姓名',
      render: (row: P1AgentRow) => <strong>{row.agent_name}</strong>,
    },
    {
      key: 'outbound_email_count',
      label: '总回邮数',
      render: (row: P1AgentRow) => formatInteger(row.outbound_email_count),
    },
    {
      key: 'avg_outbound_emails_per_hour_by_span',
      label: '每小时回邮数均值（首末封）',
      render: (row: P1AgentRow) => formatDecimal(row.avg_outbound_emails_per_hour_by_span),
    },
    {
      key: 'avg_outbound_emails_per_hour_by_schedule',
      label: '每小时回邮数均值（工时表）',
      render: (row: P1AgentRow) => formatDecimal(row.avg_outbound_emails_per_hour_by_schedule),
    },
    {
      key: 'qa_reply_counts',
      label: '质检结果回邮数',
      render: (row: P1AgentRow) => {
        const qa = row.qa_reply_counts ?? { excellent: 0, pass: 0, fail: 0 }
        return `${formatInteger(qa.excellent)} / ${formatInteger(qa.pass)} / ${formatInteger(qa.fail)}`
      },
    },
  ]

  return (
    <Table<P1AgentRow>
      title="坐席工作量分析"
      hint="质检结果回邮数展示顺序：优秀 / 达标 / 不合格"
      columns={workloadColumns}
      rows={loading ? [] : workloadRows}
      emptyCopy={loading ? '正在加载坐席数据...' : '暂无坐席工作量数据'}
    >
      {loading ? (
        <div className="empty-state p1-workload-chart">正在加载坐席均值趋势...</div>
      ) : trendRows.length === 0 ? (
        <div className="empty-state p1-workload-chart">暂无坐席均值数据</div>
      ) : (
        <div className="p1-workload-chart" onMouseLeave={() => setTooltip(null)}>
          <div className="p1-workload-controls">
            <div
              className="segmented-control p1-workload-metric-toggle"
              role="tablist"
              aria-label="坐席均值指标切换"
            >
              {METRIC_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  className={`segment-button ${metricKey === opt.value ? 'segment-button--active' : ''}`}
                  onClick={() => setMetricKey(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="p1-agent-toggle-list" aria-label="坐席折线筛选">
              {trendRows.map((row, index) => {
                const color = PALETTE[index % PALETTE.length]
                const checked = !hiddenAgents.has(row.agent_name)
                return (
                  <label
                    key={row.agent_name}
                    className="p1-agent-toggle"
                    style={{ '--agent-color': color } as CSSProperties}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAgent(row.agent_name)}
                    />
                    <span>{row.agent_name}</span>
                  </label>
                )
              })}
            </div>
          </div>
          <div className="p1-workload-trend">
            {visibleRows.length && longestProjection ? (
              <>
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label="坐席工作量趋势"
                >
                  <g className="p1-trend-gridlines" aria-hidden="true">
                    {[25, 50, 75].map((line) => (
                      <line key={line} x1="8" x2="96" y1={line} y2={line} />
                    ))}
                  </g>
                  {tooltip ? (
                    <line
                      className="trend-chart__reference-line"
                      x1={tooltip.x}
                      x2={tooltip.x}
                      y1="10"
                      y2="86"
                    />
                  ) : null}
                  {projections
                    .filter((p) => !hiddenAgents.has(p.agent_name))
                    .map((p) => {
                      const idx = trendRows.findIndex((r) => r.agent_name === p.agent_name)
                      const color = PALETTE[idx % PALETTE.length]
                      return (
                        <polyline
                          key={p.agent_name}
                          className="p1-workload-trend__line"
                          fill="none"
                          points={p.geometry.pointsString}
                          style={{ stroke: color }}
                        />
                      )
                    })}
                  {longestProjection.geometry.points.map((pt, index) => {
                    const bucket = longestProjection.items[index]?.bucket
                    return (
                      <g
                        key={bucket}
                        className="trend-chart__hit-area"
                        onMouseEnter={() => setTooltip({ bucket, index, x: pt.x, y: pt.y })}
                        onFocus={() => setTooltip({ bucket, index, x: pt.x, y: pt.y })}
                        tabIndex={0}
                      >
                        <circle className="trend-chart__hit-circle" cx={pt.x} cy={pt.y} r="7" />
                      </g>
                    )
                  })}
                </svg>
                <span className="trend-chart__axis-label trend-chart__axis-label--top">
                  {formatDecimal(yMax)}
                </span>
                <span className="trend-chart__axis-label trend-chart__axis-label--bottom">
                  {formatDecimal(yMin)}
                </span>
                <div className="trend-chart__bucket-labels" aria-hidden="true">
                  <span>{longestProjection.items[0]?.bucket}</span>
                  <span>{longestProjection.items[longestProjection.items.length - 1]?.bucket}</span>
                </div>
                {tooltip ? (
                  <div
                    className={`trend-tooltip ${tooltip.x > 82 ? 'trend-tooltip--left' : ''}`}
                    style={{ left: `${tooltip.x}%`, top: `${tooltip.y}%` }}
                  >
                    <span>{tooltip.bucket}</span>
                    {visibleRows.map((row) => (
                      <strong key={row.agent_name}>
                        {row.agent_name}：{formatDecimal(row.items[tooltip.index]?.[metricKey])}
                      </strong>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="empty-state">请选择至少一个客服</div>
            )}
          </div>
        </div>
      )}
    </Table>
  )
}
