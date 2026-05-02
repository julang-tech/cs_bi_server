import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkloadAnalysis, buildWorkloadTableRows, getReplySpanHours } from './WorkloadAnalysis'
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
    root?.render(createElement(WorkloadAnalysis, { workloadRows: rows, loading: false }))
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
  it('derives first-to-last reply span from outbound count and span hourly average', () => {
    expect(getReplySpanHours(rows[0])).toBe(2)
    expect(getReplySpanHours(rows[1])).toBe(6)
  })

  it('adds a single agent-average row before individual agents', () => {
    const tableRows = buildWorkloadTableRows(rows)

    expect(tableRows).toHaveLength(3)
    expect(tableRows[0]).toMatchObject({
      agent_name: '坐席均值',
      outbound_email_count: 18,
      reply_span_hours: 4,
      avg_outbound_emails_per_hour_by_span: 5,
      avg_outbound_emails_per_hour_by_schedule: 2.5,
      qa_reply_counts: { excellent: 4, pass: 6.5, fail: 1 },
    })
    expect(tableRows[1].agent_name).toBe('Mira')
    expect(tableRows[2].agent_name).toBe('Wendy')
  })

  it('does not add an average row when no agents are present', () => {
    expect(buildWorkloadTableRows([])).toEqual([])
  })

  it('shows reply duration without exposing the first-to-last hourly average column', () => {
    renderWorkloadAnalysis()

    expect(host?.textContent).toContain('回信时长')
    expect(host?.textContent).not.toContain('首末封时间跨度')
    expect(host?.textContent).not.toContain('每小时回邮数均值（首末封）')
    expect(host?.textContent).toContain('每小时回邮数均值（工时表）')
  })
})
