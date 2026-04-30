# P1 Chat Dashboard API Contract

当前文档描述 `P1 聊天数据看板` 的前后端契约。后端服务不在本项目实现，本项目仅保留前端页面和接口文档；开发期前端使用 mock 数据，但字段结构必须与本文档一致。

## Runtime Model

- 聊天数据来源
  - 一期只接入邮件数据，不包括 inbox 和 WhatsApp。
  - 计划来源为 BQ 邮件数据或 mail_db_server 同步后的邮件数据。
- 时间口径
  - 聊天模块按自然日统计。
  - 所有趋势最细粒度统一到天，并支持按天 / 周 / 月聚合。
  - 周 / 月趋势 bucket 从 `date_to` 往前切分，不按自然周或自然月切分。
- 坐席识别
  - 客服姓名按邮件正文落款识别。
  - 第一版使用既有姓名映射，不在页面内维护映射关系。

## Endpoint 1: Dashboard

- Method: `GET`
- Path: `/api/bi/p1/dashboard`

### Query Parameters

| Name | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `date_from` | `YYYY-MM-DD` | Yes | - | 自然日统计起始日，含当日。 |
| `date_to` | `YYYY-MM-DD` | Yes | - | 自然日统计结束日，含当日。 |
| `grain` | `day \| week \| month` | No | `day` | `week` 为截至 `date_to` 往前 7 天一组；`month` 为截至 `date_to` 往前 30 天一组。 |
| `agent_name` | `string` | No | `''` | 客服姓名筛选，空值表示全部客服。 |

### Response Shape

```json
{
  "filters": {
    "date_from": "2026-04-01",
    "date_to": "2026-04-24",
    "grain": "day",
    "agent_name": ""
  },
  "summary": {
    "inbound_email_count": 0,
    "outbound_email_count": 0,
    "first_email_count": 0,
    "unreplied_email_count": 0,
    "avg_queue_hours": 0.0,
    "first_response_timeout_count": 0
  },
  "trends": {
    "inbound_email_count": [{"bucket": "2026-04-01", "value": 0}],
    "outbound_email_count": [{"bucket": "2026-04-01", "value": 0}],
    "first_response_timeout_count": [{"bucket": "2026-04-01", "value": 0}]
  },
  "agent_workload": [
    {
      "agent_name": "Mira",
      "outbound_email_count": 0,
      "avg_outbound_emails_per_hour_by_span": 0.0,
      "avg_outbound_emails_per_hour_by_schedule": 0.0,
      "qa_reply_counts": {
        "excellent": 0,
        "pass": 0,
        "fail": 0
      }
    }
  ],
  "meta": {
    "version": "p1-chat-dashboard-v1",
    "source": "mail",
    "partial_data": false,
    "notes": []
  }
}
```

## Metric Definitions

- `summary.inbound_email_count`
  - 来邮数。
  - 请求日期范围内客户发送邮件的封数汇总。
- `summary.outbound_email_count`
  - 回邮数。
  - 请求日期范围内客服回复邮件的封数汇总。
- `summary.first_email_count`
  - 首封邮件数。
  - 请求日期范围内客户会话首封邮件的封数汇总。
- `summary.unreplied_email_count`
  - 还没回复数量。
  - 请求日期范围内客户首封邮件尚未产生人工回复的数量。
- `summary.avg_queue_hours`
  - 平均会话排队时长。
  - 请求日期范围内客户邮件到人工回复的时间差均值，单位为小时。
- `summary.first_response_timeout_count`
  - 首次响应超时次数。
  - 请求日期范围内客户来邮件到人工回复的时间差大于 24 小时的次数。
- `trends`
  - 按 `grain` 聚合后的来邮数、回邮数、首次响应超时次数趋势。
  - `day` 为每天一个 bucket。
  - `week` 从 `date_to` 往前每 7 天一组，最前面的 bucket 允许不足 7 天。
  - `month` 从 `date_to` 往前每 30 天一组，最前面的 bucket 允许不足 30 天。
  - `bucket` 使用该 bucket 的起始日期。
- `agent_workload.outbound_email_count`
  - 坐席总回邮数。
- `agent_workload.avg_outbound_emails_per_hour_by_span`
  - 每小时回邮数均值（首末封邮件时差）。
  - 计算方式：总回邮数 / 当日首封到末封回邮时间差。
- `agent_workload.avg_outbound_emails_per_hour_by_schedule`
  - 每小时回邮数均值（工时表）。
  - 计算方式：总回邮数 / 工时表记录工时。
- `agent_workload.qa_reply_counts`
  - 质检结果回邮数。
  - 第一版来自人工抽查，分为 `excellent`（优秀）、`pass`（达标）、`fail`（不合格）。

## Frontend Display Rules

- 若页面需要同时展示主数值和范围总量：
  - 使用完整 `date_from/date_to` 请求作为趋势、范围总量、坐席工作量分析数据。
  - 再按当前粒度窗口请求一次 summary 作为主数值。
- 当前粒度窗口：
  - `day`：`date_to` 当天。
  - `week`：截至 `date_to` 的近 7 天。
  - `month`：截至 `date_to` 的近 30 天。

## Empty / Partial Data Rules

- 顶层结构必须稳定返回。
- 无数据时：
  - 数值字段返回 `0`。
  - 数组字段返回 `[]`。
- `meta.partial_data = true`
  - 表示邮件数据、坐席识别、工时表或人工质检数据存在局部缺失。
- `meta.notes`
  - 返回未识别坐席、缺失工时表、质检未覆盖等说明。

## Stability Contract

以下字段名对前端视为稳定：

- `filters`
- `summary`
- `trends`
- `agent_workload`
- `meta`

允许继续演进的主要是：

- 坐席姓名映射规则
- 质检来源和覆盖范围
- `meta.notes`
