import { useMemo } from 'react'
import {
  ProductBreakdownTable,
  type ProductBreakdownColumn,
  type ProductBreakdownRow,
} from '../../shared/components/ProductBreakdownTable'
import { formatInteger, formatMoney, formatPercent } from '../../shared/utils/format'
import { getMetricDescription } from '../../shared/metricDefinitions'
import type { P3ProductRankingRow } from '../../api/types'

type SortKey = 'refund_qty' | 'refund_amount' | 'sales_qty' | 'complaint_count' | 'complaint_rate'

interface ProductComplaintMetricRow {
  refund_qty: number
  refund_amount: number
  sales_qty: number
  complaint_count: number
  complaint_rate: number
}

interface ProductComplaintRankingProps {
  rows: P3ProductRankingRow[]
  loading: boolean
  error: string
  dateBasis: 'record_date' | 'order_date'
}

const COMPLAINT_RANKING_COPY = {
  record_date: {
    title: '商品客诉登记流入表',
    hint: '登记时间口径：客诉量按飞书登记时间归属；同期销量按下单时间统计，仅作参考分母，登记流入率不是订单 cohort 客诉率。',
    salesQty: '同期销量',
    refundQty: '退款量',
    refundAmount: '退款金额',
    complaintCount: '登记客诉量',
    complaintRate: '登记流入率',
  },
  order_date: {
    title: '商品客诉表现表',
    hint: '订单 cohort 口径：按下单时间圈定商品销售批次，客诉量统计这批订单产生的客诉；客诉率用于判断商品真实客诉风险。',
    salesQty: '同期销量',
    refundQty: '退款量',
    refundAmount: '退款金额',
    complaintCount: '登记客诉量',
    complaintRate: '登记流入率',
  },
} as const

export function ProductComplaintRanking({
  rows,
  loading,
  error,
  dateBasis,
}: ProductComplaintRankingProps) {
  const copy = COMPLAINT_RANKING_COPY[dateBasis]

  const tableRows = useMemo<Array<ProductBreakdownRow<ProductComplaintMetricRow>>>(() => (
    rows.slice(0, 50).map((row) => ({
      id: row.spu,
      spu: row.spu,
      skcLabel: '展开',
      parent: row,
      children: row.children.map((child) => ({
        id: `${row.spu}-${child.skc}`,
        spu: row.spu,
        skc: child.skc,
        row: child,
      })),
    }))
  ), [rows])

  const filterOptions = useMemo(() => {
    const pairs = rows.flatMap((row) => row.children.map((child) => ({ spu: row.spu, skc: child.skc })))
    return {
      pairs,
      spus: [...new Set(pairs.map((item) => item.spu))].sort(),
      skcs: [...new Set(pairs.map((item) => item.skc))].sort(),
    }
  }, [rows])

  const columns: Array<ProductBreakdownColumn<ProductComplaintMetricRow> & { key: SortKey }> = [
    {
      key: 'refund_qty',
      label: copy.refundQty,
      render: (row) => formatInteger(row.refund_qty),
      sortValue: (row) => row.refund_qty ?? 0,
    },
    {
      key: 'refund_amount',
      label: copy.refundAmount,
      render: (row) => formatMoney(row.refund_amount),
      sortValue: (row) => row.refund_amount ?? 0,
    },
    {
      key: 'sales_qty',
      label: copy.salesQty,
      render: (row) => formatInteger(row.sales_qty),
      sortValue: (row) => row.sales_qty ?? 0,
    },
    {
      key: 'complaint_count',
      label: copy.complaintCount,
      render: (row) => formatInteger(row.complaint_count),
      sortValue: (row) => row.complaint_count ?? 0,
    },
    {
      key: 'complaint_rate',
      label: copy.complaintRate,
      render: (row) => formatPercent(row.complaint_rate),
      sortValue: (row) => row.complaint_rate ?? 0,
    },
  ]

  return (
    <ProductBreakdownTable
      title={copy.title}
      note={`${copy.hint} 默认按客诉率倒序展示 Top50 SPU，每页 10 / 20 / 50 条可切换；点击表头列名可切换排序，可展开查看对应 SKC 明细。`}
      rows={tableRows}
      columns={columns}
      defaultSortKey="complaint_rate"
      defaultSortDirection="desc"
      loading={loading}
      error={error}
      loadingText="正在加载商品排行..."
      emptyText="暂无商品排行数据"
      ariaLabel={`${copy.title}分页`}
      filterOptions={filterOptions}
      headerTooltips={{
        refund_qty: getMetricDescription('p2.product_refund_table_refund_qty'),
        refund_amount: getMetricDescription('p2.product_refund_table_refund_amount'),
        sales_qty: getMetricDescription('p3.product_ranking_sales_qty'),
        complaint_count: getMetricDescription('p3.product_ranking_complaint_count'),
        complaint_rate: getMetricDescription('p3.product_ranking_complaint_rate'),
      }}
    />
  )
}
