import fs from 'node:fs'
import path from 'node:path'
import { TtlCache } from '../domain/p3/cache.js'
import type {
  IssueProvider,
  SourceBundle,
  StandardIssueRecord,
} from '../domain/p3/models.js'
import type { SyncConfig } from './sync-config.js'

export type FeishuRecord = {
  record_id: string
  fields: Record<string, unknown>
}

export type FeishuField = {
  field_id: string
  field_name: string
  field_type: number | null
  property: Record<string, unknown> | null
}

type FeishuLogger = {
  info: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

// Keep in sync with server/integrations/sqlite.ts.
const VIEW_TO_MAJOR_TYPE = {
  '1-1待跟进表-退款': 'product',
  '1-2待跟进表-漏发、发错': 'warehouse',
  '1-3待跟进表-货品瑕疵': 'product',
  '1-4待跟进表-物流问题': 'logistics',
  '1-5待跟进表-补发': 'warehouse',
  '2-催单表': 'other',
  '3-客诉争议表': 'other',
} as const

const COMPLAINT_TYPE_PREFIX_MAP: Array<[string, 'product' | 'warehouse' | 'logistics' | 'refund' | 'other']> = [
  ['仓库-', 'warehouse'],
  ['货品瑕疵-', 'product'],
  ['物流问题-', 'logistics'],
  ['客户原因-', 'refund'],
  ['高风险订单', 'other'],
  ['欧洲被税', 'other'],
  ['其他问题', 'other'],
]

function normalizeText(value: unknown): string | null {
  if (value == null) return null
  if (Array.isArray(value)) {
    const parts = value.map((item) => normalizeText(item)).filter(Boolean)
    return parts.length ? parts.join(', ') : null
  }
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>
    for (const key of ['text', 'name', 'email', 'value']) {
      if (key in objectValue) {
        return normalizeText(objectValue[key])
      }
    }
    return null
  }
  const text = String(value).trim()
  return text || null
}

function inferMajorIssueType(
  fields: Record<string, unknown>,
): 'product' | 'warehouse' | 'logistics' | 'refund' | 'other' {
  const viewRaw = fields['命中视图']
  const viewValues = Array.isArray(viewRaw)
    ? (viewRaw.map((v) => normalizeText(v)).filter(Boolean) as string[])
    : ([normalizeText(viewRaw)].filter(Boolean) as string[])
  for (const view of viewValues) {
    if (view in VIEW_TO_MAJOR_TYPE) {
      return VIEW_TO_MAJOR_TYPE[view as keyof typeof VIEW_TO_MAJOR_TYPE]
    }
  }

  const complaintType = normalizeText(fields['客诉类型'])
  if (complaintType) {
    for (const [prefix, type] of COMPLAINT_TYPE_PREFIX_MAP) {
      if (complaintType.startsWith(prefix) || complaintType === prefix) {
        return type
      }
    }
  }

  if (normalizeText(fields['瑕疵原因'])) return 'product'
  if (normalizeText(fields['错/漏发原因'])) return 'warehouse'
  if (normalizeText(fields['物流-跟进结果'])) return 'logistics'

  return 'other'
}

function inferMinorIssueType(
  fields: Record<string, unknown>,
  majorIssueType: NonNullable<ReturnType<typeof inferMajorIssueType>>,
) {
  const primary = normalizeText(fields['客诉类型'])
  if (primary) return primary
  if (majorIssueType === 'warehouse') {
    return normalizeText(fields['错/漏发原因']) ?? '仓库问题-其他'
  }
  if (majorIssueType === 'product') {
    return normalizeText(fields['瑕疵原因']) ?? '产品问题-其他'
  }
  return normalizeText(fields['物流-跟进结果']) ?? '物流问题-其他'
}

