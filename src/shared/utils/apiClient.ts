type QueryValue = string | number | boolean | null | undefined | string[]

export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== null && item !== undefined && item !== '') {
          search.append(key, String(item))
        }
      })
      return
    }
    if (value !== null && value !== undefined && value !== '') {
      search.set(key, String(value))
    }
  })
  return search.toString()
}

export async function request<T>(
  path: string,
  params: Record<string, QueryValue>,
  signal?: AbortSignal,
): Promise<T> {
  const query = buildQuery(params)
  const response = await fetch(query ? `${path}?${query}` : path, { signal })
  if (!response.ok) {
    throw new Error(`请求失败：${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}
