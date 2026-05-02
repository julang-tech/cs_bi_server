import { Table } from '../../shared/components/Table'
import { formatDecimal, formatHours, formatInteger } from '../../shared/utils/format'
import type { P1AgentRow } from '../../api/types'

type WorkloadTableRow = P1AgentRow & {
  isAverage?: boolean
  reply_span_hours?: number | null
}

interface WorkloadAnalysisProps {
  workloadRows: P1AgentRow[]
  loading: boolean
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function averageNullable(values: Array<number | null | undefined>): number | null {
  const validValues = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return validValues.length ? average(validValues) : null
}

export function getReplySpanHours(row: Pick<
  P1AgentRow,
  'outbound_email_count' | 'avg_outbound_emails_per_hour_by_span' | 'reply_span_hours'
>): number | null {
  if (typeof row.reply_span_hours === 'number' && Number.isFinite(row.reply_span_hours)) {
    return row.reply_span_hours
  }
  if (!row.avg_outbound_emails_per_hour_by_span) {
    return null
  }
  return row.outbound_email_count / row.avg_outbound_emails_per_hour_by_span
}

export function buildWorkloadTableRows(rows: P1AgentRow[]): WorkloadTableRow[] {
  if (!rows.length) return []

  const normalizedRows = rows.map((row) => ({
    ...row,
    reply_span_hours: getReplySpanHours(row),
  }))
  const averageRow: WorkloadTableRow = {
    agent_name: '坐席均值',
    isAverage: true,
    outbound_email_count: average(normalizedRows.map((row) => row.outbound_email_count)),
    reply_span_hours: averageNullable(normalizedRows.map((row) => row.reply_span_hours)),
    avg_outbound_emails_per_hour_by_span: average(
      normalizedRows.map((row) => row.avg_outbound_emails_per_hour_by_span),
    ),
    avg_outbound_emails_per_hour_by_schedule: average(
      normalizedRows.map((row) => row.avg_outbound_emails_per_hour_by_schedule),
    ),
    qa_reply_counts: {
      excellent: average(normalizedRows.map((row) => row.qa_reply_counts?.excellent ?? 0)),
      pass: average(normalizedRows.map((row) => row.qa_reply_counts?.pass ?? 0)),
      fail: average(normalizedRows.map((row) => row.qa_reply_counts?.fail ?? 0)),
    },
  }

  return [averageRow, ...normalizedRows]
}

function formatCount(row: WorkloadTableRow, value: number): string {
  return row.isAverage ? formatDecimal(value) : formatInteger(value)
}

function formatNullableHours(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatHours(value, 1) : '-'
}

export function WorkloadAnalysis({ workloadRows, loading }: WorkloadAnalysisProps) {
  const workloadColumns = [
    {
      key: 'agent_name',
      label: '客服姓名',
      render: (row: WorkloadTableRow) => (
        <strong className={row.isAverage ? 'workload-average-label' : ''}>{row.agent_name}</strong>
      ),
    },
    {
      key: 'outbound_email_count',
      label: '总回邮数',
      render: (row: WorkloadTableRow) => formatCount(row, row.outbound_email_count),
    },
    {
      key: 'reply_span_hours',
      label: '回信时长',
      render: (row: WorkloadTableRow) => formatNullableHours(row.reply_span_hours),
    },
    {
      key: 'avg_outbound_emails_per_hour_by_schedule',
      label: '每小时回邮数均值（工时表）',
      render: (row: WorkloadTableRow) => formatDecimal(row.avg_outbound_emails_per_hour_by_schedule),
    },
    {
      key: 'qa_reply_counts',
      label: '质检结果回邮数',
      render: (row: WorkloadTableRow) => {
        const qa = row.qa_reply_counts ?? { excellent: 0, pass: 0, fail: 0 }
        return row.isAverage
          ? `${formatDecimal(qa.excellent)} / ${formatDecimal(qa.pass)} / ${formatDecimal(qa.fail)}`
          : `${formatInteger(qa.excellent)} / ${formatInteger(qa.pass)} / ${formatInteger(qa.fail)}`
      },
    },
  ]

  return (
    <Table<WorkloadTableRow>
      title="坐席工作量"
      hint="坐席均值为下方坐席的算术平均；质检结果回邮数展示顺序：优秀 / 达标 / 不合格"
      columns={workloadColumns}
      rows={loading ? [] : buildWorkloadTableRows(workloadRows)}
      emptyCopy={loading ? '正在加载坐席数据...' : '暂无坐席工作量数据'}
    />
  )
}
