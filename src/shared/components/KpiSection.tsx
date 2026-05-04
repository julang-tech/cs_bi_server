import type { ReactNode } from 'react'

interface KpiSectionProps {
  title: string
  subtitle?: string
  variant: 'current' | 'history'
  className?: string
  // Optional right-aligned action area (e.g. "重置" button when viewing a
  // historical bucket selected from the trend chart).
  action?: ReactNode
  children: ReactNode
}

export function KpiSection({ title, subtitle, variant, className, action, children }: KpiSectionProps) {
  return (
    <section className={[
      'kpi-section',
      `kpi-section--${variant}`,
      className ?? '',
    ].filter(Boolean).join(' ')}
    >
      <header className="kpi-section__header">
        <h2 className="kpi-section__title">{title}</h2>
        {action ? <span className="kpi-section__action">{action}</span> : null}
        {subtitle ? <span className="kpi-section__subtitle">{subtitle}</span> : null}
      </header>
      <div className="kpi-section__grid">
        {children}
      </div>
    </section>
  )
}
