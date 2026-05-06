import type { FocusAggregationResult, FocusSelection } from '../utils/focusAggregation'

interface FocusSummaryBlockProps {
  metricLabel: string
  selection: FocusSelection
  summary: FocusAggregationResult
  onReset?: () => void
}

export function FocusSummaryBlock({ metricLabel, selection, summary, onReset }: FocusSummaryBlockProps) {
  const canReset = selection.type !== 'all'
  return (
    <section className="focus-summary-block" aria-label="区块 A：焦点范围统计">
      <div className="focus-summary-block__header">
        <div>
          <span className="focus-summary-block__eyebrow">区块 A · {metricLabel}</span>
          <h3>{summary.label}</h3>
        </div>
        {canReset ? (
          <button type="button" className="focus-summary-block__reset" onClick={onReset}>
            reset 完整范围
          </button>
        ) : null}
      </div>
      <dl className="focus-summary-block__grid">
        <div className="focus-summary-block__item">
          <dt>总值</dt>
          <dd>{summary.total}</dd>
        </div>
        <div className="focus-summary-block__item">
          <dt>均值</dt>
          <dd>{summary.average}</dd>
        </div>
        <div className="focus-summary-block__item">
          <dt>峰值</dt>
          <dd>{summary.peak}</dd>
        </div>
        <div className="focus-summary-block__item">
          <dt>谷值</dt>
          <dd>{summary.valley}</dd>
        </div>
      </dl>
    </section>
  )
}
