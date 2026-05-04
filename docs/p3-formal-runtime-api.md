# P3 Formal Runtime API Contract

当前文档描述的是 `P3 正式版运行时契约`。当前实现保留原有 `/api/bi/p3/dashboard` 外形，同时把客诉口径升级为 `OpenClaw/Feishu + Shopify BigQuery` 的运行时拼接版本。

## Runtime Model

- 客诉源
  - 优先读取本地 SQLite 中的飞书目标表镜像，镜像不存在时回退到 `OpenClaw / Feishu` 目标表实时拉取
- 订单与商品补数
  - 本地 SQLite Shopify BI cache，由 `sync:run` 刷新，或由 `sync:worker` 按覆盖窗口从 `Shopify BigQuery` 补齐
- 服务内完成：
  - 标准化客诉记录
  - 三大类归类：`product / warehouse / logistics`
  - 订单时间、退款时间、SKU/SKC/SPU 补齐

### Shopify BI SQLite Cache Refresh

The sync worker maintains two SQLite-backed datasets:

- Feishu target mirror: refreshed on `runtime.refresh_interval_minutes`.
- Shopify BI cache: refreshed from hourly-updated Shopify DWD marts. Regular worker ticks refresh the trailing cache window and record `data_as_of`, the effective upstream freshness watermark derived from the DWD sources.

P2 and P3 read Shopify metrics from SQLite when the requested date range is covered. P2 may temporarily fall back to BigQuery while a first deployment backfill is still running.

P3 reports Shopify metrics with source mode `sqlite shopify bi cache`, the shared SQLite fact cache used by both P2 and P3. The older wording `sqlite shopify bigquery cache` refers to legacy PR8 compatibility tables and should not appear after the shared cache migration is active.

## Run Locally

```bash
set GOOGLE_APPLICATION_CREDENTIALS=openclaw_followup_sync\config\julang-dev-database-876c2efba122.json
npm.cmd run dev
```

默认地址：`http://127.0.0.1:8000`

## Endpoint 1: Dashboard

- Method: `GET`
- Path: `/api/bi/p3/dashboard`

### Query Parameters

| Name | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `date_from` | `YYYY-MM-DD` | Yes | - | 按当前 `date_basis` 过滤，起始日含当日。 |
| `date_to` | `YYYY-MM-DD` | Yes | - | 按当前 `date_basis` 过滤，结束日含当日。 |
| `grain` | `day \| week \| month` | No | `week` | `week` 以周一为 bucket 起点。 |
| `date_basis` | `order_date \| refund_date` | No | `order_date` | 控制客诉过滤与客诉趋势分桶使用订单时间还是退款时间。 |
| `sku` | `string` | No | `null` | 商品维度过滤。 |
| `skc` | `string` | No | `null` | 商品维度过滤。 |
| `spu` | `string` | No | `null` | 商品维度过滤。 |

### Response Shape

```json
{
  "filters": {},
  "summary": {
    "sales_qty": 0,
    "complaint_count": 0,
    "complaint_rate": 0.0
  },
  "trends": {
    "sales_qty": [{"bucket": "2026-03-02", "value": 0}],
    "complaint_count": [{"bucket": "2026-03-02", "value": 0}],
    "complaint_rate": [{"bucket": "2026-03-02", "value": 0.0}]
  },
  "issue_share": [
    {
      "major_issue_type": "product",
      "label": "产品问题",
      "count": 0,
      "ratio": 0.0
    }
  ],
  "meta": {
    "version": "p3-formal-runtime",
    "complaint_definition": "standardized_issue_records",
    "source_modes": [],
    "partial_data": false,
    "data_as_of": "2026-05-04T06:00:00.000Z",
    "notes": []
  }
}
```

真实样例见 [p3-formal-runtime-sample-response.json](./p3-formal-runtime-sample-response.json)。

### Metric Definitions

- `summary.sales_qty`
  - Shopify 订单数汇总
  - 来源：本地 SQLite Shopify BI cache 中的订单行数据
- `trends.sales_qty`
  - 按 `grain` 聚合后的订单数趋势
  - 与 `summary.sales_qty` 使用相同订单数口径
