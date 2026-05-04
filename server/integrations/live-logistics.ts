import crypto from 'node:crypto'
import type { SyncConfig } from './sync-config.js'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type LiveLogisticsLookupInput = {
  trackingNumber: string
  carrier?: string | null
  internalTrackingNumber?: string | null
}

export type ProviderTrackingResult = {
  provider: string
  lookup_status: 'success' | 'failed' | 'no_data'
  logistics_status: string
  status_text?: string
  last_mile_carrier?: string
  last_mile_tracking_number?: string
  raw?: unknown
  error_note?: string
}

export type LiveLogisticsStatusResult = {
  status: string | null
  provider: string
  rawStatus: string
  statusText: string
  lookupStatus: string
}

export type LiveLogisticsProvider = {
  queryFpx?: (input: LiveLogisticsLookupInput) => Promise<ProviderTrackingResult>
  queryYunexpress?: (input: LiveLogisticsLookupInput) => Promise<ProviderTrackingResult>
}

function stringify(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function parseMaybeJson(value: unknown) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return value
  }
}

function normalizeCarrier(value: unknown) {
  return stringify(value).toLowerCase()
}

export function isFpxCarrier(value: unknown) {
  const carrier = normalizeCarrier(value)
  return carrier.includes('4px') || carrier.includes('递四方') || carrier.includes('递4方')
}

export function isYunexpressCarrier(value: unknown) {
  const carrier = normalizeCarrier(value)
  return carrier.includes('云途') || carrier.includes('yunexpress') || carrier.startsWith('yt')
}

export function inferCarrierFromTracking(trackingNumber: string) {
  const tracking = trackingNumber.trim().toUpperCase()
  if (tracking.startsWith('4PX')) return '4PX'
  if (tracking.startsWith('YT') || tracking.startsWith('YUN')) return 'YunExpress'
  return ''
}

function collectFpxTrackingList(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object') return []
  const data = parseMaybeJson((payload as Record<string, unknown>).data)
  if (Array.isArray(data)) return data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
  if (!data || typeof data !== 'object') return []
  const trackingList = (data as Record<string, unknown>).trackingList
  return Array.isArray(trackingList)
    ? trackingList.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : []
}

export function normalizeFpxTrackingStatus(payload: unknown): string {
  const matches: string[] = []
  for (const item of collectFpxTrackingList(payload)) {
    const content = stringify(item.trackingContent).toLowerCase()
    const code = stringify(item.businessLinkCode || item.nodeName).toUpperCase()

    if (code.startsWith('FPX_S_') || /(delivered|signed|delivery completed|front door|safe place|collection point)/i.test(content)) {
      matches.push('delivered')
      continue
    }
    if (/(delivery failed|undeliverable|unable to deliver|lost|missing|returned|return to sender|intercept)/i.test(content)) {
      matches.push('delivery_failed')
      continue
    }
    if (/(customs|held by|detained)/i.test(content)) {
      if (/(cleared|released)/i.test(content)) continue
      matches.push('customs')
      continue
    }
    if (code.startsWith('FPX_I_') || /(out for delivery|local delivery|sorting centre|sorting center|service centre|service center)/i.test(content)) {
      matches.push('last_mile')
      continue
    }
    if (code.startsWith('FPX_M_') || /(departed from|departure from|arrival to|arrived at|airline|in transit)/i.test(content)) {
      matches.push('international')
      continue
    }
    if (code.startsWith('FPX_C_') || /(picked up|shipment arrived at facility|depart from facility)/i.test(content)) {
      matches.push('first_mile')
      continue
    }
    if (code.startsWith('FPX_L_') || /(parcel information received|shipment information received|label created)/i.test(content)) {
      matches.push('')
    }
  }
  for (const status of ['delivered', 'delivery_failed', 'customs', 'last_mile', 'international', 'first_mile']) {
    if (matches.includes(status)) return status
  }
  return matches.includes('') ? '' : ''
}

function stringifyYunexpressEvent(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return [
    'ProcessContent',
    'ProcessDesc',
    'TrackContent',
    'TrackingContent',
    'Remark',
    'LatestEvent',
    'EventDescription',
    'StatusDesc',
  ]
    .map((key) => stringify(record[key]))
    .filter(Boolean)
    .join(' | ')
}

