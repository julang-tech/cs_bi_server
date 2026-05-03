import { z } from 'zod'
import type { TransformerKind } from '../../integrations/sync-config.js'

const SKU_PATTERN = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+){1,}$/

const LOGISTICS_STATUS_MAP: Record<string, string> = {
  未发货: '未发货',
  已发货: '运输途中',
  部分发货: '运输途中',
  发货已拦截: '发货已拦截',
  未发货且标记取消: '未知状态',
}

const REFUND_FLAG_MAP: Record<string, string> = {
  退运费: '是',
  不退运费: '否',
  退运费险: '是',
  不退运费险: '否',
}

const COMPLAINT_TYPE_MAP: Record<string, string> = {
  产品问题: '货品瑕疵-其他',
  '券/折扣问题': '客户原因-折扣码退款',
  缺货问题: '仓库-缺货',
  '订单异常/取消/修改订单': '客户原因-重复下单/下错单取消',
  物流问题: '物流问题-其他',
  错漏发: '仓库-漏发',
  瑕疵问题: '货品瑕疵-其他',
  高风险订单: '高风险订单',
  其他: '客户原因-其他',
}
const COMPLAINT_TYPE_FALLBACK = '客户原因-尺码不合适'

const VIEW_HIT_MAP: Record<string, string> = {
  产品问题: '1-3待跟进表-货品瑕疵',
  瑕疵问题: '1-3待跟进表-货品瑕疵',
  缺货问题: '1-2待跟进表-漏发、发错',
  错漏发: '1-2待跟进表-漏发、发错',
  物流问题: '1-4待跟进表-物流问题',
}
const VIEW_HIT_FALLBACK = '1-1待跟进表-退款'

const VIEW_PRODUCT_DEFECT = '1-3待跟进表-货品瑕疵'
const VIEW_WRONG_SEND = '1-2待跟进表-漏发、发错'
const VIEW_LOGISTICS = '1-4待跟进表-物流问题'
const VIEW_REISSUE = '1-5待跟进表-补发'
const VIEW_REFUND = '1-1待跟进表-退款'

const FOLLOW_UP_TEAM_BY_VIEW: Record<string, string[]> = {
  [VIEW_REFUND]: ['财务组'],
  [VIEW_WRONG_SEND]: ['仓库组'],
  [VIEW_PRODUCT_DEFECT]: ['采购组', 'OEM组', '商品组', '财务组'],
  [VIEW_LOGISTICS]: ['物流组', '财务组'],
  [VIEW_REISSUE]: ['仓库组'],
}

export const SOURCE_FIELD_NAMES = [
  '记录日期',
  '订单号',
  '客户订单总数',
  '物流状态',
  '是否退运费',
  '是否退运费险',
  '退款原因分类',
  '具体操作要求',
  '备注',
] as const

const dateFilterSchema = z.object({
  date: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
})

export type SyncDateFilterInput = z.infer<typeof dateFilterSchema>

export type DateFilter = {
  exact?: string
  start?: string
  end?: string
}

export type TransformResult = {
  source_key: string
  records: Array<Record<string, unknown>>
  errors: string[]
}

/**
 * Looks up valid SKUs for an order from the Shopify cache. Returns null when
 * no lookup is available; returns [] when no matching valid lines exist.
 */
export type OrderSkuLookup = (orderNo: string) => string[] | null

export type TransformContext = {
  /**
   * Optional human-friendly name for the source table (e.g. "退款登记").
   * Used as prefix when merging text fields across sources.
   */
  sourceName?: string
  /**
   * Returns the valid product SKUs for an order from the local cache,
   * filtered to exclude insurance / shipping / price-adjustment lines.
   * If undefined or returns null, transformers fall back to row-level SKUs.
   */
  lookupOrderSkus?: OrderSkuLookup
}

function stringify(value: unknown): string {
  if (value == null) {
    return ''
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => stringify(item))
      .filter(Boolean)
    return parts.join(', ')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return String(record.text ?? record.name ?? '').trim()
  }
  return String(value).trim()
}

