# Config Layout

当前项目自己的本地配置和凭证统一放在 `config/` 下。

推荐目录结构：

```text
config/
  README.md
  sync/
    config.example.json
    config.json
  gcp/
    julang-dev-database-876c2efba122.json
  data/
    state.json
    issues.sqlite
  logs/
    sync.log
```

## How To Fill

1. 复制 `config/sync/config.example.json` 为 `config/sync/config.json`
2. 把飞书和表格参数填到 `config.json`
3. 把 GCP service account JSON 放到 `config/gcp/`
4. 在项目根目录创建 `.env`，推荐内容：

```env
APP_HOST=127.0.0.1
APP_PORT=8787
SYNC_CONFIG_PATH=config/sync/config.json
GOOGLE_APPLICATION_CREDENTIALS=config/gcp/julang-dev-database-876c2efba122.json
```

如果需要给 BigQuery 单独走代理，也可以放在 `config/sync/config.json`：

```json
{
  "bigquery": {
    "proxy": {
      "enabled": true,
      "http_proxy": "http://127.0.0.1:7890",
      "https_proxy": "http://127.0.0.1:7890",
      "no_proxy": "127.0.0.1,localhost"
    }
  }
}
```

## Feishu Fields

- `feishu.app_id`: 飞书开放平台应用的 App ID
- `feishu.app_secret`: 飞书开放平台应用的 App Secret
- `source.app_token`: 源多维表格的 app token
- `source.table_id`: 源表 table id
- `source.view_id`: 源表 view id
- `target.app_token`: 目标多维表格的 app token
- `target.table_id`: 目标表 table id
- `target.view_id`: 目标表 view id

## Runtime Fields

- `runtime.state_path`: 源记录到目标记录的同步状态文件
- `runtime.log_path`: `sync` / `sync:source-to-target` / `sync:worker` 共用日志文件
- `runtime.sqlite_path`: 本地 SQLite 镜像文件，P3 从这里读取 issue 数据和 BigQuery 本地缓存
- `runtime.refresh_interval_minutes`: `sync:worker` 刷新间隔，默认 `120`

## BigQuery Proxy Fields

- `bigquery.proxy.enabled`: 是否启用 BigQuery 代理注入
- `bigquery.proxy.http_proxy`: 同步脚本初始化 BigQuery 前写入 `HTTP_PROXY`
- `bigquery.proxy.https_proxy`: 同步脚本初始化 BigQuery 前写入 `HTTPS_PROXY`
- `bigquery.proxy.no_proxy`: 同步脚本初始化 BigQuery 前写入 `NO_PROXY`

如果飞书链接像：

```text
https://xxx.feishu.cn/base/AbCdEfGhIjKlMnOp?table=tbl123456789&view=vew987654321
```

则：

- `app_token = AbCdEfGhIjKlMnOp`
- `table_id = tbl123456789`
- `view_id = vew987654321`

## Notes

- `P3` 会优先读取 `runtime.sqlite_path` 指向的 SQLite 镜像；镜像不存在时才回退到飞书 `target` 表。
- `P3` 的销量、商品排行和订单补齐读取同一个 SQLite 文件里的 BigQuery 缓存，不在 API 请求时实时查询 BigQuery。
- `sync:source-to-target` 会按需把飞书源表转换并写入飞书目标表，保留 Shopify 订单字段补齐。
- `sync:run` 会读取飞书目标表同步 SQLite 镜像，并在有 `GOOGLE_APPLICATION_CREDENTIALS` 时刷新最近 400 天 BigQuery 缓存。
- `sync:preview` 不会写飞书，也不会写 SQLite。
- `sync:worker` 定时执行的是目标表到 SQLite 的同步和 BigQuery 缓存刷新，不会写飞书目标表。
- `config/sync/config.json`、`config/gcp/*.json`、`config/data/*`、`config/logs/*` 已加入 `.gitignore`。
