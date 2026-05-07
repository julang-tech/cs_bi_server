import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface TableColumn<T> {
  key: string
  label: string
  tooltip?: string
  render?: (row: T, index: number) => ReactNode
}

interface TableProps<T> {
  title?: string
  hint?: string
  columns: TableColumn<T>[]
  rows: T[]
  emptyCopy: string
  loading?: boolean
  error?: string
  onRowClick?: (row: T) => void
  rowTone?: (row: T) => string
  children?: ReactNode
  headerActions?: ReactNode
}

export function Table<T>({
  title, hint, columns, rows, emptyCopy, loading, error,
  onRowClick, rowTone, children, headerActions,
}: TableProps<T>) {
  const [activeTooltip, setActiveTooltip] = useState<{ text: string; x: number; y: number } | null>(null)

  function renderHeaderLabel(label: string, tooltip?: string) {
    if (!tooltip) return label
    const tip = tooltip
    function showTooltip(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return
      const rect = target.getBoundingClientRect()
      const width = Math.min(300, Math.max(220, tip.length * 7))
      const margin = 12
      const x = Math.max(margin + width / 2, Math.min(window.innerWidth - margin - width / 2, rect.left + rect.width / 2))
      const y = rect.bottom + 8
      setActiveTooltip({ text: tip, x, y })
    }
    return (
      <span
        className="table-header-tooltip-wrap"
        onMouseEnter={(event) => showTooltip(event.currentTarget)}
        onMouseLeave={() => setActiveTooltip(null)}
        onFocus={(event) => showTooltip(event.currentTarget)}
        onBlur={() => setActiveTooltip(null)}
      >
        <span>{label}</span>
        <span className="table-header-tooltip-icon" aria-hidden>i</span>
      </span>
    )
  }
  return (
    <section className="data-table-card">
      {(title || hint) ? (
        <header className="data-table-card__header">
          {title ? <h3>{title}</h3> : null}
          {hint ? <p className="data-table-card__hint">{hint}</p> : null}
          {headerActions ? <div className="data-table-card__actions">{headerActions}</div> : null}
        </header>
      ) : null}
      {children ? <div className="data-table-card__content">{children}</div> : null}
      {loading ? (
        <div className="empty-state">正在加载...</div>
      ) : error ? (
        <div className="empty-state empty-state--error">{error}</div>
      ) : rows.length ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>{columns.map((c) => <th key={c.key}>{renderHeaderLabel(c.label, c.tooltip)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const cells = columns.map((c) => (
                  <td key={c.key} data-label={c.label}>
                    {c.render ? c.render(row, index) : (row as Record<string, unknown>)[c.key] as ReactNode}
                  </td>
                ))
                if (onRowClick) {
                  return (
                    <tr key={index}
                      className={`is-clickable ${rowTone ? rowTone(row) : ''}`}
                      onClick={() => onRowClick(row)}>
                      {cells}
                    </tr>
                  )
                }
                return <tr key={index}>{cells}</tr>
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state empty-state--table">{emptyCopy}</div>
      )}
      {activeTooltip
        ? createPortal(
            <span
              className="table-header-tooltip table-header-tooltip--portal"
              role="tooltip"
              style={{ left: `${activeTooltip.x}px`, top: `${activeTooltip.y}px` }}
            >
              {activeTooltip.text}
            </span>,
            document.body,
          )
        : null}
    </section>
  )
}
