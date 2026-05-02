import { useMemo, useState } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { TooltipProps } from 'recharts'
import type { TrendPoint } from '../../api/types'

export interface FocusMetricSpec {
  key: string
  label: string
  formatter: (n: number) => string
  history: TrendPoint[]
  current: TrendPoint[]
}

export interface FocusMetricSummary {
  // Pre-formatted aggregate items, e.g.:
  //   absolute: [{label: "近 14 天累计", value: "9,170"}, {label: "区间均值", value: "655"}]
  //   rate:     [{label: "区间均值", value: "7.5%"}, {label: "区间峰值", value: "15.8%"}]
  items: Array<{ label: string; value: string }>
  delta?: {
    tone: 'up' | 'down' | 'neutral' | 'muted'
    text: string                   // e.g. "↑ 12.3%" or "-"
    label?: string                 // e.g. "vs 上 14 天" (default "vs 上一区间")
  }
}

interface FocusLineChartProps {
  metrics: FocusMetricSpec[]
  defaultKey?: string
  activeKey?: string
  onActiveKeyChange?: (next: string) => void
  ariaLabel?: string
  // Optional summary line shown between the tabs and the plot. Map keyed by
  // metric.key so the summary updates when the active tab changes.
  summaryByKey?: Record<string, FocusMetricSummary | undefined>
}

interface ChartRow {
  bucket: string
  value: number | null         // solid history line
  valueDashed: number | null   // dashed in-progress segment (anchored at last history point)
  peakValue: number | null     // single visible peak marker
  raw: number                  // always populated, used for the area fill + tooltip
  isCurrent: boolean
}

/**
 * Build one merged data series. A single point bridges the history -> current
 * boundary so the dashed in-progress line connects visually to the solid line.
 */
function buildSeries(history: TrendPoint[], current: TrendPoint[]): ChartRow[] {
  const rows: ChartRow[] = []
  history.forEach((p, i) => {
    const isLastHistory = i === history.length - 1 && current.length > 0
    rows.push({
      bucket: p.bucket,
      value: p.value,
      // Anchor the dashed segment at the last history point so the two lines connect.
      valueDashed: isLastHistory ? p.value : null,
      peakValue: null,
      raw: p.value,
      isCurrent: false,
    })
  })
  current.forEach((p) => {
    rows.push({
      bucket: p.bucket,
      value: null,
      valueDashed: p.value,
      peakValue: null,
      raw: p.value,
      isCurrent: true,
    })
  })
  const peak = rows.reduce<{ index: number; value: number } | null>((max, row, index) => {
    if (!max || row.raw > max.value) return { index, value: row.raw }
    return max
  }, null)
  if (peak) {
    rows[peak.index].peakValue = peak.value
  }
  return rows
}

interface CustomTooltipPayload {
  bucket: string
  raw: number
  isCurrent: boolean
}

function CustomTooltip({
  active,
  payload,
  label,
  formatter,
  metricLabel,
}: TooltipProps<number, string> & {
  formatter: (n: number) => string
  metricLabel: string
}) {
  if (!active || !payload?.length) return null
  // payload[0].payload contains the original row.
  const row = payload[0].payload as CustomTooltipPayload
  return (
    <div className="focus-chart__tooltip">
      <span className="focus-chart__tooltip-label">
        {row.bucket || label}
        {row.isCurrent ? ' · 进行中' : ''}
      </span>
      <strong className="focus-chart__tooltip-value">
        {metricLabel}: {formatter(row.raw)}
      </strong>
    </div>
  )
}

