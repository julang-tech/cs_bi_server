export class TtlCache<V> {
  private readonly items = new Map<string, { createdAt: number; value: V }>()

  constructor(private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const item = this.items.get(key)
    if (!item) {
      return undefined
    }

    if (Date.now() - item.createdAt > this.ttlMs) {
      this.items.delete(key)
      return undefined
    }

    return item.value
  }

  set(key: string, value: V): V {
    this.items.set(key, { createdAt: Date.now(), value })
    return value
  }
}