- `summary.complaint_count`
  - 标准化客诉记录数
  - 去重规则：
    - 产品/仓库问题：`记录 + SKU`
    - 物流问题：`订单级问题记录`
- `summary.complaint_rate`
  - `complaint_count / sales_qty`
  - 当 `sales_qty = 0` 时返回 `0.0`
  - 字段名 `sales_qty` 为兼容保留，但当前语义已改为“订单数”
- `issue_share`
  - `product / warehouse / logistics` 三类占比
  - 分母为全部标准化客诉记录数

### Freshness Metadata

- `meta.data_as_of`
  - 当 P3 的 Shopify 指标来自 SQLite Shopify BI cache 且 cache run 记录了上游水位时返回。
  - 表示订单、退款等 Shopify DWD 来源的有效数据截至时间，前端格式化为小时级“数据截至”。
- 前端默认当前周期：
  - 按日为今天。
  - 按周为本周至今。
  - 按月为本月至今。
  - 当前未完整 day/week/month bucket 保持虚线/当前段样式。

### Date Basis Rules

- `date_basis = order_date`
  - 客诉过滤与客诉趋势按 `issue.order_date`
  - 若 `order_date` 缺失，回退 `record_date`
- `date_basis = refund_date`
  - 客诉过滤与客诉趋势按 `issue.refund_date`
  - 若 `refund_date` 缺失，该 issue 不进入当前统计
- 分母 `sales_qty`
  - 两种时间口径下都表示同一时间窗的订单数
  - `refund_date` 模式下因此属于“退款时间客诉 / 订单数分母”的混合口径

### Filtering Rules

- `sku/skc/spu`
  - 对 `product` 和 `warehouse` 直接按客诉 SKU 维度过滤
  - 对 `logistics` 按订单下 line item 维度匹配
  - 若物流订单下没有命中过滤商品，则该物流问题被排除

## Endpoint 2: Drilldown Options

- Method: `GET`
- Path: `/api/bi/p3/drilldown-options`
- Query 参数：与 `/api/bi/p3/dashboard` 相同

### Response Shape

```json
{
  "filters": {},
  "options": [
    {
      "major_issue_type": "product",
      "label": "产品问题",
      "count": 0,
      "ratio": 0.0,
      "target_page": "p4"
    }
  ],
  "meta": {
    "partial_data": false,
    "notes": []
  }
}
```

## Endpoint 3: Drilldown Preview

- Method: `GET`
- Path: `/api/bi/p3/drilldown-preview`

### Extra Query Parameter

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `major_issue_type` | `product \| warehouse \| logistics` | Yes | 选择需要预览的一级问题分类。 |

### Response Shape

```json
{
  "filters": {},
  "preview": {
    "top_reasons": [{"reason": "货品瑕疵-其他", "count": 0}],
    "top_spus": [{"spu": "SPU-1", "count": 0}],
    "top_skcs": [{"skc": "SKC-1", "count": 0}],
    "sample_orders": [{"order_no": "LC123", "reason": "物流问题-超期"}]
  },
  "meta": {
    "partial_data": false,
    "notes": []
  }
}
```

规则：
- `product / warehouse`
  - 返回 `top_reasons / top_spus / top_skcs`
  - `sample_orders` 为空
- `logistics`
  - 返回 `top_reasons / sample_orders`
  - `top_spus / top_skcs` 为空

## Empty / Partial Data Rules

- 顶层结构必须稳定返回
- `meta.partial_data = true`
  - 表示 Feishu 或 BigQuery 补数存在局部失败
- `meta.notes`
  - 返回被忽略来源、无法映射、缺失补单等运行时说明

## Stability Contract

以下字段名对前端视为稳定，不会因为正式版升级而改名：

- `/api/bi/p3/dashboard`
  - `filters`
  - `summary`
  - `trends`
  - `issue_share`
  - `meta`
- `/api/bi/p3/drilldown-options`
  - `filters`
  - `options`
  - `meta`
- `/api/bi/p3/drilldown-preview`
  - `filters`
  - `preview`
  - `meta`

允许继续演进的主要是语义和映射规则：

- `minor_issue_type` 映射精度
- `meta.notes`
- 各类 preview 的排序和补充字段
