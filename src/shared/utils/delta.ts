export type DeltaMode = 'percent' | 'pp'
export type MetricPolarity = 'positive' | 'negative' | 'neutral'
export type DeltaTone = 'up' | 'down' | 'neutral' | 'muted'

export interface DeltaInfo {
  tone: DeltaTone
  text: string
}

function toneForDirection(direction: 'increase' | 'decrease', polarity: MetricPolarity): DeltaTone {
  if (polarity === 'neutral') {
    return 'neutral'
  }
  if (polarity === 'positive') {
    return direction === 'increase' ? 'up' : 'down'
  }
  return direction === 'increase' ? 'down' : 'up'
}

export function buildDirectionalDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  mode: DeltaMode,
  polarity: MetricPolarity,
): DeltaInfo {
  if (previous === null || previous === undefined) return { tone: 'muted', text: '-' }
  if (mode === 'pp') {
    const diff = (current ?? 0) - previous
    if (diff === 0) return { tone: 'neutral', text: '0.00pp' }
    const direction = diff > 0 ? 'increase' : 'decrease'
    return {
      tone: toneForDirection(direction, polarity),
      text: `${diff > 0 ? '↑' : '↓'} ${Math.abs(diff * 100).toFixed(2)}pp`,
    }
  }
  if (!previous) return { tone: 'muted', text: '-' }
  const ratio = ((current ?? 0) - previous) / previous
  if (ratio === 0) return { tone: 'neutral', text: '0.0%' }
  const direction = ratio > 0 ? 'increase' : 'decrease'
  return {
    tone: toneForDirection(direction, polarity),
    text: `${ratio > 0 ? '↑' : '↓'} ${Math.abs(ratio * 100).toFixed(1)}%`,
  }
}
