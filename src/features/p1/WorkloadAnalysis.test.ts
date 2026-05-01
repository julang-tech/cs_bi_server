import { describe, expect, it } from 'vitest'
import { buildWorkloadTableRows, getReplySpanHours } from './WorkloadAnalysis'
import type { P1AgentRow } from '../../api/types'

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
})
