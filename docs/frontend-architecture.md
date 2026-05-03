# Frontend Architecture Overview

本文档描述前端统一重构（`refactor/frontend-unified-layout`）后的架构状态，作为后续看板新增和样式调整的参考。所有路径相对仓库根目录。

## 0. 设计目标

重构前 P1/P2/P3 各自一份 `*.jsx`，三份独立的筛选条、KPI 卡片、折线图实现，样式分散在各页面。重构后：

- **三套看板共用同一个布局壳和同一组组件**（`DashboardShell` + `FilterBar` + `KpiSection` + `KpiCard` + `FocusLineChart` + `Table`）。
- **时间口径统一**到一组工具函数 (`datePeriod.ts`)，避免按日/按周/按月在三个看板里各算一次。
- **TypeScript 全量化**，类型由 `src/api/types.ts` 单一来源，组件 props 全部类型约束。
- **CSS 分层**到 `tokens / base / layout / components / extensions` 五个文件，颜色/间距走 token，避免硬编码。
- **新增看板的步骤是机械的**（见第 6 节），不需要重新设计 layout。

## 1. 目录结构

```
src/
  api/             types + per-dashboard fetcher modules
    types.ts         单一类型来源（PXFilters / PXResponse / TrendPoint 等）
    p1.ts p2.ts p3.ts  各看板 fetch 函数
  shared/
    components/    DashboardShell, FilterBar, KpiSection, KpiCard,
                   MiniSparkline, FocusLineChart, Table
    hooks/         useDashboardData
    utils/         format, datePeriod, computeChartGeometry, apiClient
  features/
    p1/            P1Dashboard + WorkloadAnalysis
    p2/            P2Dashboard + ProductRefundTable + useSpuSkcPicker
    p3/            P3Dashboard + IssueStructure + ProductComplaintRanking
  styles/          tokens, base, layout, components, extensions
  App.tsx, main.tsx
```

## 2. 共享组件契约

简短列出每个共享组件的关键 props，详细签名见对应文件。

- **DashboardShell** (`src/shared/components/DashboardShell.tsx`)
  布局壳，固定渲染顺序：`filterBar → banner? → currentPeriodSection → focusChart → historySection → extensions?`。所有 slot 都是 `ReactNode`，dashboard 自行拼装。
- **FilterBar** (`src/shared/components/FilterBar.tsx`)
  通用筛选条。Props: `grain / onGrainChange`、`historyRange / onHistoryRangeChange`、可选 `storeOptions + store + onStoreChange`、可选 `extras` slot。日期改动时调用 `alignHistoryRangeToGrain` 与 `isHistoryRangeValid` 校验后才回调。
- **KpiSection** (`src/shared/components/KpiSection.tsx`)
  KPI 卡片网格容器。Props: `title`、可选 `subtitle`、`variant: 'current' | 'history'`、`children`。
- **KpiCard** (`src/shared/components/KpiCard.tsx`)
  联合类型 props：`variant: 'current'` 时支持 `value / delta / periodAverage / sparkline / sparklineTone`；`variant: 'history'` 时支持 `total / periodAverage`，或传 `rateMode: { mean, peak }` 切换为均值/峰值展示。`description` 自动渲染为带 tooltip 的提示。
- **MiniSparkline** (`src/shared/components/MiniSparkline.tsx`)
  KPI 卡里的小折线。Props: `items: TrendPoint[]`、`tone: 'sales' | 'complaints' | 'rate' | 'neutral'`。空数据时显示占位文案。
- **FocusLineChart** (`src/shared/components/FocusLineChart.tsx`)
  当前周期 + 历史区间双段对比折线，支持 metric tab 切换。Props: `metrics: FocusMetricSpec[]`（每个含 `key / label / formatter / history / current`）、可选 `defaultKey`、`ariaLabel`。tab 切换是纯前端状态，不发新请求。
- **Table** (`src/shared/components/Table.tsx`)
  通用表格。泛型 props: `columns: TableColumn<T>[]`、`rows: T[]`、`emptyCopy`、可选 `title / hint / loading / error / onRowClick / rowTone / children`。`children` 渲染在表头下、表格上，用于附加筛选/操作。

### 共享 utils

