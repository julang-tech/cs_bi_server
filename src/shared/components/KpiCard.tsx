import { useId, type KeyboardEvent } from 'react'
import { MiniSparkline } from './MiniSparkline'
import type { TrendPoint } from '../../api/types'

interface DeltaInfo {
  tone: 'up' | 'down' | 'neutral' | 'muted'
  text: string
}

export type MetricTone = 'sales' | 'complaints' | 'rate' | 'refund' | 'neutral'

interface KpiCardBaseProps {
  metricKey?: string
  active?: boolean
  onSelect?: (metricKey: string) => void
  label: string
  description?: string
  sparkline?: TrendPoint[]
  sparklineTone?: MetricTone
  tone?: MetricTone
}

export interface KpiCardCurrentProps extends KpiCardBaseProps {
  variant: 'current'
  value: string
  delta?: DeltaInfo
  secondaryLabel: string
  secondaryValue: string
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
    props.tone && props.tone !== 'neutral' ? `kpi-card--tone-${props.tone}` : '',
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
      {props.variant === 'current' ? (
        <>
          <div className="kpi-card__content">
            <div className="kpi-card__top">
              <div className="kpi-card__main">
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
                <div className="kpi-card__value">{props.value}</div>
                <div className="kpi-card__secondary kpi-card__secondary--current">
                  <span>{props.secondaryLabel}</span>
                  <strong>{props.secondaryValue}</strong>
                </div>
              </div>
              <div className="kpi-card__side">
                {props.delta ? (
                  <span className={`kpi-card__delta kpi-card__delta--${props.delta.tone}`}>
                    {props.delta.text}
                  </span>
                ) : null}
              </div>
            </div>
            <MiniSparkline items={props.sparkline ?? []} tone={props.sparklineTone} />
          </div>
        </>
      ) : props.rateMode ? (
        <>
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
          </div>
          <div className="kpi-card__value">{props.rateMode.mean}</div>
          <div className="kpi-card__secondary">
            <span>区间均值 / 峰值</span>
            <strong>{props.rateMode.mean} / {props.rateMode.peak}</strong>
          </div>
          <MiniSparkline items={props.sparkline ?? []} tone={props.sparklineTone} />
        </>
      ) : (
        <>
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
          </div>
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
