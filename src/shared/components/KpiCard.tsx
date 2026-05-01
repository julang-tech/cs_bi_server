import { useId, type KeyboardEvent } from 'react'
import { MiniSparkline } from './MiniSparkline'
import type { TrendPoint } from '../../api/types'

interface DeltaInfo {
  tone: 'up' | 'down' | 'neutral' | 'muted'
  text: string
}

interface KpiCardBaseProps {
  metricKey?: string
  active?: boolean
  onSelect?: (metricKey: string) => void
  label: string
  description?: string
  sparkline?: TrendPoint[]
  sparklineTone?: 'sales' | 'complaints' | 'rate' | 'neutral'
}

export interface KpiCardCurrentProps extends KpiCardBaseProps {
  variant: 'current'
  value: string
  delta?: DeltaInfo
  periodAverage: string
}

export interface KpiCardHistoryProps extends KpiCardBaseProps {
  variant: 'history'
  total: string
  periodAverage: string
  rateMode?: { mean: string; peak: string }
}

export type KpiCardProps = KpiCardCurrentProps | KpiCardHistoryProps

export function KpiCard(props: KpiCardProps) {
  const descriptionId = useId()
  const isSelectable = Boolean(props.metricKey && props.onSelect)
  const className = [
    'kpi-card',
    `kpi-card--${props.variant}`,
    props.active ? 'kpi-card--active' : '',
    isSelectable ? 'kpi-card--selectable' : '',
  ].filter(Boolean).join(' ')

  function selectMetric() {
    if (!props.metricKey) return
    props.onSelect?.(props.metricKey)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!isSelectable) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    selectMetric()
  }

  return (
    <article
      className={className}
      role={isSelectable ? 'button' : undefined}
      tabIndex={isSelectable ? 0 : undefined}
      aria-pressed={isSelectable ? props.active : undefined}
      onClick={isSelectable ? selectMetric : undefined}
      onKeyDown={handleKeyDown}
    >
      <div className="kpi-card__header">
        <h3 className="kpi-card__label" aria-describedby={props.description ? descriptionId : undefined}>
          {props.label}
          {props.description ? (
            <>
              <span className="kpi-card__info" aria-hidden="true">?</span>
              <span id={descriptionId} role="tooltip" className="kpi-card__tooltip">
                {props.description}
              </span>
            </>
          ) : null}
        </h3>
        {props.variant === 'current' && props.delta ? (
          <span className={`kpi-card__delta kpi-card__delta--${props.delta.tone}`}>
            {props.delta.text}
          </span>
        ) : null}
      </div>

      {props.variant === 'current' ? (
        <>
          <div className="kpi-card__value">{props.value}</div>
          <div className="kpi-card__secondary">
            <span>周期日均</span>
            <strong>{props.periodAverage}</strong>
          </div>
          <MiniSparkline items={props.sparkline ?? []} tone={props.sparklineTone} />
        </>
      ) : props.rateMode ? (
        <>
          <div className="kpi-card__value">{props.rateMode.mean}</div>
          <div className="kpi-card__secondary">
            <span>区间均值 / 峰值</span>
            <strong>{props.rateMode.mean} / {props.rateMode.peak}</strong>
          </div>
          <MiniSparkline items={props.sparkline ?? []} tone={props.sparklineTone} />
        </>
      ) : (
        <>
          <div className="kpi-card__value">{props.total}</div>
          <div className="kpi-card__secondary">
            <span>周期均值</span>
            <strong>{props.periodAverage}</strong>
          </div>
          <MiniSparkline items={props.sparkline ?? []} tone={props.sparklineTone} />
        </>
      )}
    </article>
  )
}