- `src/shared/utils/format.ts`：`formatInteger / formatPercent / formatHours / formatDecimal / formatMoney`，统一中文千分位、百分号、单位后缀。
- `src/shared/utils/datePeriod.ts`：见第 3 节。
- `src/shared/utils/computeChartGeometry.ts`：折线 SVG 坐标计算（默认 viewBox `0 0 100 100`，`bounds = { left:8, right:96, top:10, bottom:86 }`），`MiniSparkline` 与 `FocusLineChart` 共用，保证两者视觉一致。
- `src/shared/utils/apiClient.ts`：`buildQuery` + `request<T>` 简易 fetch 封装，自动 drop 空值，自动透传 `AbortSignal`，HTTP 非 2xx 抛中文异常。

## 3. 时间口径语义（locked）

实现见 `src/shared/utils/datePeriod.ts`。

- **当前周期**：包含 T-1 的完整单位。按日 = T-1 to T-1；按周 = T-1 所在 ISO 周（周一到周日）；按月 = T-1 所在自然月。
- **上一周期**：当前周期前一个完整单位（前天 / 上周 / 上月），仅用于 KPI 卡片的 **环比** 计算。
- **历史区间约束**：`date_to ≤ 当前周期起始日 - 1`（即 `isHistoryRangeValid` 要求 `date_to < currentPeriod.date_from`）；按周/按月时通过 `alignHistoryRangeToGrain` 对齐到完整周/月起止日。切换粒度时历史区间重置为该粒度的默认值。
- **默认历史区间**：按日 = 14 天，结束于 T-2；按周 = 8 个完整周，结束于上一个周日；按月 = 2 个完整月，结束于上月末。
- **ISO 周一为周首**：`startOfWeek` 把周日归为上一周的第 7 天。

## 4. 数据加载策略

由 `src/shared/hooks/useDashboardData.ts` 封装。

- 每个 Dashboard 调用 `useDashboardData`，hook 内部用 `Promise.all` 并行发 3 个请求：`current / previous / history`，复用同一个 `fetcher` 函数。
- 依赖 key 由 `baseFilters` JSON、`current/previous/history` 的 `date_from|date_to` 字符串组成。
  - **切粒度**：`grain` 变化使 baseFilters 与三个 PeriodWindow 全部重算，三个请求都重发。
  - **切历史区间**：仅 `historyRange` 变化，但当前 hook 实现仍按统一依赖触发；如未来要避免，需要拆分（目前接受简单优先）。
  - **切 FocusLineChart 的 metric tab**：纯前端 state，不触发任何请求。
- 旧请求由 `AbortController` 取消，组件卸载或依赖变更时设置 `cancelled` 标记防止竞态。
- 扩展区数据有各自的 `useEffect`：P1 坐席工作量趋势（`agent_workload_trends`）、P2 SPU/SKC 表（`ProductRefundTable` + `useSpuSkcPicker`）、P3 商品排行（`ProductComplaintRanking`）。

## 5. 类型来源

- **单一来源**：`src/api/types.ts` 集中导出 `Grain`、`PeriodWindow`、`TrendPoint`、`DashboardMeta`，以及各看板的 `PXFilters / PXSummary / PXDashboard / PXRow` 类型。
- **后端契约同步**：字段定义参照 `docs/p1-chat-dashboard-api.md`、`docs/p2-refund-dashboard-api.md`、`docs/p3-formal-runtime-api.md`。
- 改后端响应形状时，**手动同步前端类型**——目前没有自动派生（无 OpenAPI / codegen 流程）。若后端字段命名变化，应一次性修 `types.ts` + 对应 fetcher。

## 6. 新增 Dashboard 的步骤指南

