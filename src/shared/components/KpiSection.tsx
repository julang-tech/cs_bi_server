import type { ReactNode } from 'react'

interface KpiSectionProps {
  title: string
  subtitle?: string
  variant: 'current' | 'history'
  children: ReactNode
}

export function KpiSection({ title, subtitle, variant, children }: KpiSectionProps) {
  return (
    <section className={`kpi-section kpi-section--${variant}`}>
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