function parseDate(rawValue: unknown) {
  const text = normalizeText(rawValue)
  if (!text) return null
  const date = new Date(text.replace(/\//g, '-'))
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

function loadFixtureIssues(repoRoot: string): StandardIssueRecord[] {
  const fixturePath = path.join(repoRoot, 'server', 'fixtures', 'p3-issues.json')
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as StandardIssueRecord[]
}

export class FixtureIssueProvider implements IssueProvider {
  private readonly cache = new TtlCache<SourceBundle>(900_000)

  constructor(private readonly repoRoot: string) {}

  async getSourceBundle() {
    const cached = this.cache.get('source_bundle')
    if (cached) {
      return cached
    }
    const bundle = {
      issues: loadFixtureIssues(this.repoRoot),
      notes: [],
      partial_data: false,
    }
    return this.cache.set('source_bundle', bundle)
  }
}

export class FeishuIssueProvider implements IssueProvider {
  private readonly cache = new TtlCache<SourceBundle>(900_000)
  private readonly tokenCache = new TtlCache<string>(6_000_000)

  constructor(
    private readonly repoRoot: string,
    private readonly config: SyncConfig,
  ) {}

  async getSourceBundle() {
    const cached = this.cache.get('source_bundle')
    if (cached) {
      return cached
    }

    const appToken = this.config.target?.app_token
    const tableId = this.config.target?.table_id
    const viewId = this.config.target?.view_id

    if (!appToken || !tableId || !viewId) {
      const fallback = {
        issues: loadFixtureIssues(this.repoRoot),
        notes: ['Missing Feishu target app_token/table_id/view_id, using local fixture issue bundle.'],
        partial_data: true,
      }
      return this.cache.set('source_bundle', fallback)
    }

    try {
      const records = await this.fetchAllRecords(appToken, tableId, viewId)
      const issues: StandardIssueRecord[] = []
      const notes: string[] = []

      for (const record of records) {
        if (!normalizeText(record.fields['订单号'])) {
          notes.push(`Skipped record ${record.record_id}: missing order number.`)
          continue
        }

        // normalizeRecord always returns an issue when 订单号 is present;
        // unrecognised 命中视图 + 客诉类型 fall into 'other' rather than being dropped.
        const normalized = normalizeRecord(record)
        if (normalized) issues.push(normalized)
      }

      const bundle = { issues, notes, partial_data: false }
      return this.cache.set('source_bundle', bundle)
    } catch (error) {
      const fallback = {
        issues: [],
        notes: [
          `Failed to fetch Feishu records: ${error instanceof Error ? error.message : String(error)}`,
        ],
        partial_data: true,
      }
      return this.cache.set('source_bundle', fallback)
    }
  }

  private async getTenantAccessToken() {
    const cached = this.tokenCache.get('tenant_access_token')
    if (cached) {
      return cached
    }

    const response = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          app_id: this.config.feishu.app_id,
          app_secret: this.config.feishu.app_secret,
        }),
      },
    )

    if (!response.ok) {
      throw new Error(`Feishu auth failed: ${response.status}`)
    }

    const payload = (await response.json()) as {
      code?: number
      msg?: string
      tenant_access_token?: string
    }

    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`Feishu auth error ${payload.code}: ${payload.msg}`)
    }

    return this.tokenCache.set('tenant_access_token', payload.tenant_access_token)
  }

  private async fetchAllRecords(appToken: string, tableId: string, viewId: string) {
    const token = await this.getTenantAccessToken()
    const records: FeishuRecord[] = []
    let pageToken: string | undefined

    while (true) {
      const url = new URL(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      )
      url.searchParams.set('page_size', '500')
      url.searchParams.set('view_id', viewId)
      url.searchParams.set(
        'field_names',
        JSON.stringify([
          '记录日期',
          '订单号',
          '客户邮箱',
          '客诉SKU',
          '客诉类型',
          '客诉方案',
          '待跟进客诉备注',
          '命中视图',
          '错/漏发原因',
          '瑕疵原因',
          '物流-跟进过程',
          '物流-跟进结果',
          '解决方案',
          '物流号',
          '物流状态',
          '问题处理状态',
        ]),
      )
      if (pageToken) {
        url.searchParams.set('page_token', pageToken)
      }

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        throw new Error(`Feishu records fetch failed: ${response.status}`)
      }

      const payload = (await response.json()) as {
        code?: number
        msg?: string
        data?: { items?: FeishuRecord[]; page_token?: string }
      }

      if (payload.code !== 0) {
        throw new Error(`Feishu records error ${payload.code}: ${payload.msg}`)
      }

      records.push(...(payload.data?.items ?? []))
      pageToken = payload.data?.page_token
      if (!pageToken) {
        break
      }
    }

    return records
  }
}