function stringifyMulti(value: unknown): string[] {
  if (value == null) {
    return []
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => stringify(item))
      .filter(Boolean)
  }
  const text = stringify(value)
  return text ? [text] : []
}

function joinNonEmpty(parts: Array<string | undefined | null>, separator = ' | ') {
  return parts.map((part) => (part == null ? '' : String(part).trim())).filter(Boolean).join(separator)
}

function formatDateParts(year: number, month: number, day: number) {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function tryParseDateText(raw: string) {
  const text = raw.trim()
  if (!text) {
    return null
  }

  const match = text.match(/^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/)
  if (!match) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }
  return formatDateParts(year, month, day)
}

function parseCliDate(raw: string, fieldName: string) {
  const parsed = tryParseDateText(raw)
  if (!parsed) {
    throw new Error(`Invalid ${fieldName}: ${raw}. Expected YYYY-MM-DD or YYYY/MM/DD.`)
  }
  return parsed
}

export function buildDateFilter(input: SyncDateFilterInput): DateFilter | null {
  const parsed = dateFilterSchema.parse(input)
  if (parsed.date && (parsed.from || parsed.to)) {
    throw new Error('Use either --date or --from/--to, not both.')
  }

  const exact = parsed.date ? parseCliDate(parsed.date, '--date') : undefined
  const start = parsed.from ? parseCliDate(parsed.from, '--from') : undefined
  const end = parsed.to ? parseCliDate(parsed.to, '--to') : undefined

  if (start && end && start > end) {
    throw new Error('--from cannot be later than --to.')
  }

  if (!exact && !start && !end) {
    return null
  }

  return { exact, start, end }
}

export function parseRecordDate(rawValue: unknown): string | null {
  if (rawValue == null) {
    return null
  }
  if (typeof rawValue === 'number') {
    let timestamp = rawValue
    if (timestamp > 10_000_000_000) {
      timestamp /= 1000
    }
    const date = new Date(timestamp * 1000)
    return formatDateParts(date.getFullYear(), date.getMonth() + 1, date.getDate())
  }
  if (Array.isArray(rawValue)) {
    for (const item of rawValue) {
      const parsed = parseRecordDate(item)
      if (parsed) {
        return parsed
      }
    }
    return null
  }
  if (typeof rawValue === 'object') {
    const record = rawValue as Record<string, unknown>
    for (const key of ['value', 'timestamp', 'time', 'date']) {
      if (key in record) {
        return parseRecordDate(record[key])
      }
    }
    return null
  }

  const text = String(rawValue).trim()
  if (!text) {
    return null
  }
  if (/^\d+$/.test(text)) {
    return parseRecordDate(Number(text))
  }
  return tryParseDateText(text)
}

export function filterRowsByDate<T extends Record<string, unknown>>(
  rows: Array<[string, T]>,
  dateFilter: DateFilter | null,
) {
  if (!dateFilter) {
    return rows
  }

  return rows.filter(([, row]) => {
    const recordDate =
      parseRecordDate(row['记录日期']) ??
      parseRecordDate(row['日期']) ??
      parseRecordDate(row['反馈日期'])
    if (!recordDate) {
      return false
    }
    if (dateFilter.exact && recordDate !== dateFilter.exact) {
      return false
    }
    if (dateFilter.start && recordDate < dateFilter.start) {
      return false
    }
    if (dateFilter.end && recordDate > dateFilter.end) {
      return false
    }
    return true
  })
}

function parseSkus(operationText: string) {
  if (!operationText.trim()) {
    return []
  }
  return operationText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => SKU_PATTERN.test(line))
}

function mapLogisticsStatus(value: unknown) {
  const text = stringify(value)
  return LOGISTICS_STATUS_MAP[text] ?? text
}

function mapRefundFlag(value: unknown) {
  const text = stringify(value)
  return REFUND_FLAG_MAP[text] ?? text
}

function primaryRefundReason(value: unknown) {
  const text = stringify(value)
  if (!text) {
    return ''
  }
  return text.split(',').find((part) => part.trim())?.trim() ?? text
}