function collectYunexpressText(payload: unknown): string {
  let items: unknown[] = []
  if (Array.isArray(payload)) {
    items = payload
  } else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const data = record.data
    const result = record.result
    const rawItems = Array.isArray(data) ? data : Array.isArray(result) ? result : Array.isArray(record.items) ? record.items : [record]
    items = rawItems
  }
  const item = items.find((entry) => entry && typeof entry === 'object') as Record<string, unknown> | undefined
  if (!item) return ''
  const fragments: string[] = []
  if (item.LatestEvent) fragments.push(stringifyYunexpressEvent(item.LatestEvent))
  for (const detail of Array.isArray(item.TrackDetails) ? item.TrackDetails : []) {
    fragments.push(stringifyYunexpressEvent(detail))
  }
  const trackInfo = (item.track_Info || item.trackInfo) as Record<string, unknown> | undefined
  for (const event of Array.isArray(trackInfo?.track_events) ? trackInfo.track_events : []) {
    if (!event || typeof event !== 'object') continue
    fragments.push(stringify((event as Record<string, unknown>).process_content))
    fragments.push(stringify((event as Record<string, unknown>).track_node_code))
  }
  if (item.package_status) fragments.push(`package_status:${stringify(item.package_status)}`)
  return fragments.filter(Boolean).join(' ').toLowerCase()
}

export function normalizeYunexpressTrackingStatus(payload: unknown): string {
  const text = collectYunexpressText(payload)
  if (!text) return ''
  if (/(delivered|signed|proof of delivery|front door)/i.test(text)) return 'delivered'
  if (/(customs|clearance)/i.test(text)) return 'customs'
  if (/(delivery failed|undeliverable|address issue|lost|missing|returned|return to sender|intercept)/i.test(text)) {
    return 'delivery_failed'
  }
  if (/(in transit|out for delivery|arrived at|departed from|processed|handover|picked up)/i.test(text)) {
    return 'normal_single'
  }
  if (/(shipment information received|label created|pre-transit)/i.test(text)) return ''
  return 'normal_single'
}

export function extractTrackingStatusText(payload: unknown): string {
  const fpxList = collectFpxTrackingList(payload)
  if (fpxList.length) {
    return fpxList
      .map((item) => stringify(item.trackingContent))
      .filter(Boolean)
      .join(' | ')
  }
  return collectYunexpressText(payload)
}

export function mapTrackingStatusToFeishuLogisticsStatus(
  status: string,
  statusText = '',
): string | null {
  const normalized = status.trim().toLowerCase()
  const text = statusText.toLowerCase()
  if (!normalized) return null
  if (normalized === 'delivered' || normalized === 'signed') return '已签收'
  if (normalized === 'delivery_failed') {
    if (/(lost|missing|丢包|丢失|丢件)/i.test(text)) return '丢包'
    if (/(returned|return to sender|intercept|退回|拦截)/i.test(text)) return '发货已拦截'
    return '派送失败'
  }
  if (['first_mile', 'international', 'last_mile', 'normal_single', 'in_transit', 'customs'].includes(normalized)) {
    return '运输途中'
  }
  return null
}

export async function resolveLiveLogisticsStatus(
  input: LiveLogisticsLookupInput,
  provider: LiveLogisticsProvider,
): Promise<LiveLogisticsStatusResult> {
  const trackingNumber = stringify(input.trackingNumber)
  const carrier = stringify(input.carrier) || inferCarrierFromTracking(trackingNumber)
  let result: ProviderTrackingResult | null = null

  if (isFpxCarrier(carrier) && provider.queryFpx) {
    result = await provider.queryFpx({ ...input, trackingNumber, carrier })
  } else if (isYunexpressCarrier(carrier) && provider.queryYunexpress) {
    result = await provider.queryYunexpress({ ...input, trackingNumber, carrier })
  }

  const rawStatus = stringify(result?.logistics_status)
  const statusText = stringify(result?.status_text) || extractTrackingStatusText(result?.raw)
  return {
    status: mapTrackingStatusToFeishuLogisticsStatus(rawStatus, statusText),
    provider: stringify(result?.provider),
    rawStatus,
    statusText,
    lookupStatus: stringify(result?.lookup_status),
  }
}

function hasFpxCredentials(config: SyncConfig) {
  const provider = config.logistics?.fpx
  return Boolean(provider?.app_key && provider.app_secret)
}

function hasYunexpressCredentials(config: SyncConfig) {
  const provider = config.logistics?.yunexpress
  return Boolean(provider?.app_id && provider.app_secret && provider.source_key)
}

async function jsonRequest(url: string, options: { method?: string; headers?: Record<string, string>; payload?: unknown; timeoutMs?: number }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.payload ? { 'Content-Type': 'application/json;charset=utf-8' } : {}),
        ...(options.headers ?? {}),
      },
      body: options.payload ? JSON.stringify(options.payload) : undefined,
      signal: controller.signal,
    })
    const text = await response.text()
    const payload = text.trim() ? JSON.parse(text) as unknown : {}
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return payload
  } finally {
    clearTimeout(timeout)
  }
}

export class ConfiguredLiveLogisticsClient implements LiveLogisticsProvider {
  constructor(private readonly config: SyncConfig) {}

