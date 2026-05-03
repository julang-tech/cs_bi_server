import type { P1BacklogMail } from '../../api/types'

export function sortBacklogMailsByWaitDesc(items: P1BacklogMail[]) {
  return [...items].sort((a, b) => b.wait_hours - a.wait_hours)
}
