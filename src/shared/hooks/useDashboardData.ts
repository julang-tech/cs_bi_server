import { useEffect, useState } from 'react'
import type { PeriodWindow } from '../../api/types'

interface UseDashboardDataArgs<TBaseFilters, TResponse> {
  baseFilters: TBaseFilters
  currentPeriod: PeriodWindow
  previousPeriod: PeriodWindow
  historyRange: PeriodWindow
  fetcher: (filters: TBaseFilters & PeriodWindow, signal: AbortSignal) => Promise<TResponse>
}

interface UseDashboardDataResult<TResponse> {
  current: TResponse | null
  previous: TResponse | null
  history: TResponse | null
  loading: boolean
  error: string
}

export function useDashboardData<TBaseFilters, TResponse>(
  args: UseDashboardDataArgs<TBaseFilters, TResponse>,
): UseDashboardDataResult<TResponse> {
  const { baseFilters, currentPeriod, previousPeriod, historyRange, fetcher } = args
  const [current, setCurrent] = useState<TResponse | null>(null)
  const [previous, setPrevious] = useState<TResponse | null>(null)
  const [history, setHistory] = useState<TResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Stringify date windows for stable dep comparison
  const cKey = `${currentPeriod.date_from}|${currentPeriod.date_to}`
  const pKey = `${previousPeriod.date_from}|${previousPeriod.date_to}`
  const hKey = `${historyRange.date_from}|${historyRange.date_to}`
  const fKey = JSON.stringify(baseFilters)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    async function run() {
      setLoading(true)
      setError('')
      try {
        const [c, p, h] = await Promise.all([
          fetcher({ ...baseFilters, ...currentPeriod }, controller.signal),
          fetcher({ ...baseFilters, ...previousPeriod }, controller.signal),
          fetcher({ ...baseFilters, ...historyRange }, controller.signal),
        ])
        if (cancelled) return
        setCurrent(c)
        setPrevious(p)
        setHistory(h)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        if (cancelled) return
        setCurrent(null)
        setPrevious(null)
        setHistory(null)
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
  }, [fKey, cKey, pKey, hKey])

  return { current, previous, history, loading, error }
}
