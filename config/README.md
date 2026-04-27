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

## Feishu Fields

- `feishu.app_id`: 飞书开放平台应用的 App ID
- `feishu.app_secret`: 飞书开放平台应用的 App Secret
- `source.app_token`: 源多维表格的 app token
- `source.table_id`: 源表 table id
- `source.view_id`: 源表 view id
- `target.app_token`: 目标多维表格的 app token
- `target.table_id`: 目标表 table id
- `target.view_id`: 目标表 view id

如果飞书链接像：

```text
https://xxx.feishu.cn/base/AbCdEfGhIjKlMnOp?table=tbl123456789&view=vew987654321
```

则：

- `app_token = AbCdEfGhIjKlMnOp`
- `table_id = tbl123456789`
- `view_id = vew987654321`

## Notes

- `P3` 读取客诉记录时当前使用的是 `target` 表配置。
- `config/sync/config.json`、`config/gcp/*.json`、`config/data/*`、`config/logs/*` 已加入 `.gitignore`。
