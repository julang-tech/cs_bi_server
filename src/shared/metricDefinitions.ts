export interface MetricDefinitionItem {
  id: string
  name: string
  short: string
  formula?: string
  detail: string
}

export interface MetricDefinitionSection {
  title: string
  items: MetricDefinitionItem[]
}

export interface MetricDefinitionGroup {
  id: string
  title: string
  description: string
  sections: MetricDefinitionSection[]
}

export const METRIC_DEFINITION_GROUPS: MetricDefinitionGroup[] = [
  {
    id: 'global',
    title: '全局口径',
    description: '所有看板共用的数据时间、历史区间、店铺和金额换算规则。',
    sections: [
      {
        title: '数据时间',
        items: [
          {
            id: 'global.data_ready_cutoff',
            name: '数据截至日期',
            short: '03:00 前按 T-2，03:00 起按 T-1。',
            formula: 'ready_date = 当前日期 - (当前时间 < 03:00 ? 2 天 : 1 天)',
            detail:
              'BigQuery 每天 03:00 回写前 72 小时数据。03:00 前昨日数据可能不完整，因此看板默认截止到 T-2；03:00 起默认截止到 T-1。',
          },
          {
            id: 'global.current_period',
            name: '当前周期',
            short: '昨日 / 近 7 天 / 近 30 天均截止到数据截至日期。',
            formula: '按日=1 天，按周=7 天，按月=30 天',
            detail:
              '当前周期使用滚动窗口，而不是自然周或自然月，避免周初/月初出现当前周期过短或包含未就绪日期。',
          },
          {
            id: 'global.history_range',
            name: '历史区间',
            short: '历史趋势按用户选择的区间和粒度聚合。',
            detail:
              '历史区间不能超过数据截至日期。按周和按月输入会对齐到自然周或自然月边界，末尾周期可能只包含已就绪日期。',
          },
        ],
      },
      {
        title: '店铺与金额',
        items: [
          {
            id: 'global.store_filter',
            name: '店铺筛选',
            short: '全部店铺或单店铺口径，按订单所属 shop_domain 过滤。',
            detail:
              'P2 支持按店铺筛选。选择全部时聚合所有店铺，选择单店铺时仅统计该店铺订单和退款事件。',
          },
          {
            id: 'global.currency_usd',
            name: '金额币种',
            short: '金额统一按 USD 展示。',
            formula: '金额 USD = 原始金额 * 订单 usd_fx_rate',
            detail:
              '多店铺原始交易可能使用不同本币。当前看板金额指标统一换算为 USD，并使用订单事实表里的 usd_fx_rate 进行折算。',
          },
        ],
      },
    ],
  },
  {
    id: 'p1',
    title: 'P1 聊天数据看板',
    description: '客服接待规模、响应效率、未回复存量和坐席工作量相关指标。',
    sections: [
      {
        title: '核心 KPI',
        items: [
          {
            id: 'p1.inbound_email_count',
            name: '来邮数',
            short: '统计周期内进入客服队列的邮件数量。',
            detail: '用于衡量客服入口工作量规模。按所选客服姓名筛选时，只统计该客服相关邮件。',
          },
          {
            id: 'p1.outbound_email_count',
            name: '回邮数',
            short: '统计周期内客服发出的回复邮件数量。',
            detail: '用于衡量客服处理产出。坐席工作量表会进一步按客服拆分回邮效率。',
          },
          {
            id: 'p1.avg_queue_hours',
            name: '平均会话排队时长',
            short: '会话进入队列到首次处理之间的平均等待时长。',
            detail: '数值越高代表客户等待越久，应结合来邮量和坐席产能一起判断。',
          },
          {
            id: 'p1.first_response_timeout_count',
            name: '首次响应超时次数',
            short: '首次响应超过服务目标的会话次数。',
            detail: '用于识别响应 SLA 风险。该指标下降通常代表响应及时性改善。',
          },
          {
            id: 'p1.first_email_count',
            name: '首封邮件数',
            short: '统计周期内首次进入客服链路的邮件数量。',
            detail: '用于观察新增咨询入口量，和来邮总量一起判断重复沟通压力。',
          },
          {
            id: 'p1.unreplied_email_count',
            name: '还没回复数',
            short: '截至统计时点仍未回复的邮件数量。',
            detail: '用于衡量当前待处理积压，应重点关注异常上升。',
          },
        ],
      },
      {
        title: '坐席工作量',
        items: [
          {
            id: 'p1.agent_hourly_reply_span',
            name: '每小时回邮数均值（首末封）',
            short: '按坐席首封到末封时间跨度估算每小时回邮数。',
            detail: '适合观察实际回复节奏，但会受到中途离线、休息或跨班影响。',
          },
          {
            id: 'p1.agent_hourly_reply_schedule',
            name: '每小时回邮数均值（工时表）',
            short: '按排班工时估算每小时回邮数。',
            detail: '适合做坐席间效率对比，前提是工时表数据完整准确。',
          },
        ],
      },
    ],
  },
  {
    id: 'p2',
    title: 'P2 退款情况看板',
    description: '订单、销售、退款规模、退款占比和商品退款表现相关指标。',
    sections: [
      {
        title: '核心 KPI',
        items: [
          {
            id: 'p2.order_count',
            name: '订单数',
            short: '统计周期内符合条件的常规订单数。',
            formula: 'COUNT(DISTINCT regular order_id)',
            detail:
              '排除礼品卡订单，并仅统计常规订单。店铺、商品、上架时间等筛选会影响订单集合。',
          },
          {
            id: 'p2.sales_qty',
            name: '销量',
            short: '统计周期内订单商品行的销售件数。',
            formula: 'SUM(line_item.quantity)',
            detail:
              '排除保险、价差、运费等非商品行，用于衡量真实商品销售件数。',
          },
          {
            id: 'p2.refund_order_count',
            name: '退款订单数',
            short: '统计周期内发生退款事件的订单数量。',
            formula: 'COUNT(DISTINCT refund_event.order_id)',
            detail:
              '退款按退款事件发生日期归因，不按原订单日期归因。一个订单多次退款只计一个退款订单。',
          },
          {
            id: 'p2.refund_amount',
            name: '退款金额',
            short: '统计周期内退款事件金额，统一折算 USD。',
            formula: 'SUM(refund_subtotal * usd_fx_rate)',
            detail:
              '退款金额使用退款事件表，并按关联订单的 usd_fx_rate 折算为 USD。',
          },
          {
            id: 'p2.gmv',
            name: 'GMV',
            short: '订单 GMV，包含 shipping，统一 USD。',
            formula: 'SUM(cs_bi_gmv_usd)',
            detail:
              '口径与财务 ADR-0007 对齐，GMV/revenue 包含 shipping，排除礼品卡订单。',
          },
          {
            id: 'p2.net_received_amount',
            name: '净实付金额',
            short: '客户实际支付收入口径，统一 USD。',
            formula: 'SUM(cs_bi_revenue_usd)',
            detail:
              '用于退款金额占比的分母。口径与财务 ADR-0007 对齐，包含 shipping。',
          },
          {
            id: 'p2.net_revenue_amount',
            name: '净 GMV',
            short: '扣减退款后的净收入口径，统一 USD。',
            formula: 'SUM(cs_bi_net_revenue_usd)',
            detail:
              '用于观察退款后最终收入表现，口径来自订单事实表的净收入字段。',
          },
          {
            id: 'p2.refund_amount_ratio',
            name: '退款金额占比',
            short: '退款金额 / 净实付金额。',
            formula: '退款金额占比 = 退款金额 / 净实付金额',
            detail:
              '用于衡量退款金额相对销售收入的压力。分子按退款日期统计，分母按订单处理日期统计。',
          },
        ],
      },
      {
        title: '商品退款表现表',
        items: [
          {
            id: 'p2.product_refund_table',
            name: '商品退款表现表',
            short: '默认取退款金额 Top20 SPU，再展示排序后的前 5 行。',
            detail:
              '筛选 SPU/SKC 或上架时间后，会按筛选条件查询最多 500 行。SPU/SKC 来自 SKU 解析结果。',
          },
          {
            id: 'p2.refund_qty_ratio',
            name: '退款数占比',
            short: '退款件数 / 销售件数。',
            formula: '退款数占比 = refund_qty / sales_qty',
            detail: '用于观察商品件数维度的退款压力，适合和退款金额占比一起判断。',
          },
        ],
      },
    ],
  },
  {
    id: 'p3',
    title: 'P3 客诉总览看板',
    description: '销量、客诉量、客诉率、问题结构和商品客诉排行相关指标。',
    sections: [
      {
        title: '核心 KPI',
        items: [
          {
            id: 'p3.sales_qty',
            name: '订单数',
            short: '当前页面展示为订单数，底层字段名为 sales_qty。',
            detail:
              '这里存在待确认口径：如果后端 sales_qty 代表销量，页面应改为“销量”；如果要展示订单数，应补充真正 order_count 字段。',
          },
          {
            id: 'p3.complaint_count',
            name: '客诉量',
            short: '统计周期内进入客诉分类的记录数量。',
            detail:
              '用于衡量整体问题规模，可按订单时间或退款时间口径切换。',
          },
          {
            id: 'p3.complaint_rate',
            name: '客诉率',
            short: '客诉量 / 销量。',
            formula: '客诉率 = 客诉量 / 销量',
            detail:
              '用于衡量客诉相对销售规模的压力。分母字段当前来自 summary.sales_qty，后续需跟随 P3 分母口径确认。',
          },
          {
            id: 'p3.issue_product_count',
            name: '产品问题客诉量',
            short: 'major_issue_type = product 的客诉数量。',
            detail: '用于识别产品质量、尺码、描述等商品相关问题。',
          },
          {
            id: 'p3.issue_logistics_count',
            name: '物流问题客诉量',
            short: 'major_issue_type = logistics 的客诉数量。',
            detail: '用于识别运输、配送、丢件、延迟等履约相关问题。',
          },
          {
            id: 'p3.issue_warehouse_count',
            name: '仓库问题客诉量',
            short: 'major_issue_type = warehouse 的客诉数量。',
            detail: '用于识别错发、漏发、仓库处理等发货侧问题。',
          },
        ],
      },
      {
        title: '扩展分析',
        items: [
          {
            id: 'p3.issue_structure',
            name: '问题结构分析',
            short: '按产品、物流、仓库三类展示客诉占比。',
            detail:
              '客诉占比 = 该类客诉量 / 总客诉量。分类客诉率当前按该类客诉量 / 销量估算。',
          },
          {
            id: 'p3.product_ranking',
            name: '商品客诉表现表',
            short: '默认按客诉量展示 Top20 SPU，并可展开 SKC 明细。',
            detail:
              '用于定位客诉集中商品。销量、客诉量和客诉率均使用当前筛选时间口径。',
          },
        ],
      },
    ],
  },
]

const DEFINITION_BY_ID = new Map(
  METRIC_DEFINITION_GROUPS.flatMap((group) =>
    group.sections.flatMap((section) => section.items.map((item) => [item.id, item] as const)),
  ),
)

export function getMetricDefinition(id: string): MetricDefinitionItem | undefined {
  return DEFINITION_BY_ID.get(id)
}

export function getMetricDescription(id: string): string {
  const item = getMetricDefinition(id)
  return item ? `${item.short}${item.formula ? ` ${item.formula}` : ''}` : ''
}
