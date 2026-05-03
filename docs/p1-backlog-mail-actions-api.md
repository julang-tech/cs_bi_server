# P1 Backlog Mail Actions API

目标：P1 聊天数据看板里的“当前积压”快照支持点击查看积压邮件列表，并能在看板内标记每封邮件是否仍需要回复。

最终后端契约以 `~/work/mail_db_server/docs/p1-backlog-mails-api.md` 为准。本仓库前端通过 cs_bi_server 同源代理调用。

## 交互

1. 用户点击 P1 当前积压快照面板。
2. 前端打开弹窗，拉取当前积压未回邮件列表。
3. 弹窗列表展示每项积压了多久。
4. 点击列表项展开，显示当前邮件原文和中文翻译。
5. 用户可标记：
   - `needs_reply=true`：仍需要回复
   - `needs_reply=false`：不需要回复

标记成功后只刷新弹窗列表；dashboard 快照跟随下一次正常看板刷新或用户切换筛选刷新。

## 接口 1：积压邮件列表

```http
GET /api/bi/p1/backlog-mails
```

Query 参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---:|---:|---|
| `tz_offset_minutes` | int | 是 | 分钟，向东为正；前端传 `-new Date().getTimezoneOffset()` |
| `limit` | int | 否 | 默认 100，最大 500 |
| `cursor` | string | 否 | 分页游标，传 `page.next_cursor` |
| `needs_reply` | `"true"` / `"false"` | 否 | 可选过滤；不传返回当前积压集合 |
| `date_from` | string | 否 | 接受但不参与积压判定，仅供后端 echo |
| `date_to` | string | 否 | 同上 |
| `grain` | `day/week/month` | 否 | 同上 |
| `agent_name` | string | 否 | 当前不支持按客服过滤；传了会返回空集合并附 note |

响应重点字段：

| 字段 | 说明 |
|---|---|
| `mail_id` | integer，后端 `cs_emails.id` |
| `from_email` | 邮件 envelope sender；Shopify relay 邮件时可能是 `mailer@shopify.com` |
| `customer_email` | 真实客户邮箱 / pairing 身份；前端客户识别优先使用该字段 |
| `received_at` | 当前积压计时起点，ISO UTC |
| `wait_hours` | 后端按 `snapshot_at - received_at` 计算，前端直接展示 |
| `needs_reply` | 生效值：人工标记优先于 LLM label |
| `is_manually_reviewed` | 是否已被人工确认过 |
| `body.original` | 当前客户邮件原文 |
| `body.zh` | 中文翻译；未翻译完成时可为 `null` |

## 接口 2：标记是否需要回复

```http
POST /api/bi/p1/backlog-mails/{mail_id}/needs-reply
Content-Type: application/json
```

`mail_id` 是 integer。

Body：

```json
{
  "needs_reply": false,
  "operator": "dashboard"
}
```

Response：

```json
{
  "mail_id": 12345,
  "needs_reply": false,
  "is_manually_reviewed": true
}
```

## 本仓库代理

本仓库已在 Node app 中代理两个同源接口：

- `GET /api/bi/p1/backlog-mails`
- `POST /api/bi/p1/backlog-mails/:mail_id/needs-reply`

代理逻辑：

- 使用 `P1_API_BASE_URL`
- 透传 `x-api-key`
- 透传 `tz_offset_minutes`
- backlog 接口保持 MailDB 的 4xx/5xx 状态码

## 暂不纳入

- 不做站内邮件回复编辑器
- 不直接跳转或调用邮件系统发送回复
- 不设计复杂审核流
- 不要求本仓库新增 DB 表；标记状态由 MailDB Server 侧负责持久化
