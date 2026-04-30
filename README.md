# BIKanBan

同仓单入口的 BI 看板项目：

- `app` 入口：统一承载前端页面与 Node API
- `sync` 入口：统一承载飞书/OpenClaw 同步相关命令

当前仓库中：

- `src/` 是 React 前端
- `server/` 是新的 Node.js 单入口服务

## Commands

业务系统入口：

```powershell
npm.cmd run dev
npm.cmd run build
npm.cmd run start
```

飞书同步入口：

```powershell
npm.cmd run sync:preview
npm.cmd run sync:run
npm.cmd run sync:worker
npm.cmd run sync:csv -- --source docs/客服跟进记录表_退款登记_退款登记.csv
```

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

字段说明见 [config/README.md](/d:/lxx/Internship/Julang-Tech/code/BIKanBan/config/README.md)。

## Current Migration Status

- 已完成同仓单入口架构
- 已提供 Node `app` / `sync` 两个正式入口
- Node `app` 已接入真实 P3 计算链路
- Node `app` 已支持从 SQLite BigQuery 缓存读取销量、商品和订单补齐数据，并支持 Feishu tenant token 获取和 bitable records 拉取
- Node `sync` 已承接 Feishu/OpenClaw 同步、预览、SQLite 镜像和 CSV 预览能力
- Node `sync:worker` 已支持启动即同步、之后每 2 小时自动刷新一次 SQLite 镜像和 BigQuery 本地缓存

## SQLite Mirror Notes

- `sync:run` 会双写飞书目标表和本地 SQLite 镜像，并在有 GCP 凭证时刷新最近 400 天 BigQuery 本地缓存。
- `sync:preview` 只做预览，不写飞书、不写 SQLite。
- `sync:worker` 是长期运行进程，启动后会立即执行一轮同步，之后按 `runtime.refresh_interval_minutes` 轮询，默认 `120` 分钟。

## Migration Note

- Python 实现已完成 Node 重写并从当前工作区移除。
- 如需追溯历史实现，请查看 git 历史。
