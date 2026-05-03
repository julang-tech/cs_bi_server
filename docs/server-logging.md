# Server Logging

本仓库服务端有两类日志入口：

## App API

`npm run dev:app` / `npm run start` 使用 Fastify logger，日志输出到 stdout：

- 每个 HTTP request / response 都会带 `reqId`、method、url、statusCode、responseTime。
- 未捕获异常由 Fastify 记录 error stack。
- P1 MailDB 代理的配置错误和上游错误会额外记录 warning，包含 upstream status；标记积压邮件失败时会带 `mail_id`。
- P3 订单补数缺失不再写入 dashboard `meta.notes`，只在服务端 warning 中聚合记录缺失数量和最多 20 个订单号样例。

`meta.notes` 只用于前端用户需要看到的数据源降级或配置缺失，不用于单订单级诊断。

## Sync / Worker

`npm run sync:*` 和 `npm run dev:worker` 使用 `createLogger()`：

- 日志同时输出到 stdout 和 `runtime.log_path`。
- 默认路径来自 `config/sync/config.json`，常用为 `config/logs/sync.log`。
- worker 每轮会记录 trigger、扫描窗口、source-to-target 结果、SQLite 镜像结果、BigQuery/Shopify BI cache 结果和失败分支。

## 排查建议

1. API 问题先按 `reqId` 在 app stdout 中串起请求、响应和 warning。
2. 看板数据新鲜度先查 `/api/bi/cache-status`，再查 `runtime.log_path`。
3. 单订单缺补数时搜订单号，日志会显示对应 enrichment 路径和聚合样例。