type RequestOptions = {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  payload?: Record<string, unknown>
  params?: Record<string, string>
}

function getAttachmentToken(attachment: Record<string, unknown>) {
  const token = attachment.file_token ?? attachment.token
  return typeof token === 'string' && token.trim() ? token.trim() : null
}

function getAttachmentName(attachment: Record<string, unknown>, fallbackToken: string) {
  const name = attachment.name ?? attachment.file_name
  return typeof name === 'string' && name.trim() ? name.trim() : `${fallbackToken}.bin`
}

function getAttachmentMimeType(attachment: Record<string, unknown>, responseContentType?: string | null) {
  const rawType = attachment.type ?? attachment.mime_type ?? attachment.mimeType ?? responseContentType
  if (typeof rawType !== 'string') {
    return 'application/octet-stream'
  }
  const type = rawType.split(';')[0].trim()
  return type || 'application/octet-stream'
}

function getAttachmentDownloadUrl(attachment: Record<string, unknown>) {
  const rawUrl = attachment.tmp_url ?? attachment.url
  return typeof rawUrl === 'string' && rawUrl.trim() ? rawUrl.trim() : null
}

function getBitableMediaParentType(mimeType: string) {
  return mimeType.toLowerCase().startsWith('image/') ? 'bitable_image' : 'bitable_file'
}

export class FeishuTableClient {
  private readonly tokenCache = new TtlCache<string>(6_000_000)

  constructor(
    private readonly config: SyncConfig,
    private readonly logger?: FeishuLogger,
  ) {}

