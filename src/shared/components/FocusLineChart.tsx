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

interface FocusLineChartProps {
  metrics: FocusMetricSpec[]
  defaultKey?: string
  ariaLabel?: string
}

interface ChartRow {
  bucket: string
  value: number | null         // solid history line
  valueDashed: number | null   // dashed in-progress segment (anchored at last history point)
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
      raw: p.value,
      isCurrent: false,
    })
  })
  current.forEach((p) => {
    rows.push({
      bucket: p.bucket,
      value: null,
      valueDashed: p.value,
      raw: p.value,
      isCurrent: true,
    })
  })
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

export function FocusLineChart({ metrics, defaultKey, ariaLabel }: FocusLineChartProps) {
  const [activeKey, setActiveKey] = useState<string>(defaultKey ?? metrics[0]?.key ?? '')

  const active = useMemo(
    () => metrics.find((m) => m.key === activeKey) ?? metrics[0],
    [metrics, activeKey],
  )

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
  const renderLatestDot = (props: { cx?: number; cy?: number; payload?: ChartRow }) => {
    const { cx, cy, payload } = props
    if (cx == null || cy == null || !payload) return <g />
    if (payload.bucket !== lastBucket) return <g />
    return (
      <circle
        cx={cx}
        cy={cy}
        r={4}
        fill="var(--accent)"
        stroke="var(--surface)"
        strokeWidth={1.5}
      />
    )
  }

  const gradientId = `focus-gradient-${active.key}`

  return (
    <section className="focus-chart" aria-label={ariaLabel ?? active.label}>
      <div className="focus-chart__tabs" role="tablist">
        {metrics.map((m) => (
          <button
            key={m.key}
            type="button"
            role="tab"
            aria-selected={m.key === activeKey}
            className={`focus-chart__tab ${m.key === activeKey ? 'focus-chart__tab--active' : ''}`}
            onClick={() => setActiveKey(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="focus-chart__plot">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
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
                stroke="var(--muted)"
                strokeDasharray="3 3"
                strokeOpacity={0.55}
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
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}