export function FocusLineChart({
  metrics,
  defaultKey,
  activeKey,
  onActiveKeyChange,
  ariaLabel,
  summaryByKey,
}: FocusLineChartProps) {
  const [internalActiveKey, setInternalActiveKey] = useState<string>(defaultKey ?? metrics[0]?.key ?? '')
  const selectedKey = activeKey ?? internalActiveKey

  const active = useMemo(
    () => metrics.find((m) => m.key === selectedKey) ?? metrics[0],
    [metrics, selectedKey],
  )

  const summary = active ? summaryByKey?.[active.key] : undefined

  const data = useMemo(() => (active ? buildSeries(active.history, active.current) : []), [active])

  const historyMean = useMemo(() => {
    if (!active || active.history.length === 0) return null
    const sum = active.history.reduce((acc, p) => acc + p.value, 0)
    return sum / active.history.length
  }, [active])

  if (!active) return <div className="empty-state">暂无指标</div>

  // Show only first / last X-axis tick labels.
  const firstBucket = data[0]?.bucket
  const lastBucket = data[data.length - 1]?.bucket
  const xTickFormatter = (v: string) => (v === firstBucket || v === lastBucket ? v : '')

  // Highlight the latest (rightmost) point with a larger filled dot. Recharts'
  // `dot` prop accepts a function so we can render conditionally per-point.
  // Recharts iterates the function over each datum and expects a key on every
  // returned element (the function receives a `key` prop for that purpose).
  const renderLatestDot = (props: {
    cx?: number; cy?: number; payload?: ChartRow; index?: number; key?: string
  }) => {
    const { cx, cy, payload, index, key } = props
    const k = key ?? `dot-${index ?? `${cx}-${cy}`}`
    if (cx == null || cy == null || !payload || payload.bucket !== lastBucket) {
      // Render a zero-radius placeholder so Recharts still gets a keyed element.
      return <circle key={k} cx={cx ?? 0} cy={cy ?? 0} r={0} fill="none" />
    }
    return (
      <circle
        key={k}
        cx={cx}
        cy={cy}
        r={4}
        fill="var(--accent)"
        stroke="var(--surface)"
        strokeWidth={1.5}
      />
    )
  }

  const renderPeakDot = (props: {
    cx?: number; cy?: number; value?: number; index?: number; key?: string
  }) => {
    const { cx, cy, value, index, key } = props
    const k = key ?? `peak-${index ?? `${cx}-${cy}`}`
    if (cx == null || cy == null || value == null) {
      return <circle key={k} cx={cx ?? 0} cy={cy ?? 0} r={0} fill="none" />
    }
    const labelToLeft = (index ?? 0) >= Math.max(data.length - 2, 0)
    return (
      <g key={k} className="focus-chart__peak-marker">
        <circle
          cx={cx}
          cy={cy}
          r={5}
          fill="var(--surface)"
          stroke="var(--accent)"
          strokeWidth={2}
        />
        <text
          x={cx + (labelToLeft ? -10 : 10)}
          y={cy - 10}
          textAnchor={labelToLeft ? 'end' : 'start'}
          className="focus-chart__peak-label"
        >
          {`峰值 ${active.formatter(value)}`}
        </text>
      </g>
    )
  }

  const gradientId = `focus-gradient-${active.key}`

  function selectMetric(next: string) {
    if (activeKey === undefined) {
      setInternalActiveKey(next)
    }
    onActiveKeyChange?.(next)
  }

  return (
    <section className="focus-chart" aria-label={ariaLabel ?? active.label}>
      <div className="focus-chart__tabs" role="tablist">
        {metrics.map((m) => (
          <button
            key={m.key}
            type="button"
            role="tab"
            aria-selected={m.key === active.key}
            className={`focus-chart__tab ${m.key === active.key ? 'focus-chart__tab--active' : ''}`}
            onClick={() => selectMetric(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {summary ? (
        <div className="focus-chart__summary">
          {summary.items.map((item, idx) => (
            <span key={item.label} className="focus-chart__summary-item">
              {idx > 0 ? <span className="focus-chart__summary-divider" aria-hidden="true">·</span> : null}
              <small>{item.label}</small>
              <strong>{item.value}</strong>
            </span>
          ))}
          {summary.delta ? (
            <span className="focus-chart__summary-item">
              <span className="focus-chart__summary-divider" aria-hidden="true">·</span>
              <small>{summary.delta.label ?? 'vs 上一区间'}</small>
              <strong className={`focus-chart__summary-delta focus-chart__summary-delta--${summary.delta.tone}`}>
                {summary.delta.text}
              </strong>
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="focus-chart__plot">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 24, right: 56, left: 0, bottom: 4 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={false}
              stroke="var(--border)"
              strokeDasharray="3 3"
            />
            <XAxis
              dataKey="bucket"
              tick={{ fontSize: 11, fill: 'var(--muted)' }}
              tickFormatter={xTickFormatter}
              axisLine={false}
              tickLine={false}
              interval={0}
              minTickGap={0}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'var(--muted)' }}
              tickFormatter={active.formatter}
              axisLine={false}
              tickLine={false}
              width={60}
              tickCount={5}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
              content={
                <CustomTooltip formatter={active.formatter} metricLabel={active.label} />
              }
            />
            {historyMean !== null ? (
              <ReferenceLine
                y={historyMean}
                stroke="var(--muted-strong)"
                strokeDasharray="5 4"
                strokeOpacity={0.9}
                strokeWidth={1.5}
                label={{
                  value: `均值 ${active.formatter(historyMean)}`,
                  position: 'insideTopRight',
                  fill: 'var(--muted-strong)',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              />
            ) : null}
            {/* Area fill for the entire (history + current) trend. Uses `raw`
                so it draws across the boundary without a gap. */}
            <Area
              type="monotone"
              dataKey="raw"
              stroke="none"
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
              activeDot={false}
            />
            {/* Solid history line. */}
            <Line
              type="monotone"
              dataKey="value"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: 'var(--accent)', stroke: 'var(--surface)', strokeWidth: 1.5 }}
              isAnimationActive={false}
              connectNulls={false}
            />
            {/* Dashed in-progress segment (anchored at last history point). */}
            <Line
              type="monotone"
              dataKey="valueDashed"
              stroke="var(--accent)"
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={renderLatestDot}
              activeDot={{ r: 4, fill: 'var(--accent)', stroke: 'var(--surface)', strokeWidth: 1.5 }}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="peakValue"
              stroke="transparent"
              strokeWidth={0}
              dot={renderPeakDot}
              activeDot={false}
              isAnimationActive={false}
              connectNulls={false}
              legendType="none"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}
