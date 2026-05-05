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
    description: '所有看板共用的时间、店铺、客服筛选和金额规则。',
    sections: [
      {
        title: '数据时间',
        items: [
          {
            id: 'global.data_ready_cutoff',
            name: '数据截至日期（P2 退款 / P3 客诉）',
            short: '凌晨 3 点前数据看到前天，凌晨 3 点起数据看到昨天。',
            detail:
              'P2 和 P3 的销售、退款数据每天凌晨 3 点统一回写更新（覆盖前 3 天）。所以凌晨 3 点之前看的"昨天"可能还没汇总完，看板会自动退一天展示前天；凌晨 3 点之后展示到昨天。当天的数据要等到次日凌晨才能完整看到。',
          },
          {
            id: 'global.realtime_cutoff',
            name: '数据截至日期（P1 聊天）',
            short: 'P1 邮件数据是实时的，看到的就是当下最新。',
            detail:
              'P1 看板直接读取邮件系统的实时数据，不需要等任何回写。所以"今日 / 本周至今 / 本月至今"是当下时刻的状态——即使是早上 9 点查看，也能看到当天已经发生的所有来邮和回邮。',
          },
          {
            id: 'global.current_period',
            name: '当前周期',
            short: 'P1 看到当下；P2 / P3 看到数据完整的最近一天。',
            detail:
              'P1 因为是实时数据，"当前周期"按日就是"今日"、按周是"本周一到今天"、按月是"本月 1 日到今天"。P2 / P3 因为有数据回写延迟，"当前周期"按日就是"昨天"、按周 / 按月起算到"昨天"。如果今天是周一或月初、当前周 / 月还没有数据，看板会自动退一周 / 一月展示，并把上上周 / 上上月作为同期对比。',
          },
          {
            id: 'global.history_range',
            name: '时间范围',
            short: '可自定义起止日期；不能超过当前数据截至日期。',
            detail:
              '默认范围：按日 = 近 30 天 / 按周 = 近 12 周 / 按月 = 近 6 个月。手动选择时，按周和按月会把起止对齐到完整的一周或一月。如果对齐后超出数据截至日期，结束日期会被截断；最末一个不完整的周 / 月也会按部分日期参与汇总。',
          },
          {
            id: 'global.history_alignment',
            name: '时间粒度对齐规则',
            short: '按周 = 周一到周日；按月 = 月初 1 日到月末。',
            detail:
              '按周时所有数据归到所在周的周一；按月时归到所在月的 1 日。在选择起止日期后，如果点的不是完整周 / 月的边界，看板会自动把起始拉到周一（月初）、结束拉到周日（月末）。',
          },
          {
            id: 'global.shop_timezone',
            name: '订单 / 退款的日期归属（仅 P2）',
            short: 'P2 的"订单日"和"退款日"按店铺所在地时区算，不按 UTC。',
            detail:
              'P2 用的销售和退款数据来自 Shopify，每张订单的"日期"按所属店铺的运营时区算：lintico-fr / 2vnpww-33（US）按北京时间算（CS 在国内运营），lintico-uk 按伦敦时间算。这样"5 月 1 日的订单"和 Shopify 后台 ShopifyQL 看到的口径完全一致，便于跨系统对账。',
          },
        ],
      },
      {
        title: '筛选与金额',
        items: [
          {
            id: 'global.store_filter',
            name: '店铺筛选',
            short: '可选全部店铺或单个店铺（仅 P2 退款看板）。',
            detail:
              'P2 退款看板可按店铺（lc / fr / uk）筛选。选"全部"汇总所有店铺；选单店铺时只统计该店铺的订单和退款。P1 / P3 不区分店铺。',
          },
          {
            id: 'global.agent_filter',
            name: '客服筛选（仅 P1 聊天）',
            short: '可按客服姓名筛选来邮 / 回邮 / 工时；不影响"当前挤压未回"。',
            detail:
              'P1 顶部下拉选择具体客服时，来邮数 / 回邮数 / 平均排队时长会按该客服筛选。"当前挤压未回"因为还没有客服认领，无法归属到具体人，所以选了客服后会显示 0，并附一条说明。',
          },
          {
            id: 'global.currency_usd',
            name: '金额币种（USD）',
            short: '所有金额按美元（USD）展示。',
            detail:
              '不同店铺用不同本币（美元 / 欧元 / 英镑）。P2 看板里的 GMV / 退款金额 / 净实付 / 净 GMV 都按订单当时的汇率折算成美元后再合计，便于跨店铺比较。',
          },
        ],
      },
    ],
  },
  {
    id: 'p1',
    title: 'P1 聊天数据看板',
    description: '客服接待规模、响应速度和坐席工作量。数据接近实时，看到的就是当下。',
    sections: [
      {
        title: '核心 KPI',
        items: [
          {
            id: 'p1.inbound_email_count',
            name: '来邮数',
            short: '统计周期内进入客服队列的客户邮件数。',
            detail:
              '衡量客服入口的工作量规模。选了某个客服时，只统计指派给他的来信。',
          },
          {
            id: 'p1.outbound_email_count',
            name: '回邮数',
            short: '统计周期内客服发出的回复邮件数。',
            detail:
              '衡量客服处理的产出量。下方坐席工作量表会按客服拆分回邮效率（在席时长 / 标准在席时长 / 每小时回信均值 / 质检结果分布）。',
          },
          {
            id: 'p1.avg_queue_hours',
            name: '平均会话排队时长',
            short: '从客户首封来信到客服首次回复之间的平均等待时长（小时）。',
            detail:
              '排队时长越高表示客户等得越久，需要结合来邮量和坐席产能一起判断。仅统计已经开始处理的会话；还没开始处理的进入"当前挤压未回"。',
          },
          {
            id: 'p1.late_reply_count',
            name: '已回复但延迟',
            short: '已经回复了，但首次回复距来信超过 24 小时的邮件数。',
            detail:
              '回看的视角——这些邮件已经处理完，但响应不够及时。和"当前挤压未回"互斥：一个看已经处理完的、一个看还没处理的。',
          },
          {
            id: 'p1.unreplied_count',
            name: '当前挤压未回',
            short: '当下还没回复、已经超过 24 小时、且来信在最近 3 天内的邮件数。',
            detail:
              '即时操作快照，用来识别需要立即处理的积压邮件。**不参与趋势图和同比**——只反映当下扫描的瞬时值。选了具体客服时，因为这些邮件还没认领、无法归属到坐席，会显示 0 并附说明。',
          },
          {
            id: 'p1.avg_unreplied_wait_hours',
            name: '当前挤压平均等待',
            short: '当前挤压未回邮件平均已经等了多少小时（基于扫描时间）。',
            detail:
              '随时间推移，同一批未回邮件的等待时长会自然增长。这个指标也是快照值，**不参与趋势图和同比**。',
          },
        ],
      },
      {
        title: '坐席工作量表',
        items: [
          {
            id: 'p1.agent_name',
            name: '客服姓名 / 坐席均值',
            short: '每行展示一位客服；首行"坐席均值"是下方所有客服的算术平均。',
            detail:
              '坐席均值是简单算术平均（不按回邮数加权），便于看团队内部产能差异。',
          },
          {
            id: 'p1.agent_outbound_email_count',
            name: '总回邮数',
            short: '该客服在统计周期内的回邮总数。',
            detail:
              '与上方 KPI 区"回邮数"同口径，这里按客服分行展示。坐席均值行展示算术平均。',
          },
          {
            id: 'p1.agent_reply_span_hours',
            name: '在席时长',
            short: '该客服首封到末封回信的实际工作时间跨度（小时）。',
            formula: '在席时长 = 当日 / 当周最后一封回信时间 − 第一封回信时间',
            detail:
              '反映客服当天 / 当周实际投入回信的小时数（不是排班工时）。如果客服中午休息了几小时，那段时间也算在内。**和"标准在席时长"对照看**可判断客服比标准节奏快还是慢。',
          },
          {
            id: 'p1.agent_standard_attendance_hours',
            name: '标准在席时长',
            short: '按 30 封 / 小时的团队标准节奏，估算这堆回邮量"应该"花多少小时。',
            formula: '标准在席时长 = 总回邮数 ÷ 30',
            detail:
              '假定客服按团队约定的标准节奏（30 封 / 小时）处理邮件，反映这位客服当天 / 当周的回邮量需要多少标准工时。和实际"在席时长"对比：实际 < 标准 说明节奏比标准快，实际 > 标准 说明慢于标准。',
          },
          {
            id: 'p1.agent_hourly_reply_span',
            name: '每小时回信均值',
            short: '总回邮数 / 在席时长，反映在线时段的产出节奏。',
            formula: '每小时回信均值 = 总回邮数 ÷ 在席时长',
            detail:
              '基于首封到末封的实际跨度，所以不受坐席休息 / 离开影响，纯粹衡量"在线时的产出速度"。',
          },
          {
            id: 'p1.agent_qa_reply_counts',
            name: '质检结果回邮数',
            short: '该客服回邮按质检结果分桶：优秀 / 达标 / 不合格。',
            detail:
              '展示顺序固定为"优秀 / 达标 / 不合格"。坐席均值行展示算术平均（保留小数）。仅统计有质检结果的回邮，没质检的不计入任何桶。',
          },
        ],
      },
    ],
  },
  {
    id: 'p2',
    title: 'P2 退款情况看板',
    description:
      '订单、销售、退款规模、退款占比和商品退款表现。数据来自 Shopify（每天凌晨 3 点回写延迟），口径与公司财务三层模型对齐。',
    sections: [
      {
        title: '核心概念',
        items: [
          {
            id: 'p2.concept_three_layer',
            name: '财务三层模型',
            short: 'GMV → 净实付金额 → 净 GMV：原价 → 扣普通促销折扣 → 再扣退款。',
            detail:
              '看板的 4 个金额指标对应公司财务的三层口径：①GMV（商品折扣前原价 + 运费）→ ②净实付金额（GMV 扣掉普通促销折扣后的销售收入；**CS 客诉代金券不扣**）→ ③净 GMV（净实付再扣退款，运费按净值）。所有金额都含运费、不含税。',
          },
          {
            id: 'p2.concept_cs_voucher',
            name: 'CS 代金券（客诉代金券）',
            short: '客服因客诉给客户发的补偿券。计算"销售收入"时不当作折扣。',
            detail:
              '正常促销折扣（折扣码、满减等）算 GMV 到净实付的"折扣项"。但 CS 客诉补偿券（Manual Discount）是公司主动让出的客户补偿，不应让"销售收入"看起来变小——所以从 GMV 到净实付**只扣普通促销折扣，不扣 CS 代金券**。结果是净实付金额比客户实际刷卡的钱要高，差额就是 CS 代金券。',
          },
          {
            id: 'p2.concept_regular_order',
            name: '常规订单 / 非常规订单',
            short: '订单内**没有** CS 手动加的特殊行（运费补差、价差调整）= 常规订单。',
            detail:
              '"非常规"指订单里有 CS 手动加的特殊 SKU 行：`PRICE ADJUSTMENT`（价差调整）或 `SHIPPINGCOST`（运费补差）。注意保险（Insure02）不算非常规——它是绝大多数订单都附带的 add-on。',
          },
        ],
      },
      {
        title: '核心 KPI',
        items: [
          {
            id: 'p2.order_count',
            name: '订单数',
            short: '统计周期内符合条件的订单去重数。',
            detail:
              '排除礼品卡订单（Shopify 后台 ShopifyQL `sales.orders` 同口径）。店铺和商品筛选会缩小订单集合。',
          },
          {
            id: 'p2.sales_qty',
            name: '销量',
            short: '统计周期内售出的商品件数（每件商品数量之和）。',
            detail:
              '排除非商品行：保险（Insure02 等）、价差调整（PRICE ADJUSTMENT）、运费补差（SHIPPINGCOST）。一单买 2 件 T 恤 + 1 条裤子销量 = 3。',
          },
          {
            id: 'p2.refund_order_count',
            name: '退款订单数',
            short: '统计周期内发生退款事件的订单数（去重）。',
            detail:
              '**按退款实际发生的日期统计**，不按原订单下单日期。一个订单多次退款只算 1 个退款订单。',
          },
          {
            id: 'p2.refund_amount',
            name: '退款金额',
            short: '统计周期内退款金额合计（美元）。',
            detail:
              '按退款实际发生的日期统计，**含退运费**。每张退款单按订单当时的汇率折算成美元后合计。',
          },
          {
            id: 'p2.gmv',
            name: 'GMV',
            short: '商品折扣前原价 + 运费，按美元合计。',
            formula: 'GMV = 商品定价（折扣前原价）+ 运费',
            detail:
              '①层口径：商品的吊牌价（line items 折扣前金额）合计加上运费。可以理解成"如果没有任何折扣，订单总额是多少"。不扣退款，不含税。',
          },
          {
            id: 'p2.net_received_amount',
            name: '净实付金额',
            short: 'GMV 扣掉普通促销折扣后的销售收入，含运费；不扣 CS 代金券。',
            formula: '净实付金额 = GMV − 普通促销折扣 = 客户商品实付 + CS 代金券 + 运费',
            detail:
              '②层口径：客户在普通折扣（折扣码、满减等）后本应支付的金额加运费。**CS 客诉代金券不从这里扣**——因为代金券是公司主动给客户的补偿，不应该算作"折扣"压低销售收入口径。所以这个数比客户实际刷卡的钱要高，差额就是 CS 代金券。是"退款金额占比"的分母。',
          },
          {
            id: 'p2.net_revenue_amount',
            name: '净 GMV',
            short: '净实付金额再扣退款（运费按净值），按美元合计。',
            formula: '净 GMV = 净实付金额（运费按净值）− 退款（仅商品部分）',
            detail:
              '③层口径：在"净实付金额"基础上扣掉退款（仅商品退款），并把运费换成"净运费"（即扣掉退款单里退的运费部分）。反映退款后真正留给公司的金额。',
          },
          {
            id: 'p2.refund_amount_ratio',
            name: '退款金额占比',
            short: '退款金额 / 净实付金额。',
            formula: '退款金额占比 = 退款金额 ÷ 净实付金额',
            detail:
              '衡量退款相对销售收入的压力。**注意分子分母时间口径不同**：分子是这段时间内"发生的退款"，分母是这段时间内"产生的销售"——这两批订单不一定是同一批（退款可能针对几周前的订单）。所以更适合看趋势，绝对值不能精确归因到具体订单。',
          },
        ],
      },
      {
        title: '商品退款表现表',
        items: [
          {
            id: 'p2.product_refund_table',
            name: '商品退款表现表',
            short: '默认按退款金额拉 Top50 SPU；每页可切换 10 / 20 / 50 行；可按 SPU / SKC 筛选。',
            detail:
              '展开 SPU 可见各 SKC 明细。筛选后会按筛选条件重新拉 Top50。SPU = 款（Shopify product），SKC = 款 + 颜色组合。',
          },
          {
            id: 'p2.product_refund_table_sales_qty',
            name: '— 销售件数',
            short: '该 SPU / SKC 在统计周期内的销售件数。',
            detail: '与上方 KPI"销量"同口径（已剔除非商品行），按 SPU / SKC 分组。',
          },
          {
            id: 'p2.product_refund_table_refund_qty',
            name: '— 退款件数',
            short: '该 SPU / SKC 在统计周期内的退款件数。',
            detail: '按退款实际发生日期统计，与"退款订单数"互补（这里看件数）。',
          },
          {
            id: 'p2.product_refund_table_refund_amount',
            name: '— 退款金额',
            short: '该 SPU / SKC 在统计周期内的退款金额（美元）。',
            detail: '与上方 KPI"退款金额"同口径，按 SPU / SKC 分组。默认排序键。',
          },
          {
            id: 'p2.refund_qty_ratio',
            name: '— 退款数占比',
            short: '退款件数 / 销售件数。',
            formula: '退款数占比 = 退款件数 ÷ 销售件数',
            detail: '观察商品件数维度的退款压力，适合和"退款金额占比"一起看。',
          },
        ],
      },
    ],
  },
  {
    id: 'p3',
    title: 'P3 客诉总览看板',
    description: '销量、订单量、客诉量、客诉率，以及问题结构和商品客诉排行。客诉来自 CS 同学在飞书填报的多个客诉登记表。',
    sections: [
      {
        title: '核心 KPI',
        items: [
          {
            id: 'p3.sales_qty',
            name: '销量',
            short: '统计周期内售出的商品款数（一单内同款 SKU 算 1 行）。',
            detail:
              '排除非商品行：保险、运费、价差等。和客诉量同口径，便于直接相除得到客诉率。一单买 2 件同款 T 恤、1 条裤子，销量 = 2（T 恤 1 行 + 裤子 1 行）。',
          },
          {
            id: 'p3.order_count',
            name: '订单量',
            short: '统计周期内的去重订单数。',
            detail:
              '和销量不同：销量按 SKU 行（一单多 SKU 会多行），订单量按订单去重。一单买 2 个不同 SKU，销量 = 2 但订单量 = 1。',
          },
          {
            id: 'p3.complaint_count',
            name: '客诉量',
            short: '统计周期内的客诉数（按订单 + SKU 去重）。',
            detail:
              '同一订单同一 SKU 如果在多个登记表里都被填了（比如先在退款登记、又在瑕疵反馈），合并算 1 条。物流类客诉按订单维度计（一单不论几个 SKU 算 1 条），其它按 SKU 维度。',
          },
          {
            id: 'p3.complaint_rate',
            name: '客诉率',
            short: '客诉量 / 销量。',
            formula: '客诉率 = 客诉量 ÷ 销量',
            detail:
              '分子分母都已剔除非商品行，可直接相除。**注意**：分子按所选时间口径，分母按销售实际日期——切换时间口径只影响分子的归属时间。',
          },
          {
            id: 'p3.issue_product_count',
            name: '产品问题客诉量',
            short: '产品质量、尺码、颜色款式不符等商品相关客诉数。',
            detail: '识别和商品本身有关的问题。',
          },
          {
            id: 'p3.issue_logistics_count',
            name: '物流问题客诉量',
            short: '运输、配送、丢件、延迟等履约相关客诉数。',
            detail: '识别和物流环节有关的问题。',
          },
          {
            id: 'p3.issue_warehouse_count',
            name: '仓库问题客诉量',
            short: '错发、漏发、仓库处理等发货侧客诉数。',
            detail: '识别和仓库 / 发货环节有关的问题。',
          },
          {
            id: 'p3.issue_refund_count',
            name: '退款 / 客户原因客诉量',
            short: '客户主动退款（尺码不合、不喜欢、补发等）的客诉数。',
            detail: '识别非品质 / 履约原因的客户主动退款。',
          },
          {
            id: 'p3.issue_other_count',
            name: '其他客诉量',
            short: '无法归到上述四类的客诉数（兜底分类）。',
            detail: '没有命中任何视图、且备注里也推断不出客诉类型的，统一放到"其他"，避免数据丢失。',
          },
        ],
      },
      {
        title: '时间口径与筛选',
        items: [
          {
            id: 'p3.date_basis',
            name: '时间口径',
            short: '客诉登记时间 / 订单时间 / 退款时间，三选一。',
            detail:
              '**默认 = 客诉登记时间**：CS 在飞书登记表里填的"记录日期"，能看到当天 CS 实际录入的客诉量，最贴近"今天工作了多少"。**订单时间**：客诉关联订单的下单日，但因为客诉总有滞后（订单下了才会有问题、问题反馈也要时间），最近几天会偏低。**退款时间**：客诉关联退款事件的发生日，但只覆盖发起退款的客诉（部分客诉没退款），覆盖率比另外两个口径低。',
          },
          {
            id: 'p3.product_filter',
            name: '商品筛选（SPU / SKC / SKU）',
            short: '可按 SPU / SKC / SKU 任一维度过滤客诉。',
            detail:
              '物流类客诉按订单内的所有商品匹配；其它类按客诉登记时填的商品 SKU 匹配。',
          },
        ],
      },
      {
        title: '问题结构与商品排行',
        items: [
          {
            id: 'p3.issue_structure',
            name: '问题结构分析',
            short: '按 5 类（产品 / 物流 / 仓库 / 退款 / 其他）展示客诉占比，可下钻到对应详情页。',
            formula: '该类占比 = 该类客诉量 ÷ 总客诉量',
            detail:
              '点击占比块可跳转到对应专项页（产品 → P4、仓库 → P5、物流 → P6、退款 → P7、其他 → P8）。',
          },
          {
            id: 'p3.product_ranking',
            name: '商品客诉表现表',
            short: '默认按客诉率倒序展示 Top50 SPU；销量 / 客诉量 / 客诉率列头可点击切换排序；每页可切 10 / 20 / 50 条。',
            detail:
              '已剔除非商品行（保险 / 运费 / 价差）。Top50 拉取仍按上游客诉量排序，前端再按用户选择的列重排。销量、客诉量、客诉率使用当前筛选的时间口径。可展开 SKC 明细。',
          },
          {
            id: 'p3.product_ranking_sales_qty',
            name: '— 销量',
            short: '该 SPU / SKC 在统计周期内的销售款数（SKU 行数）。',
            detail: '与上方 KPI"销量"同口径，按 SPU / SKC 分组。',
          },
          {
            id: 'p3.product_ranking_complaint_count',
            name: '— 客诉量',
            short: '该 SPU / SKC 在统计周期内的客诉数。',
            detail: '物流类客诉按订单内的 SKU 展开后归到对应 SPU / SKC；其它类按客诉登记时填的商品 SKU。',
          },
          {
            id: 'p3.product_ranking_complaint_rate',
            name: '— 客诉率',
            short: '该 SPU / SKC 的客诉量 / 销量。',
            formula: '客诉率 = 客诉量 ÷ 销量',
            detail: '同上方 KPI"客诉率"口径，分子分母均按 SKU 行数。',
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
