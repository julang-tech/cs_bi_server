# BigQuery / 时间口径 接力文档

## 当前目标

下一个会话要继续做两件事：

1. 替换当前 P3 使用的 BigQuery 数据表
2. 给 P3 增加“查询时间口径”能力，明确到底按哪种日期过滤和聚合

这份文档用于让新会话快速接手，不需要重新摸代码。

## 当前实现现状

### 1. 当前 BigQuery 代码入口

核心文件：

- [server/integrations/bigquery.ts](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/server/integrations/bigquery.ts:1)
- [server/domain/p3/compute.ts](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/server/domain/p3/compute.ts:1)
- [server/domain/p3/models.ts](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/server/domain/p3/models.ts:1)
- [server/domain/p3/service.ts](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/server/domain/p3/service.ts:1)

### 2. 当前 BigQuery 用到的表

#### 订单数汇总 / 趋势

`BigQuerySalesRepository` 当前直接查这些表：

- `julang-dev-database.shopify_dwd.dwd_orders_fact`
- `julang-dev-database.product_information_database.dim_product_sku`

当前分母口径基于：

- `o.processed_date`
- `COUNT(*)`

过滤条件：

- `o.processed_date BETWEEN @date_from AND @date_to`
- `sku / skc / spu` 维度过滤

#### 订单补充

`BigQueryOrderEnrichmentRepository` 当前也查：

- `julang-dev-database.shopify_dwd.dwd_orders_fact`
- `julang-dev-database.shopify_dwd.dwd_refund_events`
- `julang-dev-database.product_information_database.dim_product_sku`

当前补充字段：

- `order_date` 取 `o.processed_date`
- `refund_date` 取 `dwd_refund_events.refund_date`
- `line_items`
- `skc / spu`

## 当前时间口径

### 1. 当前接口可传的只有聚合粒度，不可传“时间字段口径”

当前 `P3Filters` 定义在 [server/domain/p3/models.ts](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/server/domain/p3/models.ts:1)：

- `date_from`
- `date_to`
- `grain`
- `date_basis`
- `sku / skc / spu`

当前前后端已经支持显式切换：

- `date_basis = order_date`
- `date_basis = refund_date`

### 2. 当前实际生效的是两套时间口径混用

#### 分母

分母永远按：

- `order processed_date`
- `COUNT(*)`

#### 客诉

客诉最终进入面板时，默认按：

- `issue.order_date`

`filterIssues()` 在 [server/domain/p3/compute.ts](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/server/domain/p3/compute.ts:1) 里有硬过滤：

- `date_basis = order_date` 时看 `issue.order_date`
- `date_basis = refund_date` 时看 `issue.refund_date`

### 3. 最近已做的修复

在 [server/integrations/bigquery.ts](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/server/integrations/bigquery.ts:1) 里：

- 如果 BigQuery 补不到订单上下文
- 不再丢掉这条客诉
- 会保留 issue，并把 `order_date` 回退成 `record_date`
- `refund_date` 仅在命中退款事件时补充

这解决了“面板全 0”的一部分问题，但没有解决“查询时间口径不明确”的根本问题。

## 当前已观察到的业务问题

### 1. 面板上的“天 / 周”容易让人误解

现在页面看起来像是在看：

- 今天新增多少客诉
- 本周新增多少客诉

但后端实际更接近：

- 这段时间内下单的订单，对应的客诉有多少

所以业务理解和系统实现之间有偏差。

### 2. 客诉量和销量分母的时间轴不一定一致

当前看板的 `complaint_rate = complaint_count / sales_qty`

但：

- `sales_qty` 字段名保留，但语义已经改为订单数
- `complaint_count` 会按 `date_basis` 过滤

如果后续要把“查询时间口径”做成可切换，就必须决定：

- 客诉量按什么日期过滤
- 销量按什么日期过滤
- 客诉率的分母分子是否必须共享同一口径

## 下个会话建议的改动方向

### 1. 已确认的新 BigQuery 表

- 订单表：`julang-dev-database.shopify_dwd.dwd_orders_fact`
- 退款表：`julang-dev-database.shopify_dwd.dwd_refund_events`
- 商品映射维表：`julang-dev-database.product_information_database.dim_product_sku`

最直接改动点：

- `BigQuerySalesRepository.fetchSummary()`
- `BigQuerySalesRepository.fetchTrends()`
- `BigQueryOrderEnrichmentRepository.fetchOrderContexts()`
- `BigQueryOrderEnrichmentRepository.fetchRefundContexts()`

### 2. 再加“查询时间口径”

当前实现使用：

- `date_basis: 'order_date' | 'refund_date'`

然后至少改这几个地方：

- [server/domain/p3/models.ts](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/server/domain/p3/models.ts:1)
  增加 filter 类型
- [server/entrypoints/app.ts](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/server/entrypoints/app.ts:1)
  扩展 query schema
- [src/api/p3.js](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/src/api/p3.js:1)
  传递新参数
- [src/App.jsx](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/src/App.jsx:1)
  增加前端口径切换入口
- [server/domain/p3/compute.ts](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/server/domain/p3/compute.ts:1)
  让 `filterIssues()` 和 bucket 逻辑按 `date_basis` 取日期字段
- [server/integrations/bigquery.ts](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/server/integrations/bigquery.ts:1)
  明确 enrichment 只负责补充，不要隐式决定最终统计口径

### 3. 推荐的实现策略

建议把“用于过滤和分桶的日期”显式抽成一个 helper，例如：

- `resolveIssueQueryDate(issue, filters)`

逻辑示例：

- `date_basis = 'order_date'` 时优先用 `issue.order_date`
- `date_basis = 'refund_date'` 时优先用 `issue.refund_date`
- `order_date` 缺失时回退 `record_date`

这样能把“查询时间口径”从当前的隐式行为变成显式规则。

## 新会话需要特别确认的产品决策

开始动代码前，建议先确认下面这些点：

1. 看板总览的“日 / 周 / 月”到底想看哪种时间：
   - 客诉记录创建时间
   - 订单下单时间
   - 或两者可切换

2. `complaint_rate` 的分母分子是否必须同口径：
   - 如果客诉按 `record_date`
   - 销量是否也要切成同周期的某种口径

3. drilldown 的原因 / 商品 / 订单样本是否也跟随同一个 `date_basis`

4. 新 BigQuery 表已确认：
   - `dwd_orders_fact` 无 `country`
   - `dwd_orders_fact` 无显式销售件数字段
   - 分母已改为订单数
   - `spu` 仍需依赖 `dim_product_sku`

## 当前已知的代码事实

1. 当前 `filterIssues()` 已按 `date_basis` 选 `order_date / refund_date`
2. 当前 SQLite mirror 自身并不存标准化后的 `refund_date` 维度，需要运行时补
3. 当前 BigQuery enrichment 会保留查不到订单上下文的 issue，并回退 `record_date`
4. 当前接口需继续保持 `sales_qty` 字段名兼容，但语义已改为订单数

## 建议新会话开场提示

可以直接把下面这段贴给新会话：

```text
请基于 docs/bigquery-handoff-2026-04-27.md 继续。
本次目标：
1. 替换 server/integrations/bigquery.ts 里的 BigQuery 数据表
2. 给 P3 增加查询时间口径字段（至少支持 order_date / record_date）
3. 保证前后端都能传这个口径，并补测试
```