function mapRefundComplaintType(refundReason: string) {
  if (!refundReason) {
    return COMPLAINT_TYPE_FALLBACK
  }
  return COMPLAINT_TYPE_MAP[refundReason] ?? COMPLAINT_TYPE_FALLBACK
}

function inferSolutionFromOperation(operationText: string) {
  const text = operationText.trim()
  if (!text) {
    return []
  }
  if (text.includes('补发')) {
    return ['补发']
  }
  if (text.includes('退全款') || text.includes('全额退款')) {
    return ['全额退款']
  }
  if (text.includes('退款') || text.includes('退')) {
    return ['部分退款']
  }
  return ['退款跟进']
}

function inferRefundViewHit(refundReason: string, operationText: string) {
  if (operationText.includes('补发')) {
    return [VIEW_REISSUE]
  }
  return [VIEW_HIT_MAP[refundReason] ?? VIEW_HIT_FALLBACK]
}

/**
 * View-driven follow-up team. Returns the union of teams across all hit
 * views, deduped and order-preserving. Falls back to ['客服组'] when no
 * view matches a known mapping.
 */
export function inferFollowUpTeam(hitViews: string[]): string[] {
  const seen = new Set<string>()
  const teams: string[] = []
  for (const view of hitViews) {
    const mapped = FOLLOW_UP_TEAM_BY_VIEW[view]
    if (!mapped) continue
    for (const team of mapped) {
      if (!seen.has(team)) {
        seen.add(team)
        teams.push(team)
      }
    }
  }
  if (!teams.length) {
    return ['客服组']
  }
  return teams
}

/**
 * Heuristic complaint-type inference from free-text + the resolved hit view.
 * - Logistics view: 物流问题-超期 / 物流问题-丢包 / 物流问题-地址 / 物流问题-其他
 * - Product defect view: 货品瑕疵-缝线 / 扣子 / 破洞 / 色差 / 尺码 / 其他
 * - Wrong-send view: 仓库-漏发 vs 仓库-发错SKU
 * - Otherwise: 客户原因-尺码不合适 / 客户原因-款式不喜欢 / fallback 尺码不合适
 */
