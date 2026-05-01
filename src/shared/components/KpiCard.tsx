import { useId } from 'react'
import { MiniSparkline } from './MiniSparkline'
import type { TrendPoint } from '../../api/types'

interface DeltaInfo {
  tone: 'up' | 'down' | 'neutral' | 'muted'
  text: string
}

export interface KpiCardCurrentProps {
  variant: 'current'
  label: string
  value: string
  delta?: DeltaInfo
  periodAverage: string
  description?: string
  sparkline?: TrendPoint[]
  sparklineTone?: 'sales' | 'complaints' | 'rate' | 'neutral'
}

export interface KpiCardHistoryProps {
  variant: 'history'
  label: string
  total: string
  periodAverage: string
  description?: string
  rateMode?: { mean: string; peak: string }
}

export type KpiCardProps = KpiCardCurrentProps | KpiCardHistoryProps

export function KpiCard(props: KpiCardProps) {
  const descriptionId = useId()
  const className = `kpi-card kpi-card--${props.variant}`

  return (
    <article className={className}>
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
          {props.sparkline?.length ? (
            <MiniSparkline items={props.sparkline} tone={props.sparklineTone} />
          ) : null}
        </>
      ) : props.rateMode ? (
        <>
          <div className="kpi-card__value">{props.rateMode.mean}</div>
          <div className="kpi-card__secondary">
            <span>区间均值 / 峰值</span>
            <strong>{props.rateMode.mean} / {props.rateMode.peak}</strong>
          </div>
        </>
      ) : (
        <>
          <div className="kpi-card__value">{props.total}</div>
          <div className="kpi-card__secondary">
            <span>周期均值</span>
            <strong>{props.periodAverage}</strong>
          </div>
        </>
      )}
    </article>
  )
}
