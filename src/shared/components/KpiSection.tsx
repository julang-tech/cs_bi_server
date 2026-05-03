import type { ReactNode } from 'react'

interface KpiSectionProps {
  title: string
  subtitle?: string
  variant: 'current' | 'history'
  className?: string
  children: ReactNode
}

export function KpiSection({ title, subtitle, variant, className, children }: KpiSectionProps) {
  return (
    <section className={[
      'kpi-section',
      `kpi-section--${variant}`,
      className ?? '',
    ].filter(Boolean).join(' ')}
    >
      <header className="kpi-section__header">
        <h2 className="kpi-section__title">{title}</h2>
        {subtitle ? <span className="kpi-section__subtitle">{subtitle}</span> : null}
      </header>
      <div className="kpi-section__grid">
        {children}
      </div>
    </section>
  )
}
