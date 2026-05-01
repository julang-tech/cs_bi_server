import type { ReactNode } from 'react'

interface DashboardShellProps {
  filterBar: ReactNode
  currentPeriodSection: ReactNode
  focusChart: ReactNode
  historySection: ReactNode
  extensions?: ReactNode
  banner?: ReactNode
}

export function DashboardShell({
  filterBar, currentPeriodSection, focusChart, historySection,
  extensions, banner,
}: DashboardShellProps) {
  return (
    <main className="dashboard-shell">
      {filterBar}
      {banner}
      {currentPeriodSection}
      {focusChart}
      {historySection}
      {extensions}
    </main>
  )
}