  private async callFpxMethod(
    method: string,
    body: Record<string, string>,
  ): Promise<{ raw: unknown; ok: boolean; logisticsStatus: string }> {
    const provider = this.config.logistics?.fpx
    if (!provider || !hasFpxCredentials(this.config)) {
      return { raw: {}, ok: false, logisticsStatus: '' }
    }
    const appKey = provider.app_key ?? ''
    const appSecret = provider.app_secret ?? ''
    const timestamp = String(Date.now())
    const publicParams = {
      app_key: appKey,
      format: 'json',
      method,
      timestamp,
      v: '1.0',
    }
    const bodyString = JSON.stringify(body)
    const stringToSign =
      Object.keys(publicParams)
        .sort()
        .map((key) => `${key}${publicParams[key as keyof typeof publicParams]}`)
        .join('') + bodyString + appSecret
    const sign = crypto.createHash('md5').update(stringToSign).digest('hex').toUpperCase()
    const url = new URL(`${(provider.api_base_url ?? 'https://open.4px.com').replace(/\/$/, '')}/router/api/service`)
    for (const [key, value] of Object.entries({ ...publicParams, sign, language: 'en' })) {
      url.searchParams.set(key, value)
    }
    const raw = await jsonRequest(url.toString(), {
      method: 'POST',
      payload: body,
      timeoutMs: (this.config.logistics?.timeout_seconds ?? 20) * 1000,
    })
    return {
      raw,
      ok: String(readPath(raw, ['result']) ?? '') === '1' && !readPath(raw, ['errors']),
      logisticsStatus: normalizeFpxTrackingStatus(raw),
    }
  }

  async queryFpx(input: LiveLogisticsLookupInput): Promise<ProviderTrackingResult> {
    if (!hasFpxCredentials(this.config)) {
      return { provider: 'fpx', lookup_status: 'failed', logistics_status: '' }
    }

    const probes: Array<{ raw: unknown; ok: boolean; logisticsStatus: string }> = []
    if (input.internalTrackingNumber) {
      probes.push(await this.callFpxMethod('cs.trs.query.orderNode', { fpxTrackingNo: input.internalTrackingNumber }))
    }
    if (input.trackingNumber) {
      probes.push(await this.callFpxMethod('tr.order.tracking.get', { deliveryOrderNo: input.trackingNumber }))
    }

    const best = probes.find((probe) => probe.logisticsStatus) ?? probes[0]
    return {
      provider: 'fpx',
      lookup_status: probes.some((probe) => probe.ok) ? 'success' : 'failed',
      logistics_status: best?.logisticsStatus ?? '',
      raw: best?.raw,
    }
  }

  async queryYunexpress(input: LiveLogisticsLookupInput): Promise<ProviderTrackingResult> {
    const provider = this.config.logistics?.yunexpress
    if (!provider || !hasYunexpressCredentials(this.config)) {
      return { provider: 'yunexpress', lookup_status: 'failed', logistics_status: '' }
    }
    const appId = provider.app_id ?? ''
    const appSecret = provider.app_secret ?? ''
    const sourceKey = provider.source_key ?? ''
    const baseUrl = (provider.api_base_url ?? 'https://openapi.yunexpress.cn').replace(/\/$/, '')
    const tokenPayload = await jsonRequest(`${baseUrl}/openapi/oauth2/token`, {
      method: 'POST',
      payload: {
        grantType: 'client_credentials',
        sourceKey,
        appId,
        appSecret,
      },
      timeoutMs: (this.config.logistics?.timeout_seconds ?? 20) * 1000,
    })
    const token = stringify(
      readPath(tokenPayload, ['accessToken']) ||
        readPath(tokenPayload, ['data', 'accessToken']) ||
        readPath(tokenPayload, ['data', 'access_token']) ||
        readPath(tokenPayload, ['access_token']),
    )
    const uri = '/v1/track-service/info/get'
    const timestamp = String(Date.now())
    const dataToSign = `date=${timestamp}&method=GET&uri=${uri}`
    const sign = crypto
      .createHmac('sha256', appSecret)
      .update(dataToSign)
      .digest('base64')
    const url = new URL(`${baseUrl}${uri}`)
    url.searchParams.set('order_number', input.trackingNumber)
    const raw = await jsonRequest(url.toString(), {
      headers: { token, date: timestamp, sign },
      timeoutMs: (this.config.logistics?.timeout_seconds ?? 20) * 1000,
    })
    return {
      provider: 'yunexpress',
      lookup_status: raw ? 'success' : 'failed',
      logistics_status: normalizeYunexpressTrackingStatus(raw),
      raw,
    }
  }
}

export function createConfiguredLiveLogisticsClient(config: SyncConfig): LiveLogisticsProvider | null {
  if (config.logistics?.enabled === false) return null
  if (!hasFpxCredentials(config) && !hasYunexpressCredentials(config)) return null
  return new ConfiguredLiveLogisticsClient(config)
}