  async listRecords(table: SyncConfig['source'], fieldNames?: string[]) {
    const records: FeishuRecord[] = []
    let pageToken: string | undefined
    let pageIndex = 0

    while (true) {
      pageIndex += 1
      const response = await this.request({
        method: 'GET',
        path: `/bitable/v1/apps/${table.app_token}/tables/${table.table_id}/records`,
        params: {
          page_size: '500',
          ...(table.view_id ? { view_id: table.view_id } : {}),
          ...(fieldNames ? { field_names: JSON.stringify(fieldNames) } : {}),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      })

      const data = (response.data ?? {}) as {
        items?: Array<{ record_id: string; fields?: Record<string, unknown> }>
        page_token?: string
      }

      records.push(
        ...(data.items ?? []).map((item) => ({
          record_id: item.record_id,
          fields: item.fields ?? {},
        })),
      )
      this.logger?.info(
        `Fetched source records page ${pageIndex}: ${(data.items ?? []).length} rows (total ${records.length}).`,
      )
      pageToken = data.page_token
      if (!pageToken) {
        break
      }
    }

    return records
  }

  async listFields(table: SyncConfig['target']) {
    const fields: FeishuField[] = []
    let pageToken: string | undefined
    const seenTokens = new Set<string>()
    let pageIndex = 0

    while (true) {
      pageIndex += 1
      const response = await this.request({
        method: 'GET',
        path: `/bitable/v1/apps/${table.app_token}/tables/${table.table_id}/fields`,
        params: {
          page_size: '500',
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      })

      const data = (response.data ?? {}) as {
        items?: Array<Record<string, unknown>>
        fields?: Array<Record<string, unknown>>
        page_token?: string
        has_more?: boolean
      }

      const items = data.items ?? data.fields ?? []
      fields.push(
        ...items
          .filter((item) => item.field_name)
          .map((item) => ({
            field_id: String(item.field_id),
            field_name: String(item.field_name),
            field_type: item.type == null ? null : Number(item.type),
            property:
              item.property && typeof item.property === 'object'
                ? (item.property as Record<string, unknown>)
                : null,
          })),
      )
      this.logger?.info(
        `Fetched target fields page ${pageIndex}: ${items.length} fields (total ${fields.length}).`,
      )

      const nextPageToken = data.page_token
      if (!items.length || !nextPageToken || data.has_more === false || seenTokens.has(nextPageToken)) {
        break
      }

      seenTokens.add(nextPageToken)
      pageToken = nextPageToken
    }

    return fields
  }

  async createRecord(table: SyncConfig['target'], fields: Record<string, unknown>) {
    const response = await this.request({
      method: 'POST',
      path: `/bitable/v1/apps/${table.app_token}/tables/${table.table_id}/records`,
      payload: { fields },
    })
    return String((response.data as { record?: { record_id?: string } })?.record?.record_id ?? '')
  }

  async batchCreateRecords(
    table: SyncConfig['target'],
    fieldsList: Array<Record<string, unknown>>,
  ): Promise<string[]> {
    if (fieldsList.length === 0) return []
    const BATCH_SIZE = 500
    const ids: string[] = []
    for (let i = 0; i < fieldsList.length; i += BATCH_SIZE) {
      const chunk = fieldsList.slice(i, i + BATCH_SIZE)
      const response = await this.request({
        method: 'POST',
        path: `/bitable/v1/apps/${table.app_token}/tables/${table.table_id}/records/batch_create`,
        payload: { records: chunk.map((fields) => ({ fields })) },
      })
      const items = (response.data as { records?: Array<{ record_id?: string }> })?.records ?? []
      for (const item of items) {
        ids.push(String(item.record_id ?? ''))
      }
    }
    return ids
  }

  async batchDeleteRecords(table: SyncConfig['target'], recordIds: string[]) {
    if (recordIds.length === 0) return
    const BATCH_SIZE = 500
    for (let i = 0; i < recordIds.length; i += BATCH_SIZE) {
      const chunk = recordIds.slice(i, i + BATCH_SIZE)
      await this.request({
        method: 'POST',
        path: `/bitable/v1/apps/${table.app_token}/tables/${table.table_id}/records/batch_delete`,
        payload: { records: chunk },
      })
    }
  }

  async updateRecord(table: SyncConfig['target'], recordId: string, fields: Record<string, unknown>) {
    const response = await this.request({
      method: 'PUT',
      path: `/bitable/v1/apps/${table.app_token}/tables/${table.table_id}/records/${recordId}`,
      payload: { fields },
    })
    return String((response.data as { record?: { record_id?: string } })?.record?.record_id ?? '')
  }

  async copyAttachmentToBitable(table: SyncConfig['target'], attachment: Record<string, unknown>) {
    const token = getAttachmentToken(attachment)
    if (!token) {
      throw new Error('Feishu attachment is missing file_token.')
    }

    const downloaded = await this.downloadMedia(token, getAttachmentDownloadUrl(attachment))
    const fileName = getAttachmentName(attachment, token)
    const mimeType = getAttachmentMimeType(attachment, downloaded.contentType)
    const uploadedToken = await this.uploadBitableMedia(table, {
      fileName,
      mimeType,
      data: downloaded.data,
    })
    return { file_token: uploadedToken }
  }

  private async downloadMedia(fileToken: string, downloadUrl: string | null) {
    const response = await fetch(
      downloadUrl ?? `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${await this.getTenantAccessToken()}`,
        },
      },
    )

    if (!response.ok) {
      throw new Error(`Feishu media download failed: ${response.status}`)
    }

    const data = new Uint8Array(await response.arrayBuffer())
    return {
      data,
      contentType: response.headers.get('content-type'),
    }
  }

