import { Table } from '../../shared/components/Table'
import { formatDecimal, formatHours, formatInteger } from '../../shared/utils/format'
import { getMetricDescription } from '../../shared/metricDefinitions'
import { getPeriodLengthDays } from '../../shared/utils/datePeriod'
import type { P1AgentMailNameMapping, P1AgentRow, PeriodWindow } from '../../api/types'

// "标准在席时长"假设客服按 30 封/小时的标准节奏处理，反映"如果按标准
// 产出，这堆回邮量应该花多少小时处理完"。和"在席时长"（首封到末封实际
// 跨度）对照看，可以判断客服比标准节奏快还是慢。
const STANDARD_REPLY_RATE_PER_HOUR = 30
const UNRECOGNIZED_AGENT_NAME = '未识别'

type WorkloadTableRow = P1AgentRow & {
  isAverage?: boolean
  isTotal?: boolean
  attendance_hours?: number | null         // 在席时长（实际首末跨度，从 API）
  standard_attendance_hours?: number | null // 标准在席时长（总回邮数 ÷ 30）
}

interface WorkloadAnalysisProps {
  workloadRows: P1AgentRow[]
  loading: boolean
  historyRange: PeriodWindow
  mappings: P1AgentMailNameMapping[]
  onOpenMappingConfig: () => void
}

export type AgentFilterOption = {
  value: string
  label: string
}

function computeStandardAttendanceHours(outboundCount: number): number | null {
  if (!Number.isFinite(outboundCount) || outboundCount <= 0) return null
  return outboundCount / STANDARD_REPLY_RATE_PER_HOUR
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0)
}

function sumNullable(values: Array<number | null | undefined>): number | null {
  const validValues = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return validValues.length ? sum(validValues) : null
}

function average(values: number[]): number {
  return values.length ? sum(values) / values.length : 0
}

function averageNullable(values: Array<number | null | undefined>): number | null {
  const validValues = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return validValues.length ? average(validValues) : null
}

export function getAttendanceHours(row: Pick<
  P1AgentRow,
  'outbound_email_count' | 'avg_outbound_emails_per_hour_by_span' | 'reply_span_hours'
>): number | null {
  // 在席时长 = 上游 reply_span_hours（首封到末封实际跨度）；缺失时按 总回邮 ÷
  // by_span 反推。和"标准在席时长（按 30/h 算）"是两条不同的列。
  if (typeof row.reply_span_hours === 'number' && Number.isFinite(row.reply_span_hours)) {
    return row.reply_span_hours
  }
  if (!row.avg_outbound_emails_per_hour_by_span) {
    return null
  }
  return row.outbound_email_count / row.avg_outbound_emails_per_hour_by_span
}

export function getStandardAttendanceHours(row: Pick<
  P1AgentRow, 'outbound_email_count'
>): number | null {
  return computeStandardAttendanceHours(row.outbound_email_count)
}

function buildMailNameToAgentName(mappings: P1AgentMailNameMapping[]) {
  const result = new Map<string, string>()
  mappings.forEach((mapping) => {
    const agentName = mapping.agent_name.trim()
    if (!agentName) return
    mapping.mail_names.forEach((mailName) => {
      const normalizedMailName = mailName.trim()
      if (normalizedMailName && normalizedMailName !== UNRECOGNIZED_AGENT_NAME) {
        result.set(normalizedMailName, agentName)
      }
    })
  })
  return result
}

