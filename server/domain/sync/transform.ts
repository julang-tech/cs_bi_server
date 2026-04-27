import { z } from 'zod'

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
  其他: '其他问题',
}

const VIEW_HIT_MAP: Record<string, string> = {
  产品问题: '1-3待跟进表-货品瑕疵',
  缺货问题: '1-2待跟进表-漏发、发错',
  物流问题: '1-4待跟进表-物流问题',
  错漏发: '1-2待跟进表-漏发、发错',
  瑕疵问题: '1-3待跟进表-货品瑕疵',
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
    const recordDate = parseRecordDate(row['记录日期'])
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

function buildReasonNote(refundReason: string, existingNote: string) {
  const parts = [existingNote.trim(), refundReason.trim() ? `退款原因分类：${refundReason.trim()}` : '']
    .filter(Boolean)
  return parts.join('；')
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

function mapComplaintType(refundReason: string) {
  return COMPLAINT_TYPE_MAP[refundReason] ?? (refundReason ? '其他问题' : '')
}

function inferSolution(operationText: string) {
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

function inferViewHit(refundReason: string, operationText: string) {
  if (operationText.includes('补发')) {
    return ['1-5待跟进表-补发']
  }
  const mapped = VIEW_HIT_MAP[refundReason]
  return mapped ? [mapped] : []
}

export function transformSourceRecord(
  sourceKey: string,
  rawFields: Record<string, unknown>,
): TransformResult {
  const orderNo = stringify(rawFields['订单号'])
  const recordDate = stringify(rawFields['记录日期'])

  if (!orderNo || !recordDate) {
    const missing = []
    if (!orderNo) {
      missing.push('订单号')
    }
    if (!recordDate) {
      missing.push('记录日期')
    }
    return {
      source_key: sourceKey,
      records: [],
      errors: [`missing required fields: ${missing.join(', ')}`],
    }
  }

  const operation = stringify(rawFields['具体操作要求'])
  const refundReason = primaryRefundReason(rawFields['退款原因分类'])
  const existingNote = stringify(rawFields['待跟进客诉备注'] ?? rawFields['备注'])
  const baseRecord: Record<string, unknown> = {
    记录日期: recordDate,
    订单号: orderNo,
    历史订单数: stringify(rawFields['客户订单总数']),
    物流状态: mapLogisticsStatus(rawFields['物流状态']),
    是否退运费: mapRefundFlag(rawFields['是否退运费']),
    是否退运费险: mapRefundFlag(rawFields['是否退运费险']),
    客诉类型: mapComplaintType(refundReason),
    客诉方案: inferSolution(operation),
    '具体金额/操作要求': operation,
    待跟进客诉备注: buildReasonNote(refundReason, existingNote),
    命中视图: inferViewHit(refundReason, operation),
    问题处理状态: '待处理',
    推送状态: 'pending',
    跟进组: '客服组',
  }

  const skus = parseSkus(operation)
  if (!skus.length) {
    return { source_key: sourceKey, records: [baseRecord], errors: [] }
  }

  const records = skus.map((sku) => ({
    ...baseRecord,
    客诉SKU: sku,
  }))

  return { source_key: sourceKey, records, errors: [] }
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