  private async uploadBitableMedia(
    table: SyncConfig['target'],
    file: { fileName: string; mimeType: string; data: Uint8Array },
  ) {
    const form = new FormData()
    form.set('file_name', file.fileName)
    form.set('parent_type', getBitableMediaParentType(file.mimeType))
    form.set('parent_node', table.app_token)
    form.set('size', String(file.data.byteLength))
    form.set('file', new Blob([Buffer.from(file.data)], { type: file.mimeType }), file.fileName)

    const response = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.getTenantAccessToken()}`,
      },
      body: form,
    })

    if (!response.ok) {
      throw new Error(`Feishu media upload failed: ${response.status}`)
    }

    const payload = (await response.json()) as {
      code?: number
      msg?: string
      data?: { file_token?: string }
    }

    if (payload.code !== 0 || !payload.data?.file_token) {
      throw new Error(`Feishu media upload error ${payload.code}: ${payload.msg}`)
    }

    return payload.data.file_token
  }

  private async request(options: RequestOptions) {
    const url = new URL(`https://open.feishu.cn/open-apis${options.path}`)
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value)
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
    }

    if (options.path !== '/auth/v3/tenant_access_token/internal') {
      headers.Authorization = `Bearer ${await this.getTenantAccessToken()}`
    }

    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.payload ? JSON.stringify(options.payload) : undefined,
    })

    if (!response.ok) {
      throw new Error(`Feishu request failed: ${options.method} ${options.path} (${response.status})`)
    }

    const payload = (await response.json()) as {
      code?: number
      msg?: string
      data?: Record<string, unknown>
      tenant_access_token?: string
    }

    if (payload.code !== 0) {
      throw new Error(`Feishu API error ${payload.code}: ${payload.msg}`)
    }

    return payload
  }

  private async getTenantAccessToken() {
    const cached = this.tokenCache.get('tenant_access_token')
    if (cached) {
      this.logger?.info('Using cached Feishu tenant access token.')
      return cached
    }

    this.logger?.info('Requesting Feishu tenant access token.')
    const payload = await this.request({
      method: 'POST',
      path: '/auth/v3/tenant_access_token/internal',
      payload: {
        app_id: this.config.feishu.app_id,
        app_secret: this.config.feishu.app_secret,
      },
    })

    const token = payload.tenant_access_token
    if (!token) {
      throw new Error('No tenant_access_token returned by Feishu API.')
    }
    this.logger?.info('Feishu tenant access token acquired.')
    return this.tokenCache.set('tenant_access_token', token)
  }
}

function normalizeRecord(record: FeishuRecord): StandardIssueRecord | null {
  const orderNo = normalizeText(record.fields['订单号'])
  if (!orderNo) return null

  // inferMajorIssueType always returns a value now; records without recognized
  // 命中视图 fall into 'other' rather than being dropped from the count.
  const majorIssueType = inferMajorIssueType(record.fields)

  return {
    source_system: 'openclaw_feishu',
    source_subtable: normalizeText(record.fields['命中视图']) ?? '',
    source_record_id: record.record_id,
    major_issue_type: majorIssueType,
    minor_issue_type: inferMinorIssueType(record.fields, majorIssueType),
    order_no: orderNo,
    record_date: parseDate(record.fields['记录日期']),
    order_date: null,
    sku: normalizeText(record.fields['客诉SKU']),
    skc: null,
    spu: null,
    customer_email: normalizeText(record.fields['客户邮箱']),
    country: null,
    solution: normalizeText(record.fields['客诉方案']),
    is_order_level_only: majorIssueType === 'logistics',
    order_line_contexts: [],
    logistics_no: normalizeText(record.fields['物流号']),
    logistics_status: normalizeText(record.fields['物流状态']),
    process_note: normalizeText(record.fields['物流-跟进过程']),
    result_note: normalizeText(record.fields['物流-跟进结果']),
    resolution_note: normalizeText(record.fields['解决方案']),
    status: normalizeText(record.fields['问题处理状态']),
  }
}
