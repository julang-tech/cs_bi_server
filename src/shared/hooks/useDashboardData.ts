import { useEffect, useState } from 'react'
import type { PeriodWindow } from '../../api/types'

interface UseDashboardDataArgs<TBaseFilters, TResponse> {
  baseFilters: TBaseFilters
  currentPeriod: PeriodWindow
  previousPeriod: PeriodWindow
  historyRange: PeriodWindow
  // Optional: same-length range immediately before historyRange. When supplied,
  // an extra parallel fetch returns it as `previousHistory`. Used by the focus
  // chart summary line for "vs 上一区间" deltas.
  previousHistoryRange?: PeriodWindow
  fetcher: (filters: TBaseFilters & PeriodWindow, signal: AbortSignal) => Promise<TResponse>
}

interface UseDashboardDataResult<TResponse> {
  current: TResponse | null
  previous: TResponse | null
  history: TResponse | null
  previousHistory: TResponse | null
  loading: boolean
  error: string
  refetch: () => void
}

export function useDashboardData<TBaseFilters, TResponse>(
  args: UseDashboardDataArgs<TBaseFilters, TResponse>,
): UseDashboardDataResult<TResponse> {
  const { baseFilters, currentPeriod, previousPeriod, historyRange, previousHistoryRange, fetcher } = args
  const [current, setCurrent] = useState<TResponse | null>(null)
  const [previous, setPrevious] = useState<TResponse | null>(null)
  const [history, setHistory] = useState<TResponse | null>(null)
  const [previousHistory, setPreviousHistory] = useState<TResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  // Stringify date windows for stable dep comparison
  const cKey = `${currentPeriod.date_from}|${currentPeriod.date_to}`
  const pKey = `${previousPeriod.date_from}|${previousPeriod.date_to}`
  const hKey = `${historyRange.date_from}|${historyRange.date_to}`
  const phKey = previousHistoryRange
    ? `${previousHistoryRange.date_from}|${previousHistoryRange.date_to}`
    : ''
  const fKey = JSON.stringify(baseFilters)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    async function run() {
      setLoading(true)
      setError('')
      try {
        const fetches: Array<Promise<TResponse | null>> = [
          fetcher({ ...baseFilters, ...currentPeriod }, controller.signal),
          fetcher({ ...baseFilters, ...previousPeriod }, controller.signal),
          fetcher({ ...baseFilters, ...historyRange }, controller.signal),
          previousHistoryRange
            ? fetcher({ ...baseFilters, ...previousHistoryRange }, controller.signal)
            : Promise.resolve<TResponse | null>(null),
        ]
        const [c, p, h, ph] = await Promise.all(fetches)
        if (cancelled) return
        setCurrent(c)
        setPrevious(p)
        setHistory(h)
        setPreviousHistory(ph)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        if (cancelled) return
        setCurrent(null)
        setPrevious(null)
        setHistory(null)
        setPreviousHistory(null)
        setError((err as Error).message || '加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()
    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fKey, cKey, pKey, hKey, phKey, reloadKey])

  return {
    current,
    previous,
    history,
    previousHistory,
    loading,
    error,
    refetch: () => setReloadKey((key) => key + 1),
  }
}
