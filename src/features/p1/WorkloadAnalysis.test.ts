import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkloadAnalysis,
  buildAgentFilterOptions,
  buildWorkloadTableRows,
  getAttendanceHours,
  getStandardAttendanceHours,
  mergeRowsByAgentMailNameMappings,
} from './WorkloadAnalysis'
import type { P1AgentRow } from '../../api/types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rows: P1AgentRow[] = [
  {
    agent_name: 'Mira',
    outbound_email_count: 12,
    avg_outbound_emails_per_hour_by_span: 6,
    avg_outbound_emails_per_hour_by_schedule: 3,
    qa_reply_counts: { excellent: 3, pass: 6, fail: 0 },
  },
  {
    agent_name: 'Wendy',
    outbound_email_count: 24,
    avg_outbound_emails_per_hour_by_span: 4,
    avg_outbound_emails_per_hour_by_schedule: 2,
    qa_reply_counts: { excellent: 5, pass: 7, fail: 2 },
  },
]

let root: Root | null = null
let host: HTMLDivElement | null = null

function renderWorkloadAnalysis() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)

  act(() => {
    root?.render(createElement(WorkloadAnalysis, {
      workloadRows: rows,
      loading: false,
      historyRange: { date_from: '2026-05-01', date_to: '2026-05-03' },
      mappings: [],
      onOpenMappingConfig: () => undefined,
    }))
  })
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  host?.remove()
  root = null
  host = null
})