export function mergeRowsByAgentMailNameMappings(
  rows: P1AgentRow[],
  mappings: P1AgentMailNameMapping[],
): WorkloadTableRow[] {
  const mailNameToAgentName = buildMailNameToAgentName(mappings)
  const merged = new Map<string, WorkloadTableRow>()

  rows.forEach((row) => {
    const targetName = row.agent_name === UNRECOGNIZED_AGENT_NAME
      ? row.agent_name
      : mailNameToAgentName.get(row.agent_name) ?? row.agent_name
    const attendanceHours = getAttendanceHours(row)
    const existing = merged.get(targetName)

    if (!existing) {
      const outbound = row.outbound_email_count
      merged.set(targetName, {
        ...row,
        agent_name: targetName,
        attendance_hours: attendanceHours,
        standard_attendance_hours: computeStandardAttendanceHours(outbound),
        avg_outbound_emails_per_hour_by_span:
          attendanceHours && attendanceHours > 0 ? outbound / attendanceHours : 0,
        qa_reply_counts: { ...row.qa_reply_counts },
      })
      return
    }

    const nextOutbound = existing.outbound_email_count + row.outbound_email_count
    const nextAttendance = sumNullable([existing.attendance_hours, attendanceHours])
    existing.outbound_email_count = nextOutbound
    existing.reply_span_hours = nextAttendance
    existing.attendance_hours = nextAttendance
    existing.standard_attendance_hours = computeStandardAttendanceHours(nextOutbound)
    existing.avg_outbound_emails_per_hour_by_span =
      nextAttendance && nextAttendance > 0 ? nextOutbound / nextAttendance : 0
    existing.qa_reply_counts = {
      excellent: (existing.qa_reply_counts?.excellent ?? 0) + (row.qa_reply_counts?.excellent ?? 0),
      pass: (existing.qa_reply_counts?.pass ?? 0) + (row.qa_reply_counts?.pass ?? 0),
      fail: (existing.qa_reply_counts?.fail ?? 0) + (row.qa_reply_counts?.fail ?? 0),
    }
  })

  return [...merged.values()]
}

export function buildAgentFilterOptions(
  rows: P1AgentRow[],
  mappings: P1AgentMailNameMapping[] = [],
): AgentFilterOption[] {
  const seen = new Set<string>()
  const agentOptions = mergeRowsByAgentMailNameMappings(rows, mappings)
    .map((row) => row.agent_name.trim())
    .filter((agentName) => {
      if (!agentName || seen.has(agentName)) return false
      seen.add(agentName)
      return true
    })
    .map((agentName) => ({ value: agentName, label: agentName }))

  return [{ value: '', label: '全部客服' }, ...agentOptions]
}

