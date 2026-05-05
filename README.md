# BIKanBan

同仓单入口的 BI 看板项目：

- `app` 入口：统一承载前端页面与 Node API
- `sync` 入口：统一承载飞书/OpenClaw 同步相关命令

当前仓库中：

- `src/` 是 React 前端
- `server/` 是新的 Node.js 单入口服务

## Commands

业务系统入口：

```bash
npm run dev
npm run dev:all
npm run build
npm run start
```

飞书同步入口：

```bash
npm run sync:preview
npm run sync:source-to-target
npm run sync:run
npm run sync:worker
npm run sync:csv -- --source docs/客服跟进记录表_退款登记_退款登记.csv
```

## Frontend

前端是 React + TypeScript + Vite 单页应用，采用统一看板模板（筛选器 + 当前周期 KPI + 焦点折线图 + 历史区间 KPI + 扩展区），三个看板（P1 聊天、P2 退款、P3 客诉）共享组件、hook、工具和 token 体系。

详细架构见 [docs/frontend-architecture.md](docs/frontend-architecture.md)。

主要命令：

- `npm run dev` — 同时起前端 (vite, http://localhost:5173) + 后端 (Node, http://127.0.0.1:8787)，不自动启动同步 worker
- `npm run dev:all` — 同时起前端、后端和同步 worker
- `npm run dev:client` — 仅起前端
- `npm run dev:worker` — 仅起同步 worker；启动后会先同步一轮，后续按配置间隔和每日固定时间刷新
- `npm run typecheck` — 前端 TS 类型检查
- `npm run test` — 前端单元测试 (Vitest)
- `npm run lint` — ESLint
- `npm run build` — 生产构建（前端 + 后端）

> Note: 在 macOS 上如使用 Codex.app 自带 node，可能因 code-signing 与 rolldown 原生 binding 冲突。建议优先使用 Homebrew 的 node：在 `~/.zshrc` 把 `/opt/homebrew/bin` 排到 Codex 路径之前。

## Environment

复制 `.env.example` 并按需覆盖：

- `APP_HOST`
- `APP_PORT`
- `SYNC_CONFIG_PATH`
- `GOOGLE_APPLICATION_CREDENTIALS`

默认 `sync` 会读取：

- `config/sync/config.example.json`

真实 P3 Node 后端的默认装配方式：

- 有有效 `SYNC_CONFIG_PATH`：P3 的销量、商品和订单补齐读取本地 SQLite BigQuery 缓存，不在 API 请求时实时查询 BigQuery
- 有有效 `SYNC_CONFIG_PATH` 且 SQLite 镜像存在：P3 优先从本地 SQLite 读取 issue 数据
- SQLite 镜像不存在但有有效 `SYNC_CONFIG_PATH`：回退到 Feishu tenant token + bitable records 拉取
- 缺少任一配置：只对缺失的那部分回退到本地 sample / fixture，并在 `meta.notes` 中说明

推荐本地目录：

```text
config/
  sync/config.json
  gcp/julang-dev-database-876c2efba122.json
  data/state.json
  data/issues.sqlite
  logs/sync.log
```

如果要用真实配置，请：

1. 复制 `config/sync/config.example.json` 为 `config/sync/config.json`
2. 在项目根目录创建 `.env`
3. 把 `.env` 填成：

```env
APP_HOST=127.0.0.1
APP_PORT=8787
SYNC_CONFIG_PATH=config/sync/config.json
GOOGLE_APPLICATION_CREDENTIALS=config/gcp/julang-dev-database-876c2efba122.json
```

字段说明见 [config/README.md](config/README.md)。

## Current Migration Status

- 已完成同仓单入口架构
- 已提供 Node `app` / `sync` 两个正式入口
- Node `app` 已接入真实 P3 计算链路
- Node `app` 已支持从 SQLite BigQuery 缓存读取销量、商品和订单补齐数据，并支持 Feishu tenant token 获取和 bitable records 拉取
- Node `sync` 已承接 Feishu/OpenClaw 同步、目标表 SQLite 镜像、BigQuery 缓存和 CSV 预览能力
- Node `sync:worker` 已支持启动即读取飞书目标表同步 SQLite 并强刷新 BigQuery/Shopify BI 缓存、之后每 60 分钟自动刷新 SQLite 镜像并做 Shopify BI 缓存 due check；默认每天北京时间 03:30 再做一次强刷新

## SQLite Mirror Notes

- `sync:source-to-target` 会按需把飞书源表转换并写入飞书目标表，保留 Shopify 订单字段补齐。
- `sync:run` 会读取飞书目标表同步本地 SQLite 镜像，并在有 GCP 凭证时刷新最近 400 天 BigQuery 本地缓存。
- `sync:preview` 只预览源表到目标表的转换结果，不写飞书、不写 SQLite。
- `sync:worker` 是长期运行进程，启动后会立即执行一轮 `sync:run`，之后按 `runtime.refresh_interval_minutes` 轮询，默认 `60` 分钟；它还会按 `runtime.daily_full_refresh_time` 在业务时区固定做一次强刷新，默认北京时间 `03:30`；它不写飞书目标表。
- `/api/bi/cache-status` 可查看 SQLite 文件是否存在、最近成功缓存覆盖区间、表内最大订单/退款日期和行数，方便判断看板是否读到了过期缓存。

## Logging

服务端日志说明见 [docs/server-logging.md](docs/server-logging.md)。App API 使用 Fastify JSON stdout 日志；sync / worker 同时写 stdout 和 `runtime.log_path`。

## Migration Note

- Python 实现已完成 Node 重写并从当前工作区移除。
- 如需追溯历史实现，请查看 git 历史。
