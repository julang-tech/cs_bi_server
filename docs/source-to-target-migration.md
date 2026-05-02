# 客服原表 → 新表 迁移与同步设计

## 背景

客服当前仍在**原表**上做日常登记。原表把不同来源/类型的客诉跟进诉求拆在多个分表里——退款、6 美元补发、物流推进等，**字段散乱、关联信息很难一次性取出**，所以我们做了一张**新表（目标表）**，把多源、多类型的客诉统一到一个数据模型，供后续 BI / 自动化 / 跨部门跟进。

后续约定：
- **原表** = 客服当前手工录入的多张飞书表（多个来源/类型，字段不统一）
- **新表 = 目标表** = 我们统一的单表数据模型（`tbl6hthvkKaNzrvf`）
- **source-to-target 同步** = 把原表数据按映射规则转换并写入新表

## 当前同步链路

```
飞书原表（CS 录入，多分表）
    │
    │  npm run sync:source-to-target
    │  · server/domain/sync/service.ts:syncSourceToTarget
    │  · 仅读取 config.source.table_id 一张表
    │  · transformSourceRecord(rawFields) → 目标表行
    │  · enrichResultsWithShopify 补 SKU / 物流字段
    ▼
飞书新表（目标表）
    │
    │  npm run sync:run
    │  · 全量拉新表 → 写本地 SQLite (feishu_target_records)
    │  · 同时刷 Shopify BI cache（订单/退款）
    ▼
SQLite 镜像
    │
    │  P3 后端读 SQLite，joined Shopify 订单后输出
    ▼
P3 客诉总览看板
```

**配置**（`config/sync/config.json`）：

| 角色 | app_token | table_id | view_id |
|---|---|---|---|
| 源表 | `Gv0LwToRZiPhynkpMUHcMsVWn2c` | `tblQsSMgz7jtC7mI` | `vewEEJpUSV` |
| 目标表 | `KfJGb8qDUaNVPCsC01oc4iAlnEc` | `tbl6hthvkKaNzrvf` | `vewdebCvBd` |

⚠️ 当前 `config.source` **只指了一个 table_id**——意味着 source-to-target 只同步原表里的一张分表（即"退款登记"那张）。其他分表（补发、物流推进等）还没接入。

## 已识别的 4 个问题（2026-05）

### 问题 1：`VIEW_HIT_MAP` 漏映射，约 30% 退款分类无视图

`server/domain/sync/transform.ts:32` 的 `VIEW_HIT_MAP` 只覆盖 5 种「退款原因分类」：

```
产品问题   → 1-3待跟进表-货品瑕疵
缺货问题   → 1-2待跟进表-漏发、发错
物流问题   → 1-4待跟进表-物流问题
错漏发     → 1-2待跟进表-漏发、发错
瑕疵问题   → 1-3待跟进表-货品瑕疵
```

`COMPLAINT_TYPE_MAP` 知道但 `VIEW_HIT_MAP` 不知道的：`券/折扣问题`、`订单异常/取消/修改订单`、`高风险订单`、`其他`——这类客诉到目标表后**「命中视图」字段为空**。

### 问题 2：`1-5待跟进表-补发` 后端不识别

source-to-target 在「具体操作要求」包含"补发"时会写视图 `1-5待跟进表-补发`，但 P3 后端 `ISSUE_VIEW_TO_MAJOR_TYPE`（`server/integrations/sqlite.ts:79`）只认 `1-2 / 1-3 / 1-4`，**所有补发记录被 P3 静默丢弃**。

### 问题 3：双依赖且无 fallback

`inferViewHit` 强依赖「具体操作要求」**和**「退款原因分类」两个字段；任一空 + 走不到查表，命中视图必为空。

### 问题 4：丢弃静默化

被丢的记录只在 `notes` 数组里写一行 `Skipped sqlite mirrored record X: unable to map`。看板 UI 完全看不到，排查全靠扒日志/SQLite。

---

## 工作计划

### 1. 数据同步与规则制定

#### 1.a 列出原表需要同步的分表（待用户确认）

当前同步只覆盖 1 张原表分表（`tblQsSMgz7jtC7mI`，即"退款登记"）。需要确认：

- [ ] 原表的飞书 app token 还包含哪些分表？（例如：6 美元补发表、物流推进表、客户回访表 …）
- [ ] 哪些**确实需要**同步进新表？哪些保持独立？

收集方式：
- 用户列举（最快）
- 或者用飞书 OpenAPI 的 [list bitable tables](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table/list) 拉清单（需要扩 sync config 增加多 source table 支持）

#### 1.b 每张原表分表的映射规则

每张原表分表都要有一份映射规则文档，至少包括：
- 原表字段 → 目标表字段（含必填校验、值映射如 `产品问题 → 1-3待跟进表-货品瑕疵`）
- 分表对应的目标表「命中视图」（如果是新视图，先按 §2 补建）
- 是否需要按 SKU 拆行（一条原表可能拆出 N 条目标表）
- 是否需要 Shopify enrichment（订单/物流补齐）

代码层做法：将 `transformSourceRecord` 改为**按源 table_id 分派的策略表**，每张表一份独立 transformer。

### 2. 视图完善

#### 2.a 新增「待跟进表-退款」视图（确认要做）

新表当前缺一个**纯退款**的跟进视图，需要在飞书新表里建：

- 视图名：`1-1待跟进表-退款`（或团队习惯的命名）
- 筛选条件：命中视图 = "退款"（或映射规则里指向这个视图的所有客诉类型）
- 后端 `ISSUE_VIEW_TO_MAJOR_TYPE` 需要新增映射（建议归到 `refund` 或 `product` 之一，待定义）

#### 2.b 评估其他可能缺的视图（待用户输入原表能解决的诉求清单）

需要等原表分表清单（§1.a）出来后，才能逐张比对原表"能解决的诉求 vs 新表已有视图"，找出 gap。

候选可能要补的视图：
- 待跟进表-退款（已知）
- 待跟进表-赔付/代金券（如果原表有这类）
- 待跟进表-账户安全/高风险订单
- 已结案归档视图（区分 active vs archived）

---

## Open Questions

1. **原表的所有分表**有哪些？（需要用户列出，或用飞书 API 拉）
2. **新建视图的命名规范**——继续用 `N-X待跟进表-<类型>` 还是新规范？
3. **退款记录最终归 BI 哪类**——product / warehouse / logistics / 新增 `refund` 第四类？
4. 原表录入完成后，**是否仍保留原表作为录入入口**，还是逐步把录入也迁到新表？

---

## 修复优先级（独立于上面的工作计划，可以并行）

| | 修复 | 影响 |
|---|---|---|
| **P0** | 后端 `ISSUE_VIEW_TO_MAJOR_TYPE` 加 `1-5待跟进表-补发`（归 warehouse 或新增 refund 类） | 立刻找回所有补发记录 |
| **P0** | `VIEW_HIT_MAP` 补全 `券/折扣/订单异常/高风险/其他` → 兜底视图 | 立刻找回 ~30% 漏分类记录 |
| **P1** | 看板顶部 surface "X 条记录因字段缺失被丢弃"提示 + 详情链接 | 数据可见性 |
| **P2** | 多源 transformer 重构（按 table_id 分派） | 配合 §1 工作计划 |
