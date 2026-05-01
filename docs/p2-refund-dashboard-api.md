# P2 退款情况看板接口定义与取数说明

## 1. 页面目标
- 看退款规模、退款订单占比、退款金额占比、商品分布
- 按订单时间统计
- 支持粒度选择（天/周/月）与时间范围筛选
- 商品表支持 SPU 行展开查看 SKC 明细，支持多条同时展开

---

## 2. 接口列表

### 2.1 概览接口
- **Method**: `GET`
- **Path**: `/api/bi/p2/refund-dashboard/overview`

#### Query 参数
- `date_from` `string`（`YYYY-MM-DD`）
- `date_to` `string`（`YYYY-MM-DD`）
- `grain` `day | week | month`
- `category` `string` 可选
- `spu` `string` 可选
- `skc` `string` 可选
- `listing_date_from` `string` 可选
- `listing_date_to` `string` 可选
- `top_n` `number`（前端会传，后端可忽略）

#### 返回
```json
{
  "filters": {
    "date_from": "2026-03-01",
    "date_to": "2026-03-31",
    "grain": "month"
  },
  "cards": {
    "order_count": 17468,
    "sales_qty": 86904,
    "refund_order_count": 1962,
    "refund_amount": 1280000,
    "gmv": 2140000,
    "net_received_amount": 2060000,
    "net_revenue_amount": 1800000,
    "refund_amount_ratio": 0.058,
    "regular_order_count": 15000,
    "non_regular_order_count": 2468,
    "regular_received_amount": 1800000,
    "non_regular_received_amount": 260000,
    "avg_order_amount": 117.9,
    "regular_avg_order_amount": 120.0,
    "non_regular_avg_order_amount": 105.3,
    "refund_order_ratio_total": 0.112,
    "refund_order_ratio_regular": 0.131
  },
  "meta": {
    "partial_data": false,
    "source_mode": "sqlite_shopify_bi_cache",
    "cache_generation": "2026-05-01T12:00:00.000Z",
    "notes": [
      "Metric definitions aligned with finance team per dwd ADR-0007 (2026-04-30): GMV/revenue include shipping; refund_amount is now refund-flow (events in window) not cohort (orders in window). See lintico-data-warehouse/shopify_data_sync/docs/decisions/0007-dwd-align-with-cs-bi-finance.md"
    ]
  }
}
```

---

### 2.2 商品退款表现表接口
- **Method**: `GET`
- **Path**: `/api/bi/p2/refund-dashboard/spu-table`

#### Query 参数
同 `overview`，额外：
- `top_n` `number`（前端实际会至少拉 20，用于前端二次排序）

#### 返回
```json
{
  "filters": {
    "date_from": "2026-03-01",
    "date_to": "2026-03-31",
    "grain": "month",
    "top_n": 20
  },
  "rows": [
    {
      "spu": "LWS-PT21",
      "sales_qty": 946,
      "sales_amount": 71100,
      "refund_qty": 19,
      "refund_amount": 1290,
      "refund_qty_ratio": 0.0201,
      "refund_amount_ratio": 0.0181,
      "skc_rows": [
        {
          "skc": "LWS-PT21WH",
          "sales_qty": 431,
          "sales_amount": 32432,
          "refund_qty": 14,
          "refund_amount": 938,
          "refund_qty_ratio": 0.0325,
          "refund_amount_ratio": 0.0289
        }
      ]
    }
  ],
  "meta": {
    "partial_data": false,
    "source_mode": "sqlite_shopify_bi_cache",
    "cache_generation": "2026-05-01T12:00:00.000Z",
    "notes": []
  }
}
```

---

## 3. 后端代码位置

- 路由定义：
  - `server/entrypoints/app.ts`
- 服务实现：
  - `server/domain/p2/service.ts`
- 前端接口调用：
  - `src/api/p2.js`
- 页面实现：
  - `src/App.jsx`

---

## 4. 数据来源与元数据

### 4.1 运行时取数路径