describe('WorkloadAnalysis table rows', () => {
  it('derives 在席时长 from outbound count and span hourly average (legacy formula renamed)', () => {
    // 12 / 6 = 2 hours actual span
    expect(getAttendanceHours(rows[0])).toBe(2)
    // 24 / 4 = 6 hours actual span
    expect(getAttendanceHours(rows[1])).toBe(6)
  })

  it('derives 标准在席时长 by dividing outbound count by the 30/h baseline', () => {
    // 12 / 30 = 0.4 hours
    expect(getStandardAttendanceHours(rows[0])).toBeCloseTo(0.4)
    // 24 / 30 = 0.8 hours
    expect(getStandardAttendanceHours(rows[1])).toBeCloseTo(0.8)
  })

  it('appends a 坐席总量 sum row and a 坐席均值 average row at the bottom', () => {
    const tableRows = buildWorkloadTableRows(rows)

    expect(tableRows).toHaveLength(4)
    expect(tableRows[0].agent_name).toBe('Mira')
    expect(tableRows[1].agent_name).toBe('Wendy')

    // Average row first (just below individuals).
    const averageRow = tableRows[2]
    expect(averageRow).toMatchObject({
      agent_name: '坐席均值',
      isAverage: true,
      outbound_email_count: 18,                    // (12 + 24) / 2
      avg_outbound_emails_per_hour_by_span: 5,
      avg_outbound_emails_per_hour_by_schedule: 2.5,
      qa_reply_counts: { excellent: 4, pass: 6.5, fail: 1 },
    })
    expect(averageRow.attendance_hours).toBe(4)
    expect(averageRow.standard_attendance_hours).toBeCloseTo(0.6)

    // Total row at the very bottom: simple sums.
    const totalRow = tableRows[3]
    expect(totalRow).toMatchObject({
      agent_name: '坐席总量',
      isTotal: true,
      outbound_email_count: 36,                    // 12 + 24
      qa_reply_counts: { excellent: 8, pass: 13, fail: 2 },
    })
    expect(totalRow.attendance_hours).toBe(8)      // 2 + 6
    expect(totalRow.standard_attendance_hours).toBeCloseTo(1.2) // 0.4 + 0.8
    // 团队节奏 = 36 / 8 = 4.5 (NOT mean of 6 and 4 = 5)
    expect(totalRow.avg_outbound_emails_per_hour_by_span).toBeCloseTo(4.5)
  })

  it('builds agent filter options from workload rows and mapping-merged display order', () => {
    const options = buildAgentFilterOptions([
      {
        agent_name: 'Mia',
        outbound_email_count: 8,
        avg_outbound_emails_per_hour_by_span: 4,
        avg_outbound_emails_per_hour_by_schedule: 0,
        qa_reply_counts: { excellent: 0, pass: 0, fail: 0 },
      },
      {
        agent_name: 'Choe',
        outbound_email_count: 5,
        avg_outbound_emails_per_hour_by_span: 5,
        avg_outbound_emails_per_hour_by_schedule: 0,
        qa_reply_counts: { excellent: 0, pass: 0, fail: 0 },
      },
      {
        agent_name: '未识别',
        outbound_email_count: 3,
        avg_outbound_emails_per_hour_by_span: 3,
        avg_outbound_emails_per_hour_by_schedule: 0,
        qa_reply_counts: { excellent: 0, pass: 0, fail: 0 },
      },
      {
        agent_name: 'Bell',
        outbound_email_count: 2,
        avg_outbound_emails_per_hour_by_span: 2,
        avg_outbound_emails_per_hour_by_schedule: 0,
        qa_reply_counts: { excellent: 0, pass: 0, fail: 0 },
      },
    ], [
      { agent_name: 'Chloe', mail_names: ['Choe'] },
      { agent_name: 'Bella', mail_names: ['Bell', '未识别'] },
    ])

    expect(options).toEqual([
      { value: '', label: '全部客服' },
      { value: 'Mia', label: 'Mia' },
      { value: 'Chloe', label: 'Chloe' },
      { value: '未识别', label: '未识别' },
      { value: 'Bella', label: 'Bella' },
    ])
    expect(options.map((option) => option.label)).not.toContain('坐席均值')
    expect(options.map((option) => option.label)).not.toContain('坐席总量')
  })

  it('merges mail signature rows into configured customer service agent rows', () => {
    const merged = mergeRowsByAgentMailNameMappings([
      {
        agent_name: 'Mira Mail',
        outbound_email_count: 12,
        reply_span_hours: 2,
        avg_outbound_emails_per_hour_by_span: 6,
        avg_outbound_emails_per_hour_by_schedule: 0,
        qa_reply_counts: { excellent: 1, pass: 2, fail: 0 },
      },
      {
        agent_name: 'Mia Sign',
        outbound_email_count: 18,
        reply_span_hours: 3,
        avg_outbound_emails_per_hour_by_span: 6,
        avg_outbound_emails_per_hour_by_schedule: 0,
        qa_reply_counts: { excellent: 3, pass: 4, fail: 1 },
      },
      {
        agent_name: '未识别',
        outbound_email_count: 9,
        reply_span_hours: 3,
        avg_outbound_emails_per_hour_by_span: 3,
        avg_outbound_emails_per_hour_by_schedule: 0,
        qa_reply_counts: { excellent: 0, pass: 0, fail: 0 },
      },
    ], [{ agent_name: 'Mira', mail_names: ['Mira Mail', 'Mia Sign', '未识别'] }])

    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({
      agent_name: 'Mira',
      outbound_email_count: 30,
      attendance_hours: 5,
      qa_reply_counts: { excellent: 4, pass: 6, fail: 1 },
    })
    expect(merged[0].avg_outbound_emails_per_hour_by_span).toBeCloseTo(6)
    expect(merged[1].agent_name).toBe('未识别')
  })

  it('does not add an average row when no agents are present', () => {
    expect(buildWorkloadTableRows([])).toEqual([])
  })

  it('shows both 在席时长 / 标准在席时长 columns plus 坐席总量 row', () => {
    renderWorkloadAnalysis()

    expect(host?.textContent).toContain('在席时长')
    expect(host?.textContent).toContain('标准在席时长')
    expect(host?.textContent).toContain('每小时回信均值')
    expect(host?.textContent).toContain('坐席总量')
    expect(host?.textContent).toContain('坐席均值')
    expect(host?.textContent).toContain('跟随筛选器所选历史时间范围')
    expect(host?.textContent).toContain('质检结果仅统计已质检回邮')
    expect(host?.textContent).toContain('映射配置')
    expect(host?.textContent).toContain('12 / 4')
    expect(host?.textContent).toContain('2.0h / 0.7h')
    expect(host?.textContent).not.toContain('回信时长')
    expect(host?.textContent).not.toContain('每小时回邮数均值（工时表）')
    expect(host?.textContent).not.toContain('首末封')
    expect(host?.textContent).not.toContain('首尾封')
  })
})