1. **类型**：在 `src/api/types.ts` 加 `PXFilters extends PeriodWindow`、`PXSummary`、`PXDashboard` / `PXResponse`，以及任何子表 row 类型。共享原语 (`Grain / PeriodWindow / TrendPoint`) 直接复用。
2. **fetcher**：在 `src/api/pX.ts` 加 `fetchPXDashboard(filters, signal)`，内部调用 `request<PXDashboard>('/api/bi/pX/dashboard', filters, signal)`。扩展区数据建议放独立 fetcher（如 `fetchPXProductRanking`）。
3. **Dashboard 组件**：在 `src/features/pX/PXDashboard.tsx` 用 `<DashboardShell>` 组装：
   - `filterBar`：`<FilterBar grain historyRange .../>`，业务额外筛选（店铺、客服、SPU 等）通过 `extras` slot 注入。
   - `currentPeriodSection`：`<KpiSection variant="current">` 装多张 `<KpiCard variant="current" delta sparkline />`。
   - `focusChart`：`<FocusLineChart metrics />`，metrics 数组覆盖该看板需要 deep-dive 的指标。
   - `historySection`：`<KpiSection variant="history">` 装 `<KpiCard variant="history" />`，rate 类指标用 `rateMode`。
   - `extensions`：扩展区组件。
4. **数据**：在 Dashboard 顶层调用 `useDashboardData<typeof baseFilters, PXDashboard>({ baseFilters, currentPeriod, previousPeriod, historyRange, fetcher })`。`currentPeriod / previousPeriod` 用 `getCurrentPeriod / getPreviousPeriod` 计算，`historyRange` 用 `useState(() => getDefaultHistoryRange(grain))` 初始化，并在 `handleGrainChange` 里 reset。
5. **扩展区组件**：抽出到 `src/features/pX/`（参考 `WorkloadAnalysis / ProductRefundTable + useSpuSkcPicker / IssueStructure + ProductComplaintRanking`）。每个组件用独立 `useEffect` 拉取自身数据，自带 loading / error / empty 状态。
6. **接入**：在 `src/App.tsx` 的 `PAGE_OPTIONS` 加一项（`value / shortTitle / title / description`），import `PXDashboard`，在 `activePage` 三元里加分支。

## 7. CSS 层级 + token 使用规范

`src/styles/` 下 5 个文件按层加载（顺序见 `main.tsx`）：

1. **tokens.css** —— CSS 变量：颜色（`--accent`、`--surface`、`--text` 等）、间距（`--space-1` 到 `--space-7`）、字号（`--fs-xs` 到 `--fs-2xl`）、tone 语义色（`--tone-up`、`--tone-down`、`--tone-sales` 等）。
2. **base.css** —— 全局 reset 和基础元素样式。
3. **layout.css** —— 应用骨架：`app-shell`、`side-nav`、`dashboard-shell`、`filter-bar`、`kpi-section` 等。
4. **components.css** —— 共享组件样式：`kpi-card`、`focus-chart`、`mini-chart`、`data-table` 等。
5. **extensions.css** —— P1/P2/P3 各自的特色模块样式（坐席工作量、SPU/SKC 折叠表、客诉结构图等）。

**规范**：

- 优先用 token：颜色一律走 `var(--accent)` / `var(--tone-down)`，间距走 `var(--space-4)` 等，避免硬编码。
- 新增共享组件的样式归入 `components.css`；只有 P1/P2/P3 内部独有的扩展区 UI 才归入 `extensions.css`。
- 不在 React 组件里写 inline style 表达色值或间距（除了 SVG 内部基于 geometry 计算出来的属性）。

## 8. 测试与构建

- **单测**：Vitest，仅覆盖纯函数 utils（`format.test.ts`、`datePeriod.test.ts`、`computeChartGeometry.test.ts`），不写组件单测。React 组件靠类型 + 手工 dogfood。
- **类型检查**：`tsc --noEmit`，`tsconfig.json` 已收紧（`strict: true` 等）。
- **Lint**：ESLint TypeScript 配置见 `eslint.config.js`，覆盖 `src/`。
- **构建**：Vite，`npm run build` 生成 `dist/`；Node `app` 入口同时 serve `dist/` 与 `/api` 代理。

## 9. 已知约束 / 后续可优化

- `useDashboardData` 切换 `historyRange` 时仍重发 `current / previous`（依赖 key 没拆细），目前接受。如要优化，把 hook 拆成两个 useEffect，分别监听 `current+previous` 与 `history`。
- 后端契约同步靠手动；如未来 API 字段稳定可以引入 OpenAPI codegen。
- `App.tsx` 用 `activePage` 三元分支，看板增多时应改为路由表。
