type DataAsOfCadence = '5min' | 'hourly'

type DataAsOfOptions = {
  cadence?: DataAsOfCadence
}

function formatCadenceSuffix(cadence?: DataAsOfCadence) {
  if (cadence === '5min') return '（约 5 分钟更新）'
  if (cadence === 'hourly') return '（约 1 小时更新）'
  return ''
}

export function formatDataAsOf(value?: string | null, options: DataAsOfOptions = {}): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  const hour = `${date.getHours()}`.padStart(2, '0')
  const minute = `${date.getMinutes()}`.padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}${formatCadenceSuffix(options.cadence)}`
}

export function resolveDataAsOfLabel(meta?: {
  data_as_of?: string | null
  cache_generation?: string | null
  snapshot_at?: string | null
} | null, options: DataAsOfOptions = {}): string | null {
  return (
    formatDataAsOf(meta?.data_as_of, options) ??
    formatDataAsOf(meta?.cache_generation, options) ??
    formatDataAsOf(meta?.snapshot_at, options)
  )
}
