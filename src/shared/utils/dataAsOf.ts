export function formatDataAsOf(value?: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  const hour = `${date.getHours()}`.padStart(2, '0')
  const minute = `${date.getMinutes()}`.padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

export function resolveDataAsOfLabel(meta?: {
  data_as_of?: string | null
  cache_generation?: string | null
  snapshot_at?: string | null
} | null): string | null {
  return (
    formatDataAsOf(meta?.data_as_of) ??
    formatDataAsOf(meta?.cache_generation) ??
    formatDataAsOf(meta?.snapshot_at)
  )
}
