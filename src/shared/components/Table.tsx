import type { ReactNode } from 'react'

export interface TableColumn<T> {
  key: string
  label: string
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
}

export function Table<T>({
  title, hint, columns, rows, emptyCopy, loading, error,
  onRowClick, rowTone, children,
}: TableProps<T>) {
  return (
    <section className="data-table-card">
      {(title || hint) ? (
        <header className="data-table-card__header">
          {title ? <h3>{title}</h3> : null}
          {hint ? <p className="data-table-card__hint">{hint}</p> : null}
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
              <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
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
    </section>
  )
}
