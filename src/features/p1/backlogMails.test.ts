import { describe, expect, it } from 'vitest'
import { sortBacklogMailsByWaitDesc } from './backlogMails'
import type { P1BacklogMail } from '../../api/types'

function mail(mailId: number, waitHours: number): P1BacklogMail {
  return {
    mail_id: mailId,
    received_at: '2026-05-03T02:15:00Z',
    wait_hours: waitHours,
  }
}

describe('sortBacklogMailsByWaitDesc', () => {
  it('puts the longest-waiting backlog mails first', () => {
    const sorted = sortBacklogMailsByWaitDesc([
      mail(1, 26.5),
      mail(2, 61),
      mail(3, 49),
    ])

    expect(sorted.map((item) => item.mail_id)).toEqual([2, 3, 1])
  })
})
