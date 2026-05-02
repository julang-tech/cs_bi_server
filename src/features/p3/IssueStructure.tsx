import { useMemo } from 'react'
import { Table } from '../../shared/components/Table'
import { formatPercent } from '../../shared/utils/format'
import type { P3Dashboard, P3IssueShareItem } from '../../api/types'

const ISSUE_ORDER = ['product', 'logistics', 'warehouse'] as const
type DisplayIssueType = (typeof ISSUE_ORDER)[number]

const ISSUE_LABELS: Record<DisplayIssueType, { label: string; accent: string }> = {
  product: { label: '产品问题', accent: 'issue-row--product' },
  logistics: { label: '物流问题', accent: 'issue-row--logistics' },
  warehouse: { label: '仓库问题', accent: 'issue-row--warehouse' },
}

interface IssueRow {
  major_issue_type: DisplayIssueType
  label: string
  count: number
  ratio: number
  estimatedRate: number
}

interface IssueStructureProps {
  dashboard: P3Dashboard | null
  options: P3IssueShareItem[]
}

export function IssueStructure({ dashboard, options }: IssueStructureProps) {
  const rows = useMemo<IssueRow[]>(() => {
    const optionsByType = new Map(options.map((o) => [o.major_issue_type, o]))
    const itemsByType = new Map((dashboard?.issue_share ?? []).map((o) => [o.major_issue_type, o]))
    const salesQty = dashboard?.summary.sales_qty ?? 0
    return ISSUE_ORDER.map((type) => {
      const item = itemsByType.get(type)
      const opt = optionsByType.get(type)
      const count = item?.count ?? opt?.count ?? 0
      return {
        major_issue_type: type,
        label: item?.label ?? opt?.label ?? ISSUE_LABELS[type].label,
        count,
        ratio: item?.ratio ?? opt?.ratio ?? 0,
        estimatedRate: salesQty ? count / salesQty : 0,
      }
    })
  }, [dashboard, options])

  return (
    <Table<IssueRow>
      title="问题结构分析"
      hint="客诉率为按订单数估算的分类客诉率"
      columns={[
        {
          key: 'label',
          label: '客诉原因',
          render: (row) => (
            <span className={`issue-label ${ISSUE_LABELS[row.major_issue_type].accent}`}>{row.label}</span>
          ),
        },
        { key: 'estimatedRate', label: '客诉率', render: (row) => formatPercent(row.estimatedRate, 2) },
        { key: 'ratio', label: '客诉占比', render: (row) => formatPercent(row.ratio, 1) },
      ]}
      rows={rows}
      emptyCopy="暂无问题结构数据"
    />
  )
}
