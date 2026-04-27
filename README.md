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

- 有 `GOOGLE_APPLICATION_CREDENTIALS`：启用 BigQuery 销量查询和订单补齐
- 有有效 `SYNC_CONFIG_PATH`：启用 Feishu tenant token + bitable records 拉取
- 缺少任一配置：只对缺失的那部分回退到本地 sample / fixture，并在 `meta.notes` 中说明

推荐本地目录：

```text
config/
  sync/config.json
  gcp/julang-dev-database-876c2efba122.json
  data/state.json
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
- Node `app` 已支持 BigQuery 销量查询、BigQuery 订单补齐、Feishu tenant token 获取和 bitable records 拉取
- Node `sync` 已承接 Feishu/OpenClaw 同步、预览和 CSV 预览能力

## Migration Note

- Python 实现已完成 Node 重写并从当前工作区移除。
- 如需追溯历史实现，请查看 git 历史。