P2 正常服务路径优先读取本地 SQLite Shopify BI cache。该 cache 由 `sync:worker` 按日期覆盖窗口刷新；BigQuery 是 cache refresh 的上游来源，不再是 SQLite 覆盖范围存在时的常规 P2 在线服务路径。

当请求日期范围未被 SQLite cache 覆盖，或 SQLite cache 暂不可用时，P2 会回退到 BigQuery 查询并在响应元数据中标记来源。

首次部署 cache schema 升级后，worker 完成初始 Shopify BI cache refresh 之前，接口返回 `bigquery_fallback` 属于预期行为。

### 4.2 Response Meta

每个 P2 响应都包含 `meta`：

- `meta.source_mode`: `sqlite_shopify_bi_cache` 表示请求日期范围已被 SQLite cache 覆盖并由 cache 返回；`bigquery_fallback` 表示 cache 覆盖缺失或 cache 不可用，本次响应由 BigQuery 返回。
- `meta.cache_generation`: SQLite 响应包含该字段，表示覆盖当前请求日期范围的最近一次成功 cache refresh 时间戳。
- `meta.partial_data`: 存在局部失败或凭证缺失等降级时为 `true`。
- `meta.notes`: 包含 ADR-0007 指标口径说明，以及 cache 不可用、BigQuery 凭证缺失等 fallback 说明。

### 4.3 Shopify BI Cache 上游表

以下 BigQuery 表用于刷新 SQLite Shopify BI cache；当 SQLite 覆盖请求日期范围时，P2 不直接查询这些表：

- `julang-dev-database.shopify_dwd.dwd_orders_fact`
  - 订单级指标：`processed_date`, `cs_bi_gmv`, `cs_bi_revenue`, `cs_bi_net_revenue`, `is_regular_order`, `is_gift_card_order`, `first_published_at_in_order`, `shop_domain`, `primary_product_type`
- `julang-dev-database.shopify_dwd.dwd_refund_events`
  - 退款级指标：`refund_date`, `refund_subtotal`, `quantity`, `order_id`, `sku`
- `julang-dev-database.shopify_intermediate.int_line_items_classified`
  - 件数/商品明细：`sku`, `quantity`, `discounted_total`, `is_insurance_item`, `is_price_adjustment`, `is_shipping_cost`, `variant_id`, `product_id`
- `julang-dev-database.shopify_intermediate.int_product_skc`
  - SKC辅助字段：`skc`, `color_value`, `variant_id`
- `julang-dev-database.product_information_database.dim_product_sku`
  - 业务映射：`sku_id`, `spu_id`, `skc_id`（有则优先）

---

## 5. SPU/SKC 解析口径（当前实现）

当 `dim_product_sku` 无映射时，按 SKU 解析（与你要求一致）：

- `SKC`：`sku` 去掉最后一段
  - 例：`LWS-PT21WH-L -> LWS-PT21WH`
- `SPU`：基于 `SKC` 再拆
  - 若最后段含数字：提取 `([a-zA-Z]*\d+)` 拼回前缀
  - 否则：取前缀（或最后段）

---

## 6. 前端排序与 TopN 策略

- 后端默认按 `refund_amount` 聚合返回（前端传 `top_n >= 20`）
- 前端支持排序字段切换：
  - `refund_qty`
  - `refund_amount`
  - `refund_qty_ratio`
  - `refund_amount_ratio`
- 前端在返回结果中二次排序，再截取展示 `TopN`（默认 5）

---

## 7. 关键交互与展示规则

- 时间筛选组件：`粒度 + 开始 + 结束` 合并
- 商品表默认折叠
- 折叠态 SKC 列显示该 SPU 下“退款金额最高”的 SKC
- 点击行可展开，支持多行同时展开
- 展开后显示 SKC 明细行

---

## 8. 当前口径说明（占比）

- SPU 行：
  - `退款数占比 = SPU退款数 / SPU销量`
  - `退款金额占比 = SPU退款金额 / SPU销售额`
- SKC 行（为便于与父行对齐）：
  - `退款数占比 = SKC退款数 / 所属SPU销量`
  - `退款金额占比 = SKC退款金额 / 所属SPU销售额`
