export function formatInteger(value: number | null | undefined): string {
  return new Intl.NumberFormat('zh-CN').format(value ?? 0)
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  return `${((value ?? 0) * 100).toFixed(digits)}%`
}

export function formatHours(value: number | null | undefined, digits = 1): string {
  return `${(value ?? 0).toFixed(digits)}h`
}

export function formatDecimal(value: number | null | undefined, digits = 1): string {
  return (value ?? 0).toFixed(digits)
}

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return `$${formatInteger(value)}`
}
