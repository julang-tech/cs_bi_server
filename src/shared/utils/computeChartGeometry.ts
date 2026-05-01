const DEFAULT_BOUNDS = { left: 8, right: 96, top: 10, bottom: 86 }

interface ChartBounds {
  left: number
  right: number
  top: number
  bottom: number
}

interface UseChartGeometryArgs<T extends { value: number }> {
  items: T[]
  bounds?: ChartBounds
  yMinOverride?: number
  yMaxOverride?: number
}

export function computeChartGeometry<T extends { value: number }>(
  args: UseChartGeometryArgs<T>,
) {
  const bounds = args.bounds ?? DEFAULT_BOUNDS
  const items = args.items
  const values = items.map((item) => item.value)
  const yMin = args.yMinOverride ?? Math.min(...values, 0)
  const yMax = args.yMaxOverride ?? Math.max(...values, 0)
  const yRange = yMax === yMin ? 1 : yMax - yMin
  const xRange = bounds.right - bounds.left
  const yPixelRange = bounds.bottom - bounds.top

  const points = items.map((item, index) => {
    const x = items.length === 1
      ? 50
      : bounds.left + (index / (items.length - 1)) * xRange
    const y = bounds.bottom - ((item.value - yMin) / yRange) * yPixelRange
    return { x, y }
  })

  const pointsString = points.map((p) => `${p.x},${p.y}`).join(' ')
  const firstX = points[0]?.x ?? 0
  const lastX = points[points.length - 1]?.x ?? 0
  const areaString = points.length
    ? `${firstX},${bounds.bottom} ${pointsString} ${lastX},${bounds.bottom}`
    : ''

  return { bounds, yMin, yMax, points, pointsString, areaString }
}
