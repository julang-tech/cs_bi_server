import type { ReactNode } from 'react'

interface DashboardShellProps {
  filterBar: ReactNode
  currentPeriodSection: ReactNode
  focusChart: ReactNode
  focusSummaryBlock?: ReactNode
  extensions?: ReactNode
  banner?: ReactNode
}

export function DashboardShell({
  filterBar, currentPeriodSection, focusChart,
  focusSummaryBlock, extensions, banner,
}: DashboardShellProps) {
  return (
    <main className="dashboard-shell">
      <div className="dashboard-shell__sticky-filter">
        {filterBar}
      </div>
      {banner}
      {currentPeriodSection}
      {focusSummaryBlock}
      {focusChart}
      {extensions}
    </main>
  )
}