export function inferComplaintTypeFromText(text: string, hitView?: string): string {
  const normalized = (text ?? '').toLowerCase()

  if (hitView === VIEW_LOGISTICS) {
    if (/(超期|超时|超过|delay|late)/i.test(normalized)) {
      return '物流问题-超期'
    }
    if (/(丢包|丢失|丢件|包裹丢|lost|missing\s*package|未送达|未收到)/i.test(normalized)) {
      return '物流问题-丢包'
    }
    if (/(地址|address|改地址|wrong\s*address)/i.test(normalized)) {
      return '物流问题-地址'
    }
    return '物流问题-其他'
  }

  if (hitView === VIEW_PRODUCT_DEFECT) {
    if (/(缝线|开线|线头|stitch|seam)/i.test(normalized)) return '货品瑕疵-缝线'
    if (/(扣子|button|拉链|zipper)/i.test(normalized)) return '货品瑕疵-扣子'
    if (/(破洞|hole|tear|破损|破)/i.test(normalized)) return '货品瑕疵-破洞'
    if (/(色差|颜色不对|color\s*off|不一样的颜色|discolor)/i.test(normalized)) return '货品瑕疵-色差'
    if (/(尺码|size\s*wrong|too\s*(large|small|big|tight|loose)|码数)/i.test(normalized)) {
      return '货品瑕疵-尺码'
    }
    return '货品瑕疵-其他'
  }

  if (hitView === VIEW_WRONG_SEND) {
    if (/(漏发|少发|missing\s*item|没收到|没寄|缺件)/i.test(normalized)) {
      return '仓库-漏发'
    }
    return '仓库-发错SKU'
  }

  // Generic customer-reason inference (used by reissue / manual-return / refund fallbacks).
  if (/(size|fit|尺码|too\s*large|too\s*small|loose|tight|码|大|小)/i.test(normalized)) {
    return '客户原因-尺码不合适'
  }
  if (/(style|款式|color|颜色|don'?t\s*like|dislike|不喜欢)/i.test(normalized)) {
    return '客户原因-款式不喜欢'
  }
  return COMPLAINT_TYPE_FALLBACK
}

function buildBaseRecord(view: string[]): Record<string, unknown> {
  return {
    命中视图: view,
    问题处理状态: '待处理',
    推送状态: 'pending',
    跟进组: inferFollowUpTeam(view),
  }
}

function fanOutBySkus(
  baseRecord: Record<string, unknown>,
  skus: string[],
  fallbackSku?: string,
): Array<Record<string, unknown>> {
  if (!skus.length) {
    return [
      fallbackSku
        ? { ...baseRecord, 客诉SKU: fallbackSku }
        : { ...baseRecord },
    ]
  }
  return skus.map((sku) => ({ ...baseRecord, 客诉SKU: sku }))
}

// ---------- 1. 退款登记 ----------

function transformRefundLog(
  sourceKey: string,
  rawFields: Record<string, unknown>,
  context: TransformContext,
): TransformResult {
  const orderNo = stringify(rawFields['订单号'])
  const recordDate = stringify(rawFields['记录日期'])

  const missing: string[] = []
  if (!orderNo) missing.push('订单号')
  if (!recordDate) missing.push('记录日期')
  if (missing.length) {
    return { source_key: sourceKey, records: [], errors: [`missing required fields: ${missing.join(', ')}`] }
  }

  const operation = stringify(rawFields['具体操作要求'])
  const refundReason = primaryRefundReason(rawFields['退款原因分类'])
  const note = stringify(rawFields['备注'])
  const view = inferRefundViewHit(refundReason, operation)
  const baseRecord: Record<string, unknown> = {
    ...buildBaseRecord(view),
    记录日期: recordDate,
    订单号: orderNo,
    历史订单数: stringify(rawFields['客户订单总数']),
    物流状态: mapLogisticsStatus(rawFields['物流状态']),
    是否退运费: mapRefundFlag(rawFields['是否退运费']),
    是否退运费险: mapRefundFlag(rawFields['是否退运费险']),
    客诉类型: mapRefundComplaintType(refundReason),
    客诉方案: inferSolutionFromOperation(operation),
    '具体金额/操作要求': operation,
    待跟进客诉备注: note,
  }

  const refundReceipt = stringify(rawFields['是否收到退货/退货单据'])
  if (refundReceipt) {
    baseRecord['退货单号'] = refundReceipt
  }

  const creator = stringify(rawFields['创建人'])
  if (creator) {
    baseRecord['客服跟进人'] = creator
  }

  const skus = parseSkus(operation)
  const records = fanOutBySkus(baseRecord, skus)
  return { source_key: sourceKey, records, errors: [] }
}

// ---------- 2. 6美元补发 ----------

function transformReissue6Usd(
  sourceKey: string,
  rawFields: Record<string, unknown>,
  context: TransformContext,
): TransformResult {
  const orderNo = stringify(rawFields['原订单号']) || stringify(rawFields['订单号'])
  const recordDate = stringify(rawFields['日期']) || stringify(rawFields['记录日期'])
  const missing: string[] = []
  if (!orderNo) missing.push('原订单号')
  if (!recordDate) missing.push('日期')
  if (missing.length) {
    return { source_key: sourceKey, records: [], errors: [`missing required fields: ${missing.join(', ')}`] }
  }

  const reasons = stringifyMulti(rawFields['客诉原因'])
  const reasonText = reasons.join(' | ')
  const view = [VIEW_REISSUE]
  const sku = stringify(rawFields['需补发SKU'])
  const reissueOrderNo = stringify(rawFields['补发订单号'])
  const customer = stringify(rawFields['客户姓名'])
  const creator = stringify(rawFields['创建人'])
  const baseRecord: Record<string, unknown> = {
    ...buildBaseRecord(view),
    记录日期: recordDate,
    订单号: orderNo,
    客诉类型: inferComplaintTypeFromText(reasonText),
    客诉方案: ['6美元补发'],
    待跟进客诉备注: reasonText,
  }
  if (sku) baseRecord['客诉SKU'] = sku
  if (reissueOrderNo) baseRecord['补发订单号'] = reissueOrderNo
  if (customer) baseRecord['客户姓名'] = customer
  if (creator) baseRecord['客服跟进人'] = creator

  return { source_key: sourceKey, records: [baseRecord], errors: [] }
}

// ---------- 3. 手工退货 ----------

function transformManualReturn(
  sourceKey: string,
  rawFields: Record<string, unknown>,
  context: TransformContext,
): TransformResult {
  const orderNo = stringify(rawFields['订单号'])
  const recordDate = stringify(rawFields['记录日期'])
  const missing: string[] = []
  if (!orderNo) missing.push('订单号')
  if (!recordDate) missing.push('记录日期')
  if (missing.length) {
    return { source_key: sourceKey, records: [], errors: [`missing required fields: ${missing.join(', ')}`] }
  }

  const reasons = stringifyMulti(rawFields['客诉原因'])
  const measurements = stringify(rawFields['顾客三围信息'])
  const reasonText = reasons.join(' | ')
  const note = joinNonEmpty([reasonText, measurements ? `三围：${measurements}` : ''], ' | ')
  const view = [VIEW_REFUND]
  const sku = stringify(rawFields['客诉SKU'])
  const creator = stringify(rawFields['创建人']) || stringify(rawFields['反馈人'])

  const baseRecord: Record<string, unknown> = {
    ...buildBaseRecord(view),
    记录日期: recordDate,
    订单号: orderNo,
    客诉类型: inferComplaintTypeFromText(reasonText),
    客诉方案: ['全额退款'],
    待跟进客诉备注: note,
  }
  if (sku) baseRecord['客诉SKU'] = sku
  if (creator) baseRecord['客服跟进人'] = creator

  return { source_key: sourceKey, records: [baseRecord], errors: [] }
}

// ---------- 4. 瑕疵反馈 ----------

function transformDefectFeedback(
  sourceKey: string,
  rawFields: Record<string, unknown>,
  context: TransformContext,
): TransformResult {
  const orderNo = stringify(rawFields['订单号'])
  const recordDate = stringify(rawFields['反馈日期']) || stringify(rawFields['记录日期'])
  const missing: string[] = []
  if (!orderNo) missing.push('订单号')
  if (!recordDate) missing.push('反馈日期')
  if (missing.length) {
    return { source_key: sourceKey, records: [], errors: [`missing required fields: ${missing.join(', ')}`] }
  }

  const description = stringify(rawFields['瑕疵说明'])
  const sku = stringify(rawFields['产品sku']) || stringify(rawFields['产品SKU'])
  const shippedAt = stringify(rawFields['订单发货时间'])
  const view = [VIEW_PRODUCT_DEFECT]
  const inferredType = inferComplaintTypeFromText(description, VIEW_PRODUCT_DEFECT)
  const reporter = stringify(rawFields['反馈人'])
  const creator = stringify(rawFields['创建人']) || reporter

  const baseRecord: Record<string, unknown> = {
    ...buildBaseRecord(view),
    记录日期: recordDate,
    订单号: orderNo,
    客诉类型: inferredType,
    客诉方案: description ? ['补发'] : ['全额退款'],
    待跟进客诉备注: description,
  }
  if (sku) baseRecord['客诉SKU'] = sku
  if (shippedAt) baseRecord['订单发货时间'] = shippedAt
  if (creator) baseRecord['客服跟进人'] = creator

  return { source_key: sourceKey, records: [baseRecord], errors: [] }
}

// ---------- 5. 错发反馈 ----------

function transformWrongSendFeedback(
  sourceKey: string,
  rawFields: Record<string, unknown>,
  context: TransformContext,
): TransformResult {
  const orderNo = stringify(rawFields['订单号'])
  const recordDate = stringify(rawFields['反馈日期']) || stringify(rawFields['记录日期'])
  const missing: string[] = []
  if (!orderNo) missing.push('订单号')
  if (!recordDate) missing.push('反馈日期')
  if (missing.length) {
    return { source_key: sourceKey, records: [], errors: [`missing required fields: ${missing.join(', ')}`] }
  }

  const description = stringify(rawFields['错发说明'])
  const sku = stringify(rawFields['产品sku']) || stringify(rawFields['产品SKU'])
  const shippedAt = stringify(rawFields['订单发货时间'])
  const view = [VIEW_WRONG_SEND]
  const inferredType = inferComplaintTypeFromText(description, VIEW_WRONG_SEND)
  const reporter = stringify(rawFields['反馈人'])
  const creator = stringify(rawFields['创建人']) || reporter

  const baseRecord: Record<string, unknown> = {
    ...buildBaseRecord(view),
    记录日期: recordDate,
    订单号: orderNo,
    客诉类型: inferredType,
    客诉方案: description ? ['补发'] : ['全额退款'],
    待跟进客诉备注: description,
  }
  if (sku) baseRecord['客诉SKU'] = sku
  if (shippedAt) baseRecord['订单发货时间'] = shippedAt
  if (creator) baseRecord['客服跟进人'] = creator

  return { source_key: sourceKey, records: [baseRecord], errors: [] }
}

// ---------- 6. 物流问题 ----------

function transformLogisticsIssue(
  sourceKey: string,
  rawFields: Record<string, unknown>,
  context: TransformContext,
): TransformResult {
  const orderNo = stringify(rawFields['订单号'])
  const recordDate = stringify(rawFields['日期']) || stringify(rawFields['记录日期'])
  const missing: string[] = []
  if (!orderNo) missing.push('订单号')
  if (!recordDate) missing.push('日期')
  if (missing.length) {
    return { source_key: sourceKey, records: [], errors: [`missing required fields: ${missing.join(', ')}`] }
  }

  const issueText = stringify(rawFields['物流问题'])
  const followUpProcess = joinNonEmpty([
    stringify(rawFields['跟进1']),
    stringify(rawFields['跟进2']),
  ])
  const trackingNo = stringify(rawFields['物流号'])
  const view = [VIEW_LOGISTICS]
  const baseRecord: Record<string, unknown> = {
    ...buildBaseRecord(view),
    记录日期: recordDate,
    订单号: orderNo,
    客诉类型: inferComplaintTypeFromText(issueText, VIEW_LOGISTICS),
    待跟进客诉备注: issueText,
    '物流-跟进过程': followUpProcess,
    '物流-跟进结果': '',
  }
  if (trackingNo) baseRecord['物流号'] = trackingNo

  // Logistics rows have no SKU → fan out per Shopify cache lines.
  const skus = context.lookupOrderSkus?.(orderNo) ?? null
  const records = skus && skus.length ? fanOutBySkus(baseRecord, skus) : [baseRecord]
  return { source_key: sourceKey, records, errors: [] }
}

const TRANSFORMERS: Record<TransformerKind, (
  sourceKey: string,
  rawFields: Record<string, unknown>,
  context: TransformContext,
) => TransformResult> = {
  refund_log: transformRefundLog,
  reissue_6usd: transformReissue6Usd,
  manual_return: transformManualReturn,
  defect_feedback: transformDefectFeedback,
  wrong_send_feedback: transformWrongSendFeedback,
  logistics_issue: transformLogisticsIssue,
}

/**
 * Dispatches to the right per-source transformer. Defaults to refund_log when
 * the kind is omitted to preserve back-compat with the legacy single-source path.
 */
export function transformSourceRecord(
  sourceKey: string,
  rawFields: Record<string, unknown>,
  kindOrContext: TransformerKind | TransformContext = 'refund_log',
  contextArg: TransformContext = {},
): TransformResult {
  let kind: TransformerKind
  let context: TransformContext
  if (typeof kindOrContext === 'string') {
    kind = kindOrContext
    context = contextArg
  } else {
    kind = 'refund_log'
    context = kindOrContext
  }
  const transformer = TRANSFORMERS[kind] ?? transformRefundLog
  return transformer(sourceKey, rawFields, context)
}

export function summarizeResults(results: TransformResult[]) {
  const generatedRecords = results.reduce((sum, result) => sum + result.records.length, 0)
  const failedSources = results
    .filter((result) => result.errors.length > 0)
    .map((result) => ({
      source_key: result.source_key,
      errors: result.errors,
    }))

  return {
    source_rows: results.length,
    generated_records: generatedRecords,
    failed_sources: failedSources,
  }
}

// ===== Cross-source merge =====

const MULTI_SELECT_FIELDS = new Set(['命中视图', '客诉方案', '跟进组'])
const TEXT_CONCAT_FIELDS = new Set(['待跟进客诉备注', '物流-跟进过程', '物流-跟进结果', '具体金额/操作要求'])

function arrayUnion(existing: unknown, incoming: unknown): unknown[] {
  const set = new Set<string>()
  const result: unknown[] = []
  for (const item of [...(Array.isArray(existing) ? existing : existing != null ? [existing] : []), ...(Array.isArray(incoming) ? incoming : incoming != null ? [incoming] : [])]) {
    const key = stringify(item)
    if (!key || set.has(key)) continue
    set.add(key)
    result.push(item)
  }
  return result
}

function isEmpty(value: unknown): boolean {
  if (value == null) return true
  if (Array.isArray(value)) return value.length === 0 || value.every(isEmpty)
  return stringify(value) === ''
}

type SourceTaggedRecord = {
  sourceName: string
  transformerKind: TransformerKind
  record: Record<string, unknown>
}

/**
 * Merges multiple records sharing (order_no, sku) across sources. Multi-select
 * fields are unioned, text fields are concatenated with `[<source>] ` prefixes,
 * 客诉类型 prefers non-退款登记 sources (since refund_log uses a coarser fallback).
 */
export function mergeRecordsByOrderAndSku(
  records: SourceTaggedRecord[],
): Array<Record<string, unknown>> {
  if (records.length === 0) return []

  const groups = new Map<string, SourceTaggedRecord[]>()
  const order: string[] = []
  // Records missing 客诉SKU stay distinct: collapsing them by order_no alone
  // would silently drop separate complaints (e.g. logistics rows without a
  // resolved Shopify SKU). Give each such record a unique synthetic key so
  // the merge loop falls through to the single-record path.
  let unmergeableCounter = 0
  for (const tagged of records) {
    const orderNo = stringify(tagged.record['订单号'])
    const sku = stringify(tagged.record['客诉SKU'])
    const key = sku
      ? `${orderNo}\u0000${sku}`
      : `\u0000__nosku__\u0000${unmergeableCounter++}`
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(tagged)
  }

  const merged: Array<Record<string, unknown>> = []
  for (const key of order) {
    const group = groups.get(key)!
    if (group.length === 1) {
      merged.push(group[0].record)
      continue
    }

    const out: Record<string, unknown> = {}
    const textParts = new Map<string, string[]>()
    for (const { record, sourceName, transformerKind } of group) {
      for (const [field, value] of Object.entries(record)) {
        if (MULTI_SELECT_FIELDS.has(field)) {
          out[field] = arrayUnion(out[field], value)
          continue
        }
        if (TEXT_CONCAT_FIELDS.has(field)) {
          const text = stringify(value)
          if (!text) continue
          const buckets = textParts.get(field) ?? []
          buckets.push(`[${sourceName}] ${text}`)
          textParts.set(field, buckets)
          continue
        }
        if (field === '客诉类型') {
          // Non-refund_log wins over refund_log's coarser default.
          const incoming = stringify(value)
          if (!incoming) continue
          const current = stringify(out[field])
          if (!current) {
            out[field] = value
            ;(out as Record<string, unknown>)['__客诉类型_kind__'] = transformerKind
            continue
          }
          const currentKind = (out as Record<string, unknown>)['__客诉类型_kind__'] as TransformerKind | undefined
          if (currentKind === 'refund_log' && transformerKind !== 'refund_log') {
            out[field] = value
            ;(out as Record<string, unknown>)['__客诉类型_kind__'] = transformerKind
          }
          continue
        }
        // Default: first non-empty wins.
        if (isEmpty(out[field]) && !isEmpty(value)) {
          out[field] = value
        }
      }
    }
    for (const [field, parts] of textParts) {
      out[field] = parts.join(' | ')
    }
    delete (out as Record<string, unknown>)['__客诉类型_kind__']
    merged.push(out)
  }

  return merged
}