export function buildWorkloadTableRows(
  rows: P1AgentRow[],
  mappings: P1AgentMailNameMapping[] = [],
): WorkloadTableRow[] {
  if (!rows.length) return []

  const normalizedRows = mergeRowsByAgentMailNameMappings(rows, mappings)

  // 坐席总量：累加各客服的回邮数 / 在席时长 / 标准在席时长 / 质检结果。
  // 每小时回信均值这一列改用"团队整体节奏"= 总回邮 ÷ 总在席时长，比对
  // 每个客服 rate 的算术平均更有业务意义。
  const totalOutbound = sum(normalizedRows.map((row) => row.outbound_email_count))
  const totalAttendance = sumNullable(normalizedRows.map((row) => row.attendance_hours))
  const teamHourlyBySpan = totalAttendance && totalAttendance > 0 ? totalOutbound / totalAttendance : 0
  const totalRow: WorkloadTableRow = {
    agent_name: '坐席总量',
    isTotal: true,
    outbound_email_count: totalOutbound,
    attendance_hours: totalAttendance,
    standard_attendance_hours: sumNullable(normalizedRows.map((row) => row.standard_attendance_hours)),
    avg_outbound_emails_per_hour_by_span: teamHourlyBySpan,
    avg_outbound_emails_per_hour_by_schedule: 0,
    qa_reply_counts: {
      excellent: sum(normalizedRows.map((row) => row.qa_reply_counts?.excellent ?? 0)),
      pass: sum(normalizedRows.map((row) => row.qa_reply_counts?.pass ?? 0)),
      fail: sum(normalizedRows.map((row) => row.qa_reply_counts?.fail ?? 0)),
    },
  }

  const averageRow: WorkloadTableRow = {
    agent_name: '坐席均值',
    isAverage: true,
    outbound_email_count: average(normalizedRows.map((row) => row.outbound_email_count)),
    attendance_hours: averageNullable(normalizedRows.map((row) => row.attendance_hours)),
    standard_attendance_hours: averageNullable(normalizedRows.map((row) => row.standard_attendance_hours)),
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

  return [...normalizedRows, averageRow, totalRow]
}

function formatCount(row: WorkloadTableRow, value: number): string {
  // 总量行展示整数（求和），均值行展示一位小数，其它（个人）整数。
  return row.isAverage ? formatDecimal(value) : formatInteger(value)
}

function formatSummaryLabelClass(row: WorkloadTableRow): string {
  if (row.isAverage) return 'workload-average-label'
  if (row.isTotal) return 'workload-total-label'
  return ''
}

function formatNullableHours(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatHours(value, 1) : '-'
}

function formatDailyPair(
  total: string,
  daily: string,
  dayCount: number,
): string {
  return dayCount > 1 ? `${total} / ${daily}` : total
}

function formatCountWithDaily(row: WorkloadTableRow, value: number, dayCount: number): string {
  return formatDailyPair(formatCount(row, value), formatCount(row, value / dayCount), dayCount)
}

function formatHoursWithDaily(value: number | null | undefined, dayCount: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return formatDailyPair(formatNullableHours(value), formatNullableHours(value / dayCount), dayCount)
}

export function WorkloadAnalysis({
  workloadRows,
  loading,
  historyRange,
  mappings,
  onOpenMappingConfig,
}: WorkloadAnalysisProps) {
  const dayCount = getPeriodLengthDays(historyRange)
  const workloadColumns = [
    {
      key: 'agent_name',
      label: '客服姓名',
      render: (row: WorkloadTableRow) => (
        <strong className={formatSummaryLabelClass(row)}>{row.agent_name}</strong>
      ),
    },
    {
      key: 'outbound_email_count',
      label: '总回邮数',
      tooltip: getMetricDescription('p1.agent_outbound_email_count'),
      render: (row: WorkloadTableRow) => formatCountWithDaily(row, row.outbound_email_count, dayCount),
    },
    {
      key: 'attendance_hours',
      label: '在席时长',
      tooltip: getMetricDescription('p1.agent_reply_span_hours'),
      render: (row: WorkloadTableRow) => formatHoursWithDaily(row.attendance_hours, dayCount),
    },
    {
      key: 'standard_attendance_hours',
      label: '标准在席时长',
      tooltip: getMetricDescription('p1.agent_standard_attendance_hours'),
      render: (row: WorkloadTableRow) => formatHoursWithDaily(row.standard_attendance_hours, dayCount),
    },
    {
      key: 'avg_outbound_emails_per_hour_by_span',
      label: '每小时回信均值',
      tooltip: getMetricDescription('p1.agent_hourly_reply_span'),
      render: (row: WorkloadTableRow) => formatDecimal(row.avg_outbound_emails_per_hour_by_span),
    },
    {
      key: 'qa_reply_counts',
      label: '质检结果回邮数',
      tooltip: getMetricDescription('p1.agent_qa_reply_counts'),
      render: (row: WorkloadTableRow) => {
        const qa = row.qa_reply_counts ?? { excellent: 0, pass: 0, fail: 0 }
        // Average 行用小数（均值），其它（个人 + 总量）按整数显示。
        return row.isAverage
          ? `${formatDecimal(qa.excellent)} / ${formatDecimal(qa.pass)} / ${formatDecimal(qa.fail)}`
          : `${formatInteger(qa.excellent)} / ${formatInteger(qa.pass)} / ${formatInteger(qa.fail)}`
      },
    },
  ]

  return (
    <div className="p1-workload-table">
      <Table<WorkloadTableRow>
        title="坐席工作量"
        hint="跟随筛选器所选历史时间范围。范围超过 1 天时，总回邮数 / 在席时长 / 标准在席时长展示为「总值 / 日均」。表格底部为「坐席总量」（团队累计）和「坐席均值」（算术平均）。每小时回信均值的总量行 = 总回邮 ÷ 总在席时长；质检结果仅统计已质检回邮，展示顺序：优秀 / 达标 / 不合格。"
        columns={workloadColumns}
        rows={loading ? [] : buildWorkloadTableRows(workloadRows, mappings)}
        emptyCopy={loading ? '正在加载坐席数据...' : '暂无坐席工作量数据'}
        headerActions={(
          <button type="button" className="p1-mapping-config-button" onClick={onOpenMappingConfig}>
            映射配置
          </button>
        )}
      />
    </div>
  )
}
