# Frontend Unification Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify P1/P2/P3 看板 under a single layout template (筛选器 → 当前周期 KPI → 焦点折线图 → 历史区间 KPI → 扩展区), eliminate the parallel implementations and duplicated chart geometry, and migrate the entire frontend to TypeScript while preserving every existing feature.

**Architecture:** Introduce a `shared/` layer with one canonical `DashboardShell`, `FilterBar`, `KpiSection`, `KpiCard`, `MiniSparkline`, `FocusLineChart`, and `Table`. Each Dashboard becomes a thin composition: it picks its 6–8 metric cards, plugs trend series into the shared chart, and supplies one or two extension-area modules that hold its dashboard-specific tables (P1 坐席工作量, P2 SPU/SKC 表, P3 问题结构 + 商品排行). Data fetching is centralized in a `useDashboardData` hook that issues three parallel requests (current period / previous period / history range) per filter change.

**Tech Stack:** Vite, React 19, TypeScript (strict), Vitest + jsdom for pure-utility unit tests, ESLint v9 flat config with `typescript-eslint`. No new runtime dependencies beyond what's needed to add TypeScript and Vitest.

---

## Layout Spec (Locked)

```
┌──────────────────────────────────────────────────────────────────┐
│ 筛选器栏: [按日 按周 按月]  [店铺 ▼ — 仅 P2]  [历史区间: 起 ─ 终]│
├──────────────────────────────────────────────────────────────────┤
│ 区块一 · 当前周期            数据截至 X 月 X 日(T-1)             │
│ N 张卡片 (N = 6 或 8); 每张: 主值 / 环比 / 周期日均 / 可选迷你图│
│ 上一周期为空时环比显示「-」                                      │
├──────────────────────────────────────────────────────────────────┤
│ 焦点折线图  [tab 切换全部 N 个指标]                              │
│ 灰褐背景=历史段, 橙色背景=当前段, 虚线分界, 历史均值参考线       │
│ X 轴粒度跟主筛选器走; 当前段就 1 个聚合点                        │
├──────────────────────────────────────────────────────────────────┤
│ 区块二 · 历史区间 (米色背景, 字号略小)                           │
│ X-Y · 共 N 个完整周期 · 按 X 聚合                                │
│ N 张卡片; 每张: 总值 / 周期均值                                  │
│ 比率类卡片 (退款金额占比/客诉率): 区间均值 + 区间峰值            │
├──────────────────────────────────────────────────────────────────┤
│ 扩展区 (各看板特色模块, 整页宽)                                  │
│   P1: 坐席工作量分析                                             │
│   P2: 商品退款表现表 (SPU/SKC + 上架时段)                        │
│   P3: 问题结构分析 + 商品客诉表现表                              │
└──────────────────────────────────────────────────────────────────┘
```

### Cards Allocation

| Dashboard | 卡片数 | 带迷你折线 | 不带 |
|---|---|---|---|
| P2 | 8 | 订单数, GMV, 退款金额, 退款金额占比 | 销量, 退款订单数, 净实付金额, 净 GMV |
| P1 | 6 | 来邮数, 回邮数, 平均会话排队时长, 首次响应超时次数 | 首封邮件数, 还没回复数 |
| P3 | 6 | 订单数, 客诉量, 客诉率, 产品问题客诉量 | 物流问题客诉量, 仓库问题客诉量 |

### Time Period Semantics (Locked)

ISO week (Monday is day 1). Today = system date at filter creation; T-1 = yesterday.

**当前周期 (current period)** — full unit containing T-1, **A semantics** (full window, partial fill):
- `day`: window = `[T-1, T-1]`
- `week`: window = `[Monday of T-1's week, Sunday of T-1's week]`
- `month`: window = `[1st of T-1's month, last day of T-1's month]`

**上一周期 (previous full period for 环比)**:
- `day`: window = `[T-2, T-2]`
- `week`: window = `[Monday of last week, Sunday of last week]`
- `month`: window = `[1st of last month, last day of last month]`

**默认历史区间 (default history range, ends one full unit before current)**:
- `day`: 14 days = `[T-15, T-2]`
- `week`: 8 prior complete weeks (Mon–Sun)
- `month`: 2 prior complete months (1st–last)

**历史区间约束**:
1. `date_to` ≤ start of 当前周期 minus 1 day (no overlap)
2. Must align to full grain units (week → Mon to Sun; month → 1st to last)
3. Switching grain resets history range to the default for the new grain

### Verification Standard

User stated: "只需保证原有功能都有就可以". After each Dashboard rewrite, manual click-through compares behaviour against the legacy `.jsx` file (kept in `legacy/` until Phase 6).

---

## Target File Structure

```
src/
  shared/
    components/
      DashboardShell.tsx
      FilterBar.tsx
      KpiSection.tsx
      KpiCard.tsx
      MiniSparkline.tsx
      FocusLineChart.tsx
      Table.tsx
    hooks/
      useDashboardData.ts
    utils/
      computeChartGeometry.ts
      format.ts
      datePeriod.ts
      apiClient.ts
  api/
    types.ts
    p1.ts
    p2.ts
    p3.ts
  features/
    p1/
      P1Dashboard.tsx
      WorkloadAnalysis.tsx
      legacy/P1Dashboard.jsx        # deleted in Phase 6
    p2/
      P2Dashboard.tsx
      ProductRefundTable.tsx
      useSpuSkcPicker.ts
      legacy/P2Dashboard.jsx        # deleted in Phase 6
      legacy/P2Dashboard.css        # deleted in Phase 6
    p3/
      P3Dashboard.tsx
      IssueStructure.tsx
      ProductComplaintRanking.tsx
      legacy/P3Dashboard.jsx        # deleted in Phase 6
  styles/
    tokens.css                       # design tokens
    base.css                         # reset, body, headings
    layout.css                       # shell, side nav, dashboard layout
    components.css                   # KPI cards, chart, table, etc.
    extensions.css                   # extension-area-specific styles
  App.tsx
  main.tsx
  vite-env.d.ts
```

The legacy directories are temporary — they exist so each phase produces a working app while old code still ships. Phase 6 deletes them.

---

## Type Definitions (`src/api/types.ts`)

These mirror the contracts in `docs/p{1,2,3}-*-api.md`. Defined once, imported by the API client and consumers.

```typescript
export type Grain = 'day' | 'week' | 'month'

export interface PeriodWindow {
  date_from: string  // YYYY-MM-DD
  date_to: string
}

export interface TrendPoint {
  bucket: string  // e.g. "2026-04-30" or "2026-W17" or "2026-04"
  value: number
}

export interface DashboardMeta {
  partial_data?: boolean
  notes?: string[]
}

// ----- P1 -----
export interface P1Filters extends PeriodWindow {
  grain: Grain
  agent_name?: string
}
export interface P1Summary {
  inbound_email_count: number
  outbound_email_count: number
  avg_queue_hours: number
  first_response_timeout_count: number
  first_email_count: number
  unreplied_email_count: number
}
export interface P1AgentRow {
  agent_name: string
  outbound_email_count: number
  avg_outbound_emails_per_hour_by_span: number
  avg_outbound_emails_per_hour_by_schedule: number
  qa_reply_counts: { excellent: number; pass: number; fail: number }
}
export interface P1AgentTrendRow {
  agent_name: string
  items: Array<{
    bucket: string
    avg_outbound_emails_per_hour_by_span: number
    avg_outbound_emails_per_hour_by_schedule: number
  }>
}
export interface P1Dashboard {
  filters: P1Filters
  summary: P1Summary
  trends: {
    inbound_email_count: TrendPoint[]
    outbound_email_count: TrendPoint[]
    first_response_timeout_count: TrendPoint[]
    avg_queue_hours?: TrendPoint[]
    first_email_count?: TrendPoint[]
    unreplied_email_count?: TrendPoint[]
  }
  agent_workload: P1AgentRow[]
  agent_workload_trends: P1AgentTrendRow[]
  meta: DashboardMeta
}

// ----- P2 -----
export interface P2Filters extends PeriodWindow {
  grain: Grain
  channel?: string
  category?: string
  spu?: string
  skc?: string
  spu_list?: string[]
  skc_list?: string[]
  listing_date_from?: string
  listing_date_to?: string
  top_n?: number
}
export interface P2OverviewCards {
  order_count: number
  sales_qty: number
  refund_order_count: number
  refund_amount: number
  gmv: number
  net_received_amount: number
  net_revenue_amount: number
  refund_amount_ratio: number
}
export interface P2Overview {
  cards: P2OverviewCards
  trends: {
    order_count: TrendPoint[]
    sales_qty: TrendPoint[]
    refund_order_count: TrendPoint[]
    refund_amount: TrendPoint[]
    gmv: TrendPoint[]
    net_received_amount: TrendPoint[]
    net_revenue_amount: TrendPoint[]
    refund_amount_ratio: TrendPoint[]
  }
  meta: DashboardMeta
}
export interface P2SpuRow {
  spu: string
  sales_qty: number
  sales_amount: number
  refund_qty: number
  refund_amount: number
  refund_qty_ratio: number
  refund_amount_ratio: number
  skc_rows: Array<{
    skc: string
    sales_qty: number
    sales_amount: number
    refund_qty: number
    refund_amount: number
  }>
}

// ----- P3 -----
export type MajorIssueType = 'product' | 'logistics' | 'warehouse'
export interface P3Filters extends PeriodWindow {
  grain: Grain
  date_basis: 'order_date' | 'refund_date'
  spu?: string
  skc?: string
  sku?: string
}
export interface P3Summary {
  sales_qty: number
  complaint_count: number
  complaint_rate: number
}
export interface P3IssueShareItem {
  major_issue_type: MajorIssueType
  label: string
  count: number
  ratio: number
  target_page?: string | null
}
export interface P3Dashboard {
  filters: P3Filters
  summary: P3Summary
  trends: {
    sales_qty: TrendPoint[]
    complaint_count: TrendPoint[]
    complaint_rate: TrendPoint[]
    issue_product_count?: TrendPoint[]    // backend may add later
    issue_logistics_count?: TrendPoint[]
    issue_warehouse_count?: TrendPoint[]
  }
  issue_share: P3IssueShareItem[]
  meta: DashboardMeta
}
export interface P3ProductRankingRow {
  spu: string
  sales_qty: number
  complaint_count: number
  complaint_rate: number
  children: Array<{
    skc: string
    sales_qty: number
    complaint_count: number
    complaint_rate: number
  }>
}
```

**Note on P3 issue trends:** Backend currently returns the three top-level trends only. P3's "产品问题客诉量 / 物流问题客诉量 / 仓库问题客诉量" KPI cards need either backend additions to `trends.issue_*_count` or frontend-side derivation. The plan assumes **the frontend derives them from `issue_share` for the *current period* card value, and falls back to "—" for the focus chart trend until backend adds those series.** Adding the backend series is out of scope for this plan.

---

## Component Contracts

### `DashboardShell`

```typescript
interface DashboardShellProps {
  filterBar: ReactNode
  currentPeriodSection: ReactNode
  focusChart: ReactNode
  historySection: ReactNode
  extensions?: ReactNode
}
```

Renders the five vertical bands. No internal state. Provides the top-level grid + spacing.

### `FilterBar`

```typescript
interface FilterBarProps {
  grain: Grain
  onGrainChange: (next: Grain) => void
  historyRange: PeriodWindow
  onHistoryRangeChange: (next: PeriodWindow) => void
  // Optional store filter (P2 only)
  storeOptions?: Array<{ value: string; label: string }>
  store?: string
  onStoreChange?: (next: string) => void
  // Slot for extra dashboard-specific filters (P3 时间口径, P1 客服姓名)
  extras?: ReactNode
}
```

Owns: grain segmented control, history range date pickers (with `<input type="date|week|month">` driven by grain), optional store select, optional `extras` slot. Internally enforces alignment + no-overlap rules by passing `value` through `alignHistoryRangeToGrain` before emitting `onHistoryRangeChange`.

### `KpiSection`

```typescript
interface KpiSectionProps {
  title: string
  subtitle?: string
  variant: 'current' | 'history'
  children: ReactNode  // KpiCard list
}
```

`variant='current'` → standard styling; `variant='history'` → 米色背景, 灰褐字色, 字号略小.

### `KpiCard`

Two variants share the component, differentiated by `variant` prop:

```typescript
interface KpiCardCurrentProps {
  variant: 'current'
  label: string
  value: string                    // pre-formatted
  delta?: { tone: 'up' | 'down' | 'neutral' | 'muted'; text: string }
  periodAverage: string            // pre-formatted "周期日均"
  sparkline?: TrendPoint[]         // if provided, render <MiniSparkline>
}

interface KpiCardHistoryProps {
  variant: 'history'
  label: string
  total: string                    // pre-formatted "总值"
  periodAverage: string            // pre-formatted "周期均值"
  // For ratio-type metrics: show 区间均值 + 区间峰值 instead
  rateMode?: { mean: string; peak: string }
}

type KpiCardProps = KpiCardCurrentProps | KpiCardHistoryProps
```

### `MiniSparkline`

```typescript
interface MiniSparklineProps {
  items: TrendPoint[]
  tone?: 'sales' | 'complaints' | 'rate'  // for color theming
}
```

Renders an SVG area + line. Geometry from `computeChartGeometry`.

### `FocusLineChart`

```typescript
interface FocusMetricSpec {
  key: string
  label: string
  formatter: (n: number) => string
  history: TrendPoint[]
  current: TrendPoint[]            // usually length 1
}

interface FocusLineChartProps {
  metrics: FocusMetricSpec[]
  defaultKey?: string              // defaults to metrics[0].key
  ariaLabel?: string
}
```

Owns: tab state (active metric key), tooltip state. Renders SVG with two background bands (灰褐 history / 橙 current), dashed boundary line, dashed mean reference line over the history band, points + tooltip-on-hover. Uses `computeChartGeometry`.

### `Table`

```typescript
interface TableColumn<T> {
  key: string
  label: string
  render?: (row: T, index: number) => ReactNode
}

interface TableProps<T> {
  title?: string
  hint?: string
  columns: TableColumn<T>[]
  rows: T[]
  emptyCopy: string
  loading?: boolean
  error?: string
  onRowClick?: (row: T) => void
  rowTone?: (row: T) => string
  children?: ReactNode             // extra content above the table body
}
```

Generic over row shape. Replaces `TableSection` in legacy code.

### `computeChartGeometry`

```typescript
interface ChartBounds {
  left: number; right: number; top: number; bottom: number
}
interface PointProjection {
  x: number; y: number
}
interface UseChartGeometryArgs {
  items: Array<{ value: number; [k: string]: unknown }>
  bounds?: ChartBounds              // default {left:8, right:96, top:10, bottom:86}
  yMinOverride?: number             // default min(items.value, 0)
  yMaxOverride?: number             // default max(items.value, 0)
}
interface UseChartGeometryResult {
  bounds: ChartBounds
  yMin: number
  yMax: number
  project: (value: number, index: number, total: number) => PointProjection
  points: PointProjection[]         // pre-projected items
  pointsString: string              // "x,y x,y ..." for SVG polyline
  areaString: string                // closed polygon down to bottom for area fill
}
```

Single source of truth for the geometry currently duplicated four times.

### `useDashboardData`

```typescript
interface UseDashboardDataArgs<TFilters, TResponse> {
  baseFilters: TFilters             // grain + dashboard-specific extras (no date)
  currentPeriod: PeriodWindow
  previousPeriod: PeriodWindow
  historyRange: PeriodWindow
  fetcher: (filters: TFilters & PeriodWindow, signal: AbortSignal) => Promise<TResponse>
}
interface UseDashboardDataResult<TResponse> {
  current: TResponse | null
  previous: TResponse | null
  history: TResponse | null
  loading: boolean
  error: string
}
```

Issues three parallel `fetcher` calls when any input changes. Aborts on unmount or input change.

---

## Phase 1: TypeScript + Vitest Setup

### Task 1.1: Add TypeScript + tsconfig for the frontend

**Files:**
- Create: `tsconfig.json`
- Modify: `package.json` (devDependencies + scripts)

- [ ] **Step 1: Add devDependencies**

```bash
npm install --save-dev --registry=https://registry.npmmirror.com \
  typescript@^5.6 \
  vitest@^2 \
  jsdom@^24 \
  @types/react@^19 \
  @types/react-dom@^19 \
  typescript-eslint@^8
```

- [ ] **Step 2: Create `tsconfig.json` (frontend)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": false,
    "allowJs": true,
    "noEmit": true,
    "types": ["vite/client", "node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "server", "server-dist"]
}
```

`allowJs: true` lets legacy `.jsx` files coexist during the migration; Phase 6 removes that flag once everything is converted.

- [ ] **Step 3: Add `src/vite-env.d.ts`**

```typescript
/// <reference types="vite/client" />
```

- [ ] **Step 4: Add scripts in `package.json`**

Add under `"scripts"`:
```json
"typecheck": "tsc --noEmit",
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 5: Verify typecheck + dev server still run**

Run:
```bash
npm run typecheck
PATH="/opt/homebrew/bin:$PATH" npm run dev
```

Expected: typecheck passes (legacy .jsx allowed); dev server boots; existing app works in browser at http://localhost:5173.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/vite-env.d.ts
git commit -m "chore(frontend): add TypeScript + Vitest tooling"
```

### Task 1.2: Configure Vitest

**Files:**
- Modify: `vite.config.js`

- [ ] **Step 1: Add Vitest config to `vite.config.js`**

Read current `vite.config.js`, then merge in:
```javascript
test: {
  environment: 'jsdom',
  globals: true,
  include: ['src/**/*.{test,spec}.{ts,tsx}'],
}
```

The full file becomes (adapt to existing imports):
```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
```

- [ ] **Step 2: Smoke-test Vitest with a placeholder test**

Create `src/shared/utils/__sanity__.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'

describe('vitest sanity', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 4: Delete the sanity file and commit**

```bash
rm src/shared/utils/__sanity__.test.ts
git add vite.config.js
git commit -m "chore(frontend): wire up Vitest with jsdom"
```

### Task 1.3: Update ESLint for TypeScript

**Files:**
- Modify: `eslint.config.js`

- [ ] **Step 1: Read current `eslint.config.js`**

Note the existing structure (flat config, plugins, globals).

- [ ] **Step 2: Extend config to handle `.ts` and `.tsx`**

Add `typescript-eslint` to the imports and append a TypeScript block. The minimum addition:
```javascript
import tseslint from 'typescript-eslint'

// inside the exported config array, append:
...tseslint.configs.recommended,
{
  files: ['src/**/*.{ts,tsx}'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
},
```

Keep the existing JS rules so legacy `.jsx` lint still works.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no new errors. Fix any noisy `no-unused-vars` from the existing codebase only if they were already issues.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.js
git commit -m "chore(frontend): enable typescript-eslint"
```

---

## Phase 2: Shared Layer (Utilities → Hooks → Components)

Build bottom-up so each layer can be unit-tested before the next layer depends on it.

### Task 2.1: Create `format.ts`

**Files:**
- Create: `src/shared/utils/format.ts`
- Create: `src/shared/utils/format.test.ts`

- [ ] **Step 1: Write failing test**

`src/shared/utils/format.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import {
  formatInteger, formatPercent, formatHours, formatDecimal, formatMoney,
} from './format'

describe('format', () => {
  it('formats integers with zh-CN locale', () => {
    expect(formatInteger(1234567)).toBe('1,234,567')
    expect(formatInteger(null)).toBe('0')
    expect(formatInteger(undefined)).toBe('0')
  })

  it('formats percent with default 2 digits', () => {
    expect(formatPercent(0.1234)).toBe('12.34%')
    expect(formatPercent(0.1234, 1)).toBe('12.3%')
    expect(formatPercent(null)).toBe('0.00%')
  })

  it('formats hours', () => {
    expect(formatHours(2.45)).toBe('2.5h')
    expect(formatHours(0)).toBe('0.0h')
    expect(formatHours(null)).toBe('0.0h')
  })

  it('formats decimal', () => {
    expect(formatDecimal(2.456)).toBe('2.5')
    expect(formatDecimal(2.456, 2)).toBe('2.46')
    expect(formatDecimal(null)).toBe('0.0')
  })

  it('formats money with $ prefix', () => {
    expect(formatMoney(1234)).toBe('$1,234')
    expect(formatMoney(null)).toBe('--')
  })
})
```

- [ ] **Step 2: Run, verify fails**

Run: `npm test -- format.test`
Expected: FAIL — Cannot find module './format'.

- [ ] **Step 3: Implement**

`src/shared/utils/format.ts`:
```typescript
export function formatInteger(value: number | null | undefined): string {
  return new Intl.NumberFormat('zh-CN').format(value ?? 0)
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  return `${((value ?? 0) * 100).toFixed(digits)}%`
}

export function formatHours(value: number | null | undefined, digits = 1): string {
  return `${(value ?? 0).toFixed(digits)}h`
}

export function formatDecimal(value: number | null | undefined, digits = 1): string {
  return (value ?? 0).toFixed(digits)
}

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return `$${formatInteger(value)}`
}
```

- [ ] **Step 4: Run, verify passes**

Run: `npm test -- format.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/utils/format.ts src/shared/utils/format.test.ts
git commit -m "feat(frontend): add shared format utils with tests"
```

### Task 2.2: Create `datePeriod.ts`

**Files:**
- Create: `src/shared/utils/datePeriod.ts`
- Create: `src/shared/utils/datePeriod.test.ts`

This is the most logic-heavy utility — period calculation, grain alignment, formatting.

- [ ] **Step 1: Write failing test**

`src/shared/utils/datePeriod.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import {
  formatDateInput, parseDateInput, shiftDate,
  getCurrentPeriod, getPreviousPeriod, getDefaultHistoryRange,
  alignHistoryRangeToGrain, isHistoryRangeValid,
  getPeriodCount,
} from './datePeriod'

const today = new Date(2026, 4, 1)  // 2026-05-01 (Friday); T-1 = 2026-04-30 (Thursday)

describe('formatDateInput / parseDateInput / shiftDate', () => {
  it('round-trips a date', () => {
    const d = new Date(2026, 4, 1)
    expect(formatDateInput(d)).toBe('2026-05-01')
    const parsed = parseDateInput('2026-05-01')
    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(4)
    expect(parsed.getDate()).toBe(1)
  })
  it('shifts by days', () => {
    expect(formatDateInput(shiftDate(new Date(2026, 4, 1), -1))).toBe('2026-04-30')
    expect(formatDateInput(shiftDate(new Date(2026, 4, 1), 1))).toBe('2026-05-02')
  })
})

describe('getCurrentPeriod (A semantics)', () => {
  it('day = T-1 to T-1', () => {
    expect(getCurrentPeriod('day', today)).toEqual({
      date_from: '2026-04-30', date_to: '2026-04-30',
    })
  })
  it('week = full Mon-Sun containing T-1', () => {
    // T-1 = 2026-04-30 (Thu). Monday of that week = 2026-04-27. Sunday = 2026-05-03.
    expect(getCurrentPeriod('week', today)).toEqual({
      date_from: '2026-04-27', date_to: '2026-05-03',
    })
  })
  it('month = full month containing T-1', () => {
    // T-1 = 2026-04-30. Month = April 2026.
    expect(getCurrentPeriod('month', today)).toEqual({
      date_from: '2026-04-01', date_to: '2026-04-30',
    })
  })
})

describe('getPreviousPeriod', () => {
  it('day = T-2 to T-2', () => {
    expect(getPreviousPeriod('day', today)).toEqual({
      date_from: '2026-04-29', date_to: '2026-04-29',
    })
  })
  it('week = full prior Mon-Sun', () => {
    expect(getPreviousPeriod('week', today)).toEqual({
      date_from: '2026-04-20', date_to: '2026-04-26',
    })
  })
  it('month = full prior month', () => {
    expect(getPreviousPeriod('month', today)).toEqual({
      date_from: '2026-03-01', date_to: '2026-03-31',
    })
  })
})

describe('getDefaultHistoryRange', () => {
  it('day = 14 days ending T-2', () => {
    expect(getDefaultHistoryRange('day', today)).toEqual({
      date_from: '2026-04-16', date_to: '2026-04-29',
    })
  })
  it('week = 8 prior complete weeks', () => {
    // Last completed Sunday = 2026-04-26. 8 weeks back's Monday = 2026-03-02.
    expect(getDefaultHistoryRange('week', today)).toEqual({
      date_from: '2026-03-02', date_to: '2026-04-26',
    })
  })
  it('month = 2 prior complete months', () => {
    expect(getDefaultHistoryRange('month', today)).toEqual({
      date_from: '2026-02-01', date_to: '2026-03-31',
    })
  })
})

describe('alignHistoryRangeToGrain', () => {
  it('day passes through', () => {
    const w = { date_from: '2026-04-15', date_to: '2026-04-28' }
    expect(alignHistoryRangeToGrain(w, 'day')).toEqual(w)
  })
  it('week aligns to Mon-Sun bounds', () => {
    expect(alignHistoryRangeToGrain(
      { date_from: '2026-04-15', date_to: '2026-04-28' }, 'week',
    )).toEqual({ date_from: '2026-04-13', date_to: '2026-05-03' })
  })
  it('month aligns to 1st-last bounds', () => {
    expect(alignHistoryRangeToGrain(
      { date_from: '2026-02-15', date_to: '2026-04-10' }, 'month',
    )).toEqual({ date_from: '2026-02-01', date_to: '2026-04-30' })
  })
})

describe('isHistoryRangeValid', () => {
  it('rejects overlap with current period', () => {
    expect(isHistoryRangeValid(
      { date_from: '2026-04-15', date_to: '2026-04-30' }, 'day', today,
    )).toBe(false)
  })
  it('accepts non-overlapping', () => {
    expect(isHistoryRangeValid(
      { date_from: '2026-04-15', date_to: '2026-04-29' }, 'day', today,
    )).toBe(true)
  })
})

describe('getPeriodCount', () => {
  it('day count is inclusive day diff', () => {
    expect(getPeriodCount(
      { date_from: '2026-04-15', date_to: '2026-04-28' }, 'day',
    )).toBe(14)
  })
  it('week count is whole weeks', () => {
    expect(getPeriodCount(
      { date_from: '2026-03-02', date_to: '2026-04-26' }, 'week',
    )).toBe(8)
  })
  it('month count is whole months', () => {
    expect(getPeriodCount(
      { date_from: '2026-02-01', date_to: '2026-03-31' }, 'month',
    )).toBe(2)
  })
})
```

- [ ] **Step 2: Run, verify fails**

Run: `npm test -- datePeriod.test`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/shared/utils/datePeriod.ts`:
```typescript
import type { Grain, PeriodWindow } from '../../api/types'

export function formatDateInput(date: Date): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function parseDateInput(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function shiftDate(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

// ISO Monday-start
function startOfWeek(date: Date): Date {
  const day = date.getDay() || 7  // Sunday → 7
  return shiftDate(date, -(day - 1))
}

function endOfWeek(date: Date): Date {
  return shiftDate(startOfWeek(date), 6)
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0)
}

export function getCurrentPeriod(grain: Grain, today: Date = new Date()): PeriodWindow {
  const tMinus1 = shiftDate(today, -1)
  if (grain === 'day') {
    return { date_from: formatDateInput(tMinus1), date_to: formatDateInput(tMinus1) }
  }
  if (grain === 'week') {
    return {
      date_from: formatDateInput(startOfWeek(tMinus1)),
      date_to: formatDateInput(endOfWeek(tMinus1)),
    }
  }
  return {
    date_from: formatDateInput(startOfMonth(tMinus1)),
    date_to: formatDateInput(endOfMonth(tMinus1)),
  }
}

export function getPreviousPeriod(grain: Grain, today: Date = new Date()): PeriodWindow {
  const current = getCurrentPeriod(grain, today)
  const currentStart = parseDateInput(current.date_from)
  if (grain === 'day') {
    const prev = shiftDate(currentStart, -1)
    return { date_from: formatDateInput(prev), date_to: formatDateInput(prev) }
  }
  if (grain === 'week') {
    const prevMonday = shiftDate(currentStart, -7)
    return {
      date_from: formatDateInput(prevMonday),
      date_to: formatDateInput(shiftDate(prevMonday, 6)),
    }
  }
  const prevMonth = new Date(currentStart.getFullYear(), currentStart.getMonth() - 1, 1)
  return {
    date_from: formatDateInput(prevMonth),
    date_to: formatDateInput(endOfMonth(prevMonth)),
  }
}

export function getDefaultHistoryRange(grain: Grain, today: Date = new Date()): PeriodWindow {
  const current = getCurrentPeriod(grain, today)
  const currentStart = parseDateInput(current.date_from)
  if (grain === 'day') {
    const end = shiftDate(currentStart, -1)
    return { date_from: formatDateInput(shiftDate(end, -13)), date_to: formatDateInput(end) }
  }
  if (grain === 'week') {
    const lastSunday = shiftDate(currentStart, -1)
    const startMonday = shiftDate(lastSunday, -(7 * 8 - 1))
    return { date_from: formatDateInput(startMonday), date_to: formatDateInput(lastSunday) }
  }
  const startMonth = new Date(currentStart.getFullYear(), currentStart.getMonth() - 2, 1)
  const endMonth = endOfMonth(new Date(currentStart.getFullYear(), currentStart.getMonth() - 1, 1))
  return { date_from: formatDateInput(startMonth), date_to: formatDateInput(endMonth) }
}

export function alignHistoryRangeToGrain(window: PeriodWindow, grain: Grain): PeriodWindow {
  if (grain === 'day') return window
  const start = parseDateInput(window.date_from)
  const end = parseDateInput(window.date_to)
  if (grain === 'week') {
    return {
      date_from: formatDateInput(startOfWeek(start)),
      date_to: formatDateInput(endOfWeek(end)),
    }
  }
  return {
    date_from: formatDateInput(startOfMonth(start)),
    date_to: formatDateInput(endOfMonth(end)),
  }
}

export function isHistoryRangeValid(
  window: PeriodWindow, grain: Grain, today: Date = new Date(),
): boolean {
  const current = getCurrentPeriod(grain, today)
  return window.date_to < current.date_from
}

export function getPeriodCount(window: PeriodWindow, grain: Grain): number {
  const start = parseDateInput(window.date_from)
  const end = parseDateInput(window.date_to)
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  if (grain === 'day') return days
  if (grain === 'week') return Math.round(days / 7)
  // month: count by year/month diff
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1
}
```

- [ ] **Step 4: Run, verify passes**

Run: `npm test -- datePeriod.test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/utils/datePeriod.ts src/shared/utils/datePeriod.test.ts
git commit -m "feat(frontend): add datePeriod utils with locked semantics"
```

### Task 2.3: Create `apiClient.ts`

**Files:**
- Create: `src/shared/utils/apiClient.ts`

- [ ] **Step 1: Implement**

```typescript
type QueryValue = string | number | boolean | null | undefined | string[]

export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== null && item !== undefined && item !== '') {
          search.append(key, String(item))
        }
      })
      return
    }
    if (value !== null && value !== undefined && value !== '') {
      search.set(key, String(value))
    }
  })
  return search.toString()
}

export async function request<T>(
  path: string,
  params: Record<string, QueryValue>,
  signal?: AbortSignal,
): Promise<T> {
  const query = buildQuery(params)
  const response = await fetch(query ? `${path}?${query}` : path, { signal })
  if (!response.ok) {
    throw new Error(`请求失败：${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/utils/apiClient.ts
git commit -m "feat(frontend): add unified apiClient (buildQuery + request)"
```

### Task 2.4: Create API types + rewrite `src/api/{p1,p2,p3}.{js→ts}`

**Files:**
- Create: `src/api/types.ts`
- Create: `src/api/p1.ts`, `src/api/p2.ts`, `src/api/p3.ts`
- Delete: `src/api/p1.js`, `src/api/p2.js`, `src/api/p3.js`

- [ ] **Step 1: Create `src/api/types.ts`**

Paste the full type definitions from the "Type Definitions" section of this plan (above).

- [ ] **Step 2: Create `src/api/p1.ts`**

```typescript
import { request } from '../shared/utils/apiClient'
import type { P1Filters, P1Dashboard } from './types'

export function fetchP1Dashboard(
  filters: P1Filters, signal?: AbortSignal,
): Promise<P1Dashboard> {
  return request<P1Dashboard>('/api/bi/p1/dashboard', filters as never, signal)
}
```

- [ ] **Step 3: Create `src/api/p2.ts`**

```typescript
import { request } from '../shared/utils/apiClient'
import type {
  P2Filters, P2Overview, P2SpuRow,
} from './types'

export function fetchRefundOverview(
  filters: P2Filters, signal?: AbortSignal,
): Promise<P2Overview> {
  return request<P2Overview>('/api/bi/p2/refund-dashboard/overview', filters as never, signal)
}

export function fetchRefundSpuTable(
  filters: P2Filters, signal?: AbortSignal,
): Promise<{ rows: P2SpuRow[] }> {
  return request<{ rows: P2SpuRow[] }>('/api/bi/p2/refund-dashboard/spu-table', filters as never, signal)
}

export function fetchRefundSpuSkcOptions(
  filters: P2Filters, signal?: AbortSignal,
): Promise<{ options: { spus: string[]; skcs: string[]; pairs: Array<{ spu: string; skc: string }> } }> {
  return request('/api/bi/p2/refund-dashboard/spu-skc-options', filters as never, signal)
}
```

- [ ] **Step 4: Create `src/api/p3.ts`**

```typescript
import { request } from '../shared/utils/apiClient'
import type {
  P3Filters, P3Dashboard, P3IssueShareItem, P3ProductRankingRow,
} from './types'

export function fetchDashboard(
  filters: P3Filters, signal?: AbortSignal,
): Promise<P3Dashboard> {
  return request<P3Dashboard>('/api/bi/p3/dashboard', filters as never, signal)
}

export function fetchDrilldownOptions(
  filters: P3Filters, signal?: AbortSignal,
): Promise<{ options: P3IssueShareItem[] }> {
  return request('/api/bi/p3/drilldown-options', filters as never, signal)
}

export function fetchProductRanking(
  filters: P3Filters, signal?: AbortSignal,
): Promise<{ ranking: P3ProductRankingRow[] }> {
  return request('/api/bi/p3/product-ranking', filters as never, signal)
}
```

- [ ] **Step 5: Delete the old `.js` files**

```bash
rm src/api/p1.js src/api/p2.js src/api/p3.js
```

The legacy `.jsx` Dashboard files import these via `./api/p1` etc. — Vite/TS resolution still finds the `.ts` files, so legacy code keeps working unchanged.

- [ ] **Step 6: Verify typecheck + dev server**

Run: `npm run typecheck && PATH="/opt/homebrew/bin:$PATH" npm run dev`
Manually verify: open http://localhost:5173, click through P1/P2/P3, all data loads as before.

- [ ] **Step 7: Commit**

```bash
git add src/api/
git commit -m "refactor(frontend): port api/* to TypeScript with shared client"
```

### Task 2.5: Create `computeChartGeometry.ts`

**Files:**
- Create: `src/shared/utils/computeChartGeometry.ts`
- Create: `src/shared/utils/computeChartGeometry.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { computeChartGeometry } from './computeChartGeometry'

describe('computeChartGeometry', () => {
  it('projects items into bounds', () => {
    const result = computeChartGeometry({ items: [
      { value: 0 }, { value: 50 }, { value: 100 },
    ]})
    expect(result.points).toHaveLength(3)
    expect(result.points[0].x).toBe(8)    // left bound
    expect(result.points[2].x).toBe(96)   // right bound
    expect(result.points[2].y).toBe(10)   // top bound (max value)
    expect(result.points[0].y).toBe(86)   // bottom bound (min value)
  })

  it('returns single-point at center x=50', () => {
    const result = computeChartGeometry({ items: [{ value: 5 }] })
    expect(result.points[0].x).toBe(50)
  })

  it('handles all-zero items without divide-by-zero', () => {
    const result = computeChartGeometry({ items: [
      { value: 0 }, { value: 0 }, { value: 0 },
    ]})
    expect(Number.isFinite(result.points[0].y)).toBe(true)
  })

  it('builds pointsString and areaString', () => {
    const result = computeChartGeometry({ items: [
      { value: 0 }, { value: 100 },
    ]})
    expect(result.pointsString).toBe('8,86 96,10')
    expect(result.areaString.startsWith('8,86')).toBe(true)
    expect(result.areaString.endsWith('96,86')).toBe(true)  // closes back to bottom
  })

  it('respects yMinOverride / yMaxOverride', () => {
    const result = computeChartGeometry({
      items: [{ value: 50 }],
      yMinOverride: 0,
      yMaxOverride: 100,
    })
    // value 50 with [0, 100] range → midpoint y
    expect(result.points[0].y).toBeCloseTo((10 + 86) / 2, 1)
  })
})
```

- [ ] **Step 2: Run, verify fails**

Run: `npm test -- computeChartGeometry.test`

- [ ] **Step 3: Implement**

```typescript
const DEFAULT_BOUNDS = { left: 8, right: 96, top: 10, bottom: 86 }

interface ChartBounds {
  left: number
  right: number
  top: number
  bottom: number
}

interface UseChartGeometryArgs<T extends { value: number }> {
  items: T[]
  bounds?: ChartBounds
  yMinOverride?: number
  yMaxOverride?: number
}

export function computeChartGeometry<T extends { value: number }>(
  args: UseChartGeometryArgs<T>,
) {
  const bounds = args.bounds ?? DEFAULT_BOUNDS
  const items = args.items
  const values = items.map((item) => item.value)
  const yMin = args.yMinOverride ?? Math.min(...values, 0)
  const yMax = args.yMaxOverride ?? Math.max(...values, 0)
  const yRange = yMax === yMin ? 1 : yMax - yMin
  const xRange = bounds.right - bounds.left
  const yPixelRange = bounds.bottom - bounds.top

  const points = items.map((item, index) => {
    const x = items.length === 1
      ? 50
      : bounds.left + (index / (items.length - 1)) * xRange
    const y = bounds.bottom - ((item.value - yMin) / yRange) * yPixelRange
    return { x, y }
  })

  const pointsString = points.map((p) => `${p.x},${p.y}`).join(' ')
  const firstX = points[0]?.x ?? 0
  const lastX = points[points.length - 1]?.x ?? 0
  const areaString = points.length
    ? `${firstX},${bounds.bottom} ${pointsString} ${lastX},${bounds.bottom}`
    : ''

  return { bounds, yMin, yMax, points, pointsString, areaString }
}
```

Note: this is *not* actually a React hook (no `useState`/`useMemo` needed), but we keep the `use*` name to match the conceptual role and stay consistent with `useDashboardData`.

- [ ] **Step 4: Run, verify passes**

Run: `npm test -- computeChartGeometry.test`

- [ ] **Step 5: Commit**

```bash
git add src/shared/utils/computeChartGeometry.ts src/shared/utils/computeChartGeometry.test.ts
git commit -m "feat(frontend): add computeChartGeometry shared computation"
```

### Task 2.6: Create `useDashboardData.ts`

**Files:**
- Create: `src/shared/hooks/useDashboardData.ts`

- [ ] **Step 1: Implement**

```typescript
import { useEffect, useState } from 'react'
import type { PeriodWindow } from '../../api/types'

interface UseDashboardDataArgs<TBaseFilters, TResponse> {
  baseFilters: TBaseFilters
  currentPeriod: PeriodWindow
  previousPeriod: PeriodWindow
  historyRange: PeriodWindow
  fetcher: (filters: TBaseFilters & PeriodWindow, signal: AbortSignal) => Promise<TResponse>
}

interface UseDashboardDataResult<TResponse> {
  current: TResponse | null
  previous: TResponse | null
  history: TResponse | null
  loading: boolean
  error: string
}

export function useDashboardData<TBaseFilters, TResponse>(
  args: UseDashboardDataArgs<TBaseFilters, TResponse>,
): UseDashboardDataResult<TResponse> {
  const { baseFilters, currentPeriod, previousPeriod, historyRange, fetcher } = args
  const [current, setCurrent] = useState<TResponse | null>(null)
  const [previous, setPrevious] = useState<TResponse | null>(null)
  const [history, setHistory] = useState<TResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Stringify date windows for stable dep comparison
  const cKey = `${currentPeriod.date_from}|${currentPeriod.date_to}`
  const pKey = `${previousPeriod.date_from}|${previousPeriod.date_to}`
  const hKey = `${historyRange.date_from}|${historyRange.date_to}`
  const fKey = JSON.stringify(baseFilters)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    async function run() {
      setLoading(true)
      setError('')
      try {
        const [c, p, h] = await Promise.all([
          fetcher({ ...baseFilters, ...currentPeriod }, controller.signal),
          fetcher({ ...baseFilters, ...previousPeriod }, controller.signal),
          fetcher({ ...baseFilters, ...historyRange }, controller.signal),
        ])
        if (cancelled) return
        setCurrent(c)
        setPrevious(p)
        setHistory(h)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        if (cancelled) return
        setCurrent(null)
        setPrevious(null)
        setHistory(null)
        setError((err as Error).message || '加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()
    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fKey, cKey, pKey, hKey])

  return { current, previous, history, loading, error }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`

- [ ] **Step 3: Commit**

```bash
git add src/shared/hooks/useDashboardData.ts
git commit -m "feat(frontend): add useDashboardData with 3-window parallel fetch"
```

### Task 2.7: Create `MiniSparkline`

**Files:**
- Create: `src/shared/components/MiniSparkline.tsx`

- [ ] **Step 1: Implement**

```typescript
import { computeChartGeometry } from '../utils/computeChartGeometry'
import type { TrendPoint } from '../../api/types'

interface MiniSparklineProps {
  items: TrendPoint[]
  tone?: 'sales' | 'complaints' | 'rate' | 'neutral'
}

export function MiniSparkline({ items, tone = 'neutral' }: MiniSparklineProps) {
  if (!items.length) {
    return <div className="mini-placeholder">当前卡片不展示趋势折线</div>
  }
  const { pointsString, areaString } = computeChartGeometry({ items })
  return (
    <div className={`mini-chart mini-chart--${tone}`} aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="mini-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <polyline fill="url(#mini-gradient)" points={areaString} />
        <polyline className="mini-chart__line" fill="none" points={pointsString} />
      </svg>
    </div>
  )
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`

- [ ] **Step 3: Commit**

```bash
git add src/shared/components/MiniSparkline.tsx
git commit -m "feat(frontend): add MiniSparkline shared component"
```

### Task 2.8: Create `KpiCard`

**Files:**
- Create: `src/shared/components/KpiCard.tsx`

- [ ] **Step 1: Implement**

```typescript
import { useId } from 'react'
import { MiniSparkline } from './MiniSparkline'
import type { TrendPoint } from '../../api/types'

interface DeltaInfo {
  tone: 'up' | 'down' | 'neutral' | 'muted'
  text: string
}

export interface KpiCardCurrentProps {
  variant: 'current'
  label: string
  value: string
  delta?: DeltaInfo
  periodAverage: string
  description?: string
  sparkline?: TrendPoint[]
  sparklineTone?: 'sales' | 'complaints' | 'rate' | 'neutral'
}

export interface KpiCardHistoryProps {
  variant: 'history'
  label: string
  total: string
  periodAverage: string
  description?: string
  rateMode?: { mean: string; peak: string }
}

export type KpiCardProps = KpiCardCurrentProps | KpiCardHistoryProps

export function KpiCard(props: KpiCardProps) {
  const descriptionId = useId()
  const className = `kpi-card kpi-card--${props.variant}`

  return (
    <article className={className}>
      <div className="kpi-card__header">
        <h3 className="kpi-card__label" aria-describedby={props.description ? descriptionId : undefined}>
          {props.label}
          {props.description ? (
            <>
              <span className="kpi-card__info" aria-hidden="true">?</span>
              <span id={descriptionId} role="tooltip" className="kpi-card__tooltip">
                {props.description}
              </span>
            </>
          ) : null}
        </h3>
        {props.variant === 'current' && props.delta ? (
          <span className={`kpi-card__delta kpi-card__delta--${props.delta.tone}`}>
            {props.delta.text}
          </span>
        ) : null}
      </div>

      {props.variant === 'current' ? (
        <>
          <div className="kpi-card__value">{props.value}</div>
          <div className="kpi-card__secondary">
            <span>周期日均</span>
            <strong>{props.periodAverage}</strong>
          </div>
          {props.sparkline?.length ? (
            <MiniSparkline items={props.sparkline} tone={props.sparklineTone} />
          ) : null}
        </>
      ) : props.rateMode ? (
        <>
          <div className="kpi-card__value">{props.rateMode.mean}</div>
          <div className="kpi-card__secondary">
            <span>区间均值 / 峰值</span>
            <strong>{props.rateMode.mean} / {props.rateMode.peak}</strong>
          </div>
        </>
      ) : (
        <>
          <div className="kpi-card__value">{props.total}</div>
          <div className="kpi-card__secondary">
            <span>周期均值</span>
            <strong>{props.periodAverage}</strong>
          </div>
        </>
      )}
    </article>
  )
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`

- [ ] **Step 3: Commit**

```bash
git add src/shared/components/KpiCard.tsx
git commit -m "feat(frontend): add KpiCard with current/history variants"
```

### Task 2.9: Create `KpiSection`

**Files:**
- Create: `src/shared/components/KpiSection.tsx`

- [ ] **Step 1: Implement**

```typescript
import type { ReactNode } from 'react'

interface KpiSectionProps {
  title: string
  subtitle?: string
  variant: 'current' | 'history'
  children: ReactNode
}

export function KpiSection({ title, subtitle, variant, children }: KpiSectionProps) {
  return (
    <section className={`kpi-section kpi-section--${variant}`}>
      <header className="kpi-section__header">
        <h2 className="kpi-section__title">{title}</h2>
        {subtitle ? <span className="kpi-section__subtitle">{subtitle}</span> : null}
      </header>
      <div className="kpi-section__grid">
        {children}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Verify typecheck + commit**

```bash
npm run typecheck
git add src/shared/components/KpiSection.tsx
git commit -m "feat(frontend): add KpiSection container"
```

### Task 2.10: Create `FocusLineChart`

**Files:**
- Create: `src/shared/components/FocusLineChart.tsx`

The most complex shared component. Owns: tab state, tooltip state, and the dual-band rendering.

- [ ] **Step 1: Implement skeleton**

```typescript
import { useMemo, useState } from 'react'
import { computeChartGeometry } from '../utils/computeChartGeometry'
import type { TrendPoint } from '../../api/types'

export interface FocusMetricSpec {
  key: string
  label: string
  formatter: (n: number) => string
  history: TrendPoint[]
  current: TrendPoint[]
}

interface FocusLineChartProps {
  metrics: FocusMetricSpec[]
  defaultKey?: string
  ariaLabel?: string
}

interface TooltipState {
  bucket: string
  valueText: string
  x: number
  y: number
}

export function FocusLineChart({ metrics, defaultKey, ariaLabel }: FocusLineChartProps) {
  const [activeKey, setActiveKey] = useState<string>(defaultKey ?? metrics[0]?.key ?? '')
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  const active = useMemo(
    () => metrics.find((m) => m.key === activeKey) ?? metrics[0],
    [metrics, activeKey],
  )

  if (!active) return <div className="empty-state">暂无指标</div>

  const allPoints = [...active.history, ...active.current]
  const geo = computeChartGeometry({ items: allPoints })
  const historyCount = active.history.length
  const totalCount = allPoints.length
  const dividerX = historyCount === 0
    ? geo.bounds.left
    : historyCount === totalCount
      ? geo.bounds.right
      : (geo.points[historyCount - 1].x + geo.points[historyCount].x) / 2

  const historyMean = historyCount
    ? active.history.reduce((sum, p) => sum + p.value, 0) / historyCount
    : 0
  const meanY = geo.bounds.bottom -
    ((historyMean - geo.yMin) / (geo.yMax === geo.yMin ? 1 : geo.yMax - geo.yMin)) *
    (geo.bounds.bottom - geo.bounds.top)

  function handleHover(point: { x: number; y: number }, raw: TrendPoint) {
    setTooltip({
      bucket: raw.bucket,
      valueText: active!.formatter(raw.value),
      x: point.x,
      y: point.y,
    })
  }

  return (
    <section className="focus-chart">
      <div className="focus-chart__tabs" role="tablist">
        {metrics.map((m) => (
          <button
            key={m.key}
            type="button"
            role="tab"
            aria-selected={m.key === activeKey}
            className={`focus-chart__tab ${m.key === activeKey ? 'focus-chart__tab--active' : ''}`}
            onClick={() => setActiveKey(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="focus-chart__plot" onMouseLeave={() => setTooltip(null)}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={ariaLabel ?? active.label}>
          {/* History band background */}
          <rect className="focus-chart__band focus-chart__band--history"
            x={geo.bounds.left} y={geo.bounds.top}
            width={dividerX - geo.bounds.left} height={geo.bounds.bottom - geo.bounds.top} />
          {/* Current band background */}
          <rect className="focus-chart__band focus-chart__band--current"
            x={dividerX} y={geo.bounds.top}
            width={geo.bounds.right - dividerX} height={geo.bounds.bottom - geo.bounds.top} />
          {/* Divider */}
          <line className="focus-chart__divider"
            x1={dividerX} x2={dividerX} y1={geo.bounds.top} y2={geo.bounds.bottom} />
          {/* History mean reference line */}
          {historyCount ? (
            <line className="focus-chart__mean-line"
              x1={geo.bounds.left} x2={dividerX} y1={meanY} y2={meanY} />
          ) : null}
          {/* Polyline */}
          <polyline className="focus-chart__line" fill="none" points={geo.pointsString} />
          {/* Highlight last current point */}
          {active.current.length ? (() => {
            const lastPoint = geo.points[geo.points.length - 1]
            return <circle className="focus-chart__latest" cx={lastPoint.x} cy={lastPoint.y} r="2.2" />
          })() : null}
          {/* Hit areas */}
          {allPoints.map((raw, i) => (
            <g key={`${raw.bucket}-${i}`} className="focus-chart__hit"
              onMouseEnter={() => handleHover(geo.points[i], raw)}
              onFocus={() => handleHover(geo.points[i], raw)}
              tabIndex={0}>
              <circle cx={geo.points[i].x} cy={geo.points[i].y} r="6" fill="transparent" />
            </g>
          ))}
        </svg>
        {tooltip ? (
          <div className={`focus-chart__tooltip ${tooltip.x > 82 ? 'focus-chart__tooltip--left' : ''}`}
            style={{ left: `${tooltip.x}%`, top: `${tooltip.y}%` }}>
            <span>{tooltip.bucket}</span>
            <strong>{active.label}：{tooltip.valueText}</strong>
          </div>
        ) : null}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`

- [ ] **Step 3: Commit**

```bash
git add src/shared/components/FocusLineChart.tsx
git commit -m "feat(frontend): add FocusLineChart with banded background + mean line"
```

### Task 2.11: Create `FilterBar`

**Files:**
- Create: `src/shared/components/FilterBar.tsx`

- [ ] **Step 1: Implement**

```typescript
import type { ReactNode } from 'react'
import {
  alignHistoryRangeToGrain, isHistoryRangeValid,
} from '../utils/datePeriod'
import type { Grain, PeriodWindow } from '../../api/types'

const GRAIN_OPTIONS: Array<{ value: Grain; label: string }> = [
  { value: 'day', label: '按日' },
  { value: 'week', label: '按周' },
  { value: 'month', label: '按月' },
]

interface FilterBarProps {
  grain: Grain
  onGrainChange: (next: Grain) => void
  historyRange: PeriodWindow
  onHistoryRangeChange: (next: PeriodWindow) => void
  storeOptions?: Array<{ value: string; label: string }>
  store?: string
  onStoreChange?: (next: string) => void
  extras?: ReactNode
}

export function FilterBar({
  grain, onGrainChange,
  historyRange, onHistoryRangeChange,
  storeOptions, store, onStoreChange,
  extras,
}: FilterBarProps) {
  const handleDateChange = (field: 'date_from' | 'date_to', value: string) => {
    if (!value) return
    const next = alignHistoryRangeToGrain({ ...historyRange, [field]: value }, grain)
    if (next.date_from > next.date_to) return
    if (!isHistoryRangeValid(next, grain)) return
    onHistoryRangeChange(next)
  }

  return (
    <section className="filter-bar">
      <div className="filter-bar__group">
        <span className="filter-bar__label">时间粒度</span>
        <div className="segmented-control" role="tablist">
          {GRAIN_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={grain === opt.value}
              className={`segment-button ${grain === opt.value ? 'segment-button--active' : ''}`}
              onClick={() => onGrainChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {storeOptions && onStoreChange ? (
        <div className="filter-bar__group">
          <span className="filter-bar__label">店铺</span>
          <select className="select-control" value={store ?? ''}
            onChange={(e) => onStoreChange(e.target.value)}>
            <option value="">全部</option>
            {storeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="filter-bar__group filter-bar__group--dates">
        <span className="filter-bar__label">历史区间</span>
        <div className="date-range-control">
          <label className="date-field">
            <span>起</span>
            <input type="date" value={historyRange.date_from}
              max={historyRange.date_to}
              onChange={(e) => handleDateChange('date_from', e.target.value)} />
          </label>
          <label className="date-field">
            <span>终</span>
            <input type="date" value={historyRange.date_to}
              min={historyRange.date_from}
              onChange={(e) => handleDateChange('date_to', e.target.value)} />
          </label>
        </div>
      </div>

      {extras}
    </section>
  )
}
```

- [ ] **Step 2: Verify typecheck + commit**

```bash
npm run typecheck
git add src/shared/components/FilterBar.tsx
git commit -m "feat(frontend): add FilterBar with grain + history + optional store"
```

### Task 2.12: Create `DashboardShell`

**Files:**
- Create: `src/shared/components/DashboardShell.tsx`

- [ ] **Step 1: Implement**

```typescript
import type { ReactNode } from 'react'

interface DashboardShellProps {
  filterBar: ReactNode
  currentPeriodSection: ReactNode
  focusChart: ReactNode
  historySection: ReactNode
  extensions?: ReactNode
  banner?: ReactNode  // for error / partial-data status banners
}

export function DashboardShell({
  filterBar, currentPeriodSection, focusChart, historySection,
  extensions, banner,
}: DashboardShellProps) {
  return (
    <main className="dashboard-shell">
      {filterBar}
      {banner}
      {currentPeriodSection}
      {focusChart}
      {historySection}
      {extensions}
    </main>
  )
}
```

- [ ] **Step 2: Verify typecheck + commit**

```bash
npm run typecheck
git add src/shared/components/DashboardShell.tsx
git commit -m "feat(frontend): add DashboardShell layout"
```

### Task 2.13: Create `Table`

**Files:**
- Create: `src/shared/components/Table.tsx`

- [ ] **Step 1: Implement**

```typescript
import type { ReactNode } from 'react'

export interface TableColumn<T> {
  key: string
  label: string
  render?: (row: T, index: number) => ReactNode
}

interface TableProps<T> {
  title?: string
  hint?: string
  columns: TableColumn<T>[]
  rows: T[]
  emptyCopy: string
  loading?: boolean
  error?: string
  onRowClick?: (row: T) => void
  rowTone?: (row: T) => string
  children?: ReactNode
}

export function Table<T>({
  title, hint, columns, rows, emptyCopy, loading, error,
  onRowClick, rowTone, children,
}: TableProps<T>) {
  return (
    <section className="data-table-card">
      {(title || hint) ? (
        <header className="data-table-card__header">
          {title ? <h3>{title}</h3> : null}
          {hint ? <p className="data-table-card__hint">{hint}</p> : null}
        </header>
      ) : null}
      {children ? <div className="data-table-card__content">{children}</div> : null}
      {loading ? (
        <div className="empty-state">正在加载...</div>
      ) : error ? (
        <div className="empty-state empty-state--error">{error}</div>
      ) : rows.length ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const cells = columns.map((c) => (
                  <td key={c.key} data-label={c.label}>
                    {c.render ? c.render(row, index) : (row as Record<string, unknown>)[c.key] as ReactNode}
                  </td>
                ))
                if (onRowClick) {
                  return (
                    <tr key={index}
                      className={`is-clickable ${rowTone ? rowTone(row) : ''}`}
                      onClick={() => onRowClick(row)}>
                      {cells}
                    </tr>
                  )
                }
                return <tr key={index}>{cells}</tr>
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state empty-state--table">{emptyCopy}</div>
      )}
    </section>
  )
}
```

- [ ] **Step 2: Verify typecheck + commit**

```bash
npm run typecheck
git add src/shared/components/Table.tsx
git commit -m "feat(frontend): add generic Table component"
```

### Task 2.14: Convert `App.jsx` and `main.jsx` to TypeScript

**Files:**
- Create: `src/App.tsx`
- Create: `src/main.tsx`
- Delete: `src/App.jsx`, `src/main.jsx`
- Modify: `index.html` (script src)

- [ ] **Step 1: Read current `App.jsx` and `main.jsx`**

- [ ] **Step 2: Write `src/main.tsx` (verbatim port)**

```typescript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 3: Write `src/App.tsx`**

Port `src/App.jsx` to TypeScript. Keep behaviour identical except:
- Fix the `?? PAGE_OPTIONS[2]` bug (line 39): change to `?? PAGE_OPTIONS[0]`
- Remove the duplicate inline `PlaceholderPage` (use as a local function with a `title: string` prop)

Type signature:
```typescript
interface PageOption {
  value: 'p1' | 'p2' | 'p3'
  shortTitle: string
  title: string
  description: string
}
```

- [ ] **Step 4: Update `index.html`**

Change:
```html
<script type="module" src="/src/main.jsx"></script>
```
to:
```html
<script type="module" src="/src/main.tsx"></script>
```

- [ ] **Step 5: Delete old files**

```bash
rm src/App.jsx src/main.jsx
```

- [ ] **Step 6: Verify build + dev server**

Run:
```bash
npm run typecheck
npm run build
PATH="/opt/homebrew/bin:$PATH" npm run dev
```

Manually verify: app boots at http://localhost:5173, side nav switches between P1/P2/P3, all three load (still using legacy Dashboard files).

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/main.tsx index.html
git commit -m "refactor(frontend): port App + main to TypeScript, fix tab fallback bug"
```

---

## Phase 3: P3 Rewrite

P3 is the smallest dashboard and validates the unified framework end-to-end before we tackle P2/P1.

### Task 3.1: Move legacy P3 to `features/p3/legacy/`

**Files:**
- Create: `src/features/p3/legacy/P3Dashboard.jsx` (move existing `src/P3Dashboard.jsx`)
- Modify: `src/App.tsx` (import path)

- [ ] **Step 1: Move file**

```bash
mkdir -p src/features/p3/legacy
git mv src/P3Dashboard.jsx src/features/p3/legacy/P3Dashboard.jsx
```

- [ ] **Step 2: Update import in `src/App.tsx`**

Change `import P3Dashboard from './P3Dashboard'` → `import P3Dashboard from './features/p3/legacy/P3Dashboard'`.

- [ ] **Step 3: Verify dev server still runs**

Run: `PATH="/opt/homebrew/bin:$PATH" npm run dev`, open browser, verify P3 still loads.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/features/p3/legacy/P3Dashboard.jsx
git commit -m "chore(frontend): stash legacy P3Dashboard before rewrite"
```

### Task 3.2: Implement `IssueStructure.tsx`

**Files:**
- Create: `src/features/p3/IssueStructure.tsx`

This is the "问题结构分析" extension-area component, lifted from legacy.

- [ ] **Step 1: Read legacy `src/features/p3/legacy/P3Dashboard.jsx`**

Note: `issueRows` derivation, `issueColumns` definition, `ISSUE_COPY` lookup.

- [ ] **Step 2: Create `src/features/p3/IssueStructure.tsx`**

```typescript
import { useMemo } from 'react'
import { Table } from '../../shared/components/Table'
import { formatPercent } from '../../shared/utils/format'
import type { P3Dashboard, P3IssueShareItem } from '../../api/types'

const ISSUE_ORDER: Array<P3IssueShareItem['major_issue_type']> = ['product', 'logistics', 'warehouse']
const ISSUE_LABELS: Record<P3IssueShareItem['major_issue_type'], { label: string; accent: string }> = {
  product: { label: '产品问题', accent: 'issue-row--product' },
  logistics: { label: '物流问题', accent: 'issue-row--logistics' },
  warehouse: { label: '仓库问题', accent: 'issue-row--warehouse' },
}

interface IssueRow {
  major_issue_type: P3IssueShareItem['major_issue_type']
  label: string
  count: number
  ratio: number
  estimatedRate: number
}

interface IssueStructureProps {
  dashboard: P3Dashboard | null
  options: P3IssueShareItem[]
}

export function IssueStructure({ dashboard, options }: IssueStructureProps) {
  const rows = useMemo<IssueRow[]>(() => {
    const optionsByType = new Map(options.map((o) => [o.major_issue_type, o]))
    const itemsByType = new Map((dashboard?.issue_share ?? []).map((o) => [o.major_issue_type, o]))
    const salesQty = dashboard?.summary.sales_qty ?? 0
    return ISSUE_ORDER.map((type) => {
      const item = itemsByType.get(type)
      const opt = optionsByType.get(type)
      const count = item?.count ?? opt?.count ?? 0
      return {
        major_issue_type: type,
        label: item?.label ?? opt?.label ?? ISSUE_LABELS[type].label,
        count,
        ratio: item?.ratio ?? opt?.ratio ?? 0,
        estimatedRate: salesQty ? count / salesQty : 0,
      }
    })
  }, [dashboard, options])

  return (
    <Table<IssueRow>
      title="问题结构分析"
      hint="客诉率为按订单数估算的分类客诉率"
      columns={[
        {
          key: 'label',
          label: '客诉原因',
          render: (row) => (
            <span className={`issue-label ${ISSUE_LABELS[row.major_issue_type].accent}`}>{row.label}</span>
          ),
        },
        { key: 'estimatedRate', label: '客诉率', render: (row) => formatPercent(row.estimatedRate, 2) },
        { key: 'ratio', label: '客诉占比', render: (row) => formatPercent(row.ratio, 1) },
      ]}
      rows={rows}
      emptyCopy="暂无问题结构数据"
    />
  )
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/features/p3/IssueStructure.tsx
git commit -m "feat(frontend/p3): extract IssueStructure extension component"
```

### Task 3.3: Implement `ProductComplaintRanking.tsx`

**Files:**
- Create: `src/features/p3/ProductComplaintRanking.tsx`

Lifted from legacy `dashboardComponents.jsx#ProductRankingSection`. Same SPU/SKC drill behaviour.

- [ ] **Step 1: Read legacy `src/dashboardComponents.jsx` lines 426–590**

Note: `RankingPagination`, `expandedSpus` state, page slicing logic.

- [ ] **Step 2: Create `src/features/p3/ProductComplaintRanking.tsx`**

Port the JSX structure preserving every behaviour: pagination, page-size select, expand/collapse SPU rows. Use TypeScript types:

```typescript
import { useState } from 'react'
import { formatInteger, formatPercent } from '../../shared/utils/format'
import type { P3ProductRankingRow } from '../../api/types'

const PAGE_SIZE_OPTIONS = [5, 10, 20, 50]

interface ProductComplaintRankingProps {
  rows: P3ProductRankingRow[]
  loading: boolean
  error: string
}

export function ProductComplaintRanking({ rows, loading, error }: ProductComplaintRankingProps) {
  const [expandedSpus, setExpandedSpus] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(5)
  const topRows = rows.slice(0, 20)

  const pageCount = Math.max(1, Math.ceil(topRows.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const startIndex = (safePage - 1) * pageSize
  const visibleRows = topRows.slice(startIndex, startIndex + pageSize)

  function toggleSpu(spu: string) {
    setExpandedSpus((cur) => {
      const next = new Set(cur)
      if (next.has(spu)) next.delete(spu)
      else next.add(spu)
      return next
    })
  }

  // Render: pagination header (page-size select + first/prev/next/last buttons) +
  // table with rank/SPU/SKC/销量/客诉量/客诉率 columns,
  // each SPU row expandable to SKC children rows.
  // Use existing CSS classes: .ranking-card, .ranking-table, .rank-pill, .ranking-toggle, .ranking-row,
  // .ranking-pagination, .pagination-buttons, .pagination-button, .pagination-status, .page-size-control.
  // (Full JSX is structurally identical to legacy ProductRankingSection — port verbatim.)
  return (/* ... */)
}
```

For the full JSX, port verbatim from `src/dashboardComponents.jsx` lines 482–590, replacing `formatInteger(row.sales_qty)` etc. with the imports above. The plan doesn't repeat the 100-line JSX block; use the legacy file as the literal source.

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/features/p3/ProductComplaintRanking.tsx
git commit -m "feat(frontend/p3): extract ProductComplaintRanking extension component"
```

### Task 3.4: Implement new `P3Dashboard.tsx`

**Files:**
- Create: `src/features/p3/P3Dashboard.tsx`

- [ ] **Step 1: Implement**

```typescript
import { useMemo, useState } from 'react'
import { DashboardShell } from '../../shared/components/DashboardShell'
import { FilterBar } from '../../shared/components/FilterBar'
import { FocusLineChart, type FocusMetricSpec } from '../../shared/components/FocusLineChart'
import { KpiCard } from '../../shared/components/KpiCard'
import { KpiSection } from '../../shared/components/KpiSection'
import { useDashboardData } from '../../shared/hooks/useDashboardData'
import { fetchDashboard, fetchDrilldownOptions, fetchProductRanking } from '../../api/p3'
import {
  formatInteger, formatPercent,
} from '../../shared/utils/format'
import {
  getCurrentPeriod, getPreviousPeriod, getDefaultHistoryRange,
  getPeriodCount,
} from '../../shared/utils/datePeriod'
import { IssueStructure } from './IssueStructure'
import { ProductComplaintRanking } from './ProductComplaintRanking'
import type { Grain, P3Dashboard, P3IssueShareItem, P3ProductRankingRow } from '../../api/types'

function buildDelta(current: number | null | undefined, previous: number | null | undefined, mode: 'percent' | 'pp') {
  if (previous === null || previous === undefined) return { tone: 'muted' as const, text: '-' }
  if (mode === 'pp') {
    const diff = (current ?? 0) - (previous ?? 0)
    if (diff === 0) return { tone: 'neutral' as const, text: '0.00pp' }
    return { tone: diff > 0 ? 'up' as const : 'down' as const, text: `${diff > 0 ? '↑' : '↓'} ${Math.abs(diff * 100).toFixed(2)}pp` }
  }
  if (!previous) return { tone: 'muted' as const, text: '-' }
  const ratio = ((current ?? 0) - previous) / previous
  if (ratio === 0) return { tone: 'neutral' as const, text: '0.0%' }
  return { tone: ratio > 0 ? 'up' as const : 'down' as const, text: `${ratio > 0 ? '↑' : '↓'} ${Math.abs(ratio * 100).toFixed(1)}%` }
}

export default function P3Dashboard() {
  const [grain, setGrain] = useState<Grain>('day')
  const [dateBasis, setDateBasis] = useState<'order_date' | 'refund_date'>('order_date')
  const [historyRange, setHistoryRange] = useState(() => getDefaultHistoryRange('day'))

  const currentPeriod = useMemo(() => getCurrentPeriod(grain), [grain])
  const previousPeriod = useMemo(() => getPreviousPeriod(grain), [grain])

  function handleGrainChange(next: Grain) {
    setGrain(next)
    setHistoryRange(getDefaultHistoryRange(next))
  }

  const baseFilters = { grain, date_basis: dateBasis } as const

  const { current, previous, history, loading, error } = useDashboardData<typeof baseFilters, P3Dashboard>({
    baseFilters,
    currentPeriod, previousPeriod, historyRange,
    fetcher: (filters, signal) => fetchDashboard(filters, signal),
  })

  // Independent fetches for extension area data (don't need 3-window split)
  const [options, setOptions] = useState<P3IssueShareItem[]>([])
  const [ranking, setRanking] = useState<P3ProductRankingRow[]>([])
  const [extLoading, setExtLoading] = useState(true)
  const [extError, setExtError] = useState('')

  // Effect: re-fetch options + ranking on baseFilters or historyRange change
  // (use simpler useEffect with abort; not worth a hook for this)
  // ... See Task 3.5 for full effect.

  const periodCount = getPeriodCount(historyRange, grain)
  const periodLabelByGrain = { day: '天', week: '周', month: '月' } as const

  function periodAverage(total: number | null | undefined, count: number): string {
    if (!total || !count) return '-'
    return formatInteger(total / count)
  }

  function ratePeriodAverage(rate: number | null | undefined): string {
    return rate === null || rate === undefined ? '-' : formatPercent(rate, 2)
  }

  // Helper: derive issue type counts for current/history
  function issueCount(d: P3Dashboard | null, type: P3IssueShareItem['major_issue_type']): number {
    return d?.issue_share?.find((i) => i.major_issue_type === type)?.count ?? 0
  }

  const cards = [
    {
      key: 'sales_qty', label: '订单数', sparkline: true,
      currentValue: current?.summary.sales_qty,
      previousValue: previous?.summary.sales_qty,
      historyTrend: history?.trends.sales_qty ?? [],
      currentTrend: current ? [{ bucket: currentPeriod.date_to, value: current.summary.sales_qty }] : [],
      formatter: formatInteger, deltaMode: 'percent' as const,
    },
    {
      key: 'complaint_count', label: '客诉量', sparkline: true,
      currentValue: current?.summary.complaint_count,
      previousValue: previous?.summary.complaint_count,
      historyTrend: history?.trends.complaint_count ?? [],
      currentTrend: current ? [{ bucket: currentPeriod.date_to, value: current.summary.complaint_count }] : [],
      formatter: formatInteger, deltaMode: 'percent' as const,
    },
    {
      key: 'complaint_rate', label: '客诉率', sparkline: true,
      currentValue: current?.summary.complaint_rate,
      previousValue: previous?.summary.complaint_rate,
      historyTrend: history?.trends.complaint_rate ?? [],
      currentTrend: current ? [{ bucket: currentPeriod.date_to, value: current.summary.complaint_rate }] : [],
      formatter: (n: number) => formatPercent(n, 2), deltaMode: 'pp' as const, isRate: true,
    },
    {
      key: 'product_count', label: '产品问题客诉量', sparkline: true,
      currentValue: issueCount(current, 'product'),
      previousValue: issueCount(previous, 'product'),
      historyTrend: history?.trends.issue_product_count ?? [],
      currentTrend: current ? [{ bucket: currentPeriod.date_to, value: issueCount(current, 'product') }] : [],
      formatter: formatInteger, deltaMode: 'percent' as const,
    },
    {
      key: 'logistics_count', label: '物流问题客诉量',
      currentValue: issueCount(current, 'logistics'),
      previousValue: issueCount(previous, 'logistics'),
      historyTrend: history?.trends.issue_logistics_count ?? [],
      currentTrend: current ? [{ bucket: currentPeriod.date_to, value: issueCount(current, 'logistics') }] : [],
      formatter: formatInteger, deltaMode: 'percent' as const,
    },
    {
      key: 'warehouse_count', label: '仓库问题客诉量',
      currentValue: issueCount(current, 'warehouse'),
      previousValue: issueCount(previous, 'warehouse'),
      historyTrend: history?.trends.issue_warehouse_count ?? [],
      currentTrend: current ? [{ bucket: currentPeriod.date_to, value: issueCount(current, 'warehouse') }] : [],
      formatter: formatInteger, deltaMode: 'percent' as const,
    },
  ]

  const focusMetrics: FocusMetricSpec[] = cards.map((c) => ({
    key: c.key,
    label: c.label,
    formatter: c.formatter,
    history: c.historyTrend,
    current: c.currentTrend,
  }))

  return (
    <DashboardShell
      filterBar={
        <FilterBar
          grain={grain} onGrainChange={handleGrainChange}
          historyRange={historyRange} onHistoryRangeChange={setHistoryRange}
          extras={
            <div className="filter-bar__group">
              <span className="filter-bar__label">时间口径</span>
              <div className="segmented-control">
                {[
                  { value: 'order_date' as const, label: '订单时间' },
                  { value: 'refund_date' as const, label: '退款时间' },
                ].map((opt) => (
                  <button key={opt.value} type="button"
                    className={`segment-button ${dateBasis === opt.value ? 'segment-button--active' : ''}`}
                    onClick={() => setDateBasis(opt.value)}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          }
        />
      }
      banner={
        error ? <section className="status-banner status-banner--error">{error}</section> :
        current?.meta?.partial_data ? (
          <section className="status-banner status-banner--info">
            {current.meta.notes?.[0] ?? '当前数据存在局部缺失。'}
          </section>
        ) : null
      }
      currentPeriodSection={
        <KpiSection title="当前周期" subtitle={`数据截至 ${currentPeriod.date_to}（T-1）`} variant="current">
          {cards.map((c) => (
            <KpiCard
              key={c.key}
              variant="current"
              label={c.label}
              value={loading ? '--' : c.formatter(c.currentValue ?? 0)}
              delta={loading ? undefined : buildDelta(c.currentValue, c.previousValue, c.deltaMode)}
              periodAverage={loading ? '--' : (c.isRate ? ratePeriodAverage(c.currentValue) : '-')}
              sparkline={c.sparkline ? c.historyTrend : undefined}
            />
          ))}
        </KpiSection>
      }
      focusChart={loading ? null : <FocusLineChart metrics={focusMetrics} defaultKey="complaint_rate" />}
      historySection={
        <KpiSection
          title="历史区间"
          subtitle={`${historyRange.date_from} - ${historyRange.date_to} · 共 ${periodCount} 个完整周期 · 按${periodLabelByGrain[grain]}聚合`}
          variant="history"
        >
          {cards.map((c) => {
            const total = c.historyTrend.reduce((s, p) => s + p.value, 0)
            const isRate = c.isRate
            if (isRate) {
              const mean = c.historyTrend.length ? total / c.historyTrend.length : 0
              const peak = c.historyTrend.length ? Math.max(...c.historyTrend.map((p) => p.value)) : 0
              return (
                <KpiCard key={c.key} variant="history" label={c.label}
                  total={c.formatter(mean)} periodAverage={c.formatter(mean)}
                  rateMode={{ mean: c.formatter(mean), peak: c.formatter(peak) }} />
              )
            }
            return (
              <KpiCard key={c.key} variant="history" label={c.label}
                total={loading ? '--' : c.formatter(total)}
                periodAverage={loading ? '--' : c.formatter(c.historyTrend.length ? total / c.historyTrend.length : 0)} />
            )
          })}
        </KpiSection>
      }
      extensions={
        <>
          <IssueStructure dashboard={history} options={options} />
          <ProductComplaintRanking rows={ranking} loading={extLoading} error={extError} />
        </>
      }
    />
  )
}
```

- [ ] **Step 2: Add the extension-data effect inside `P3Dashboard`**

Just below the `useDashboardData` call, add:

```typescript
useEffect(() => {
  const controller = new AbortController()
  setExtLoading(true)
  setExtError('')
  Promise.all([
    fetchDrilldownOptions({ ...baseFilters, ...historyRange }, controller.signal),
    fetchProductRanking({ ...baseFilters, ...historyRange }, controller.signal),
  ])
    .then(([opts, rank]) => {
      setOptions(opts.options ?? [])
      setRanking(rank.ranking ?? [])
    })
    .catch((err) => {
      if ((err as Error).name === 'AbortError') return
      setOptions([])
      setRanking([])
      setExtError((err as Error).message || '扩展区数据加载失败')
    })
    .finally(() => setExtLoading(false))
  return () => controller.abort()
}, [grain, dateBasis, historyRange.date_from, historyRange.date_to])
```

Add `import { useEffect } from 'react'` at the top.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`. Fix any type errors before proceeding.

- [ ] **Step 4: Commit**

```bash
git add src/features/p3/P3Dashboard.tsx
git commit -m "feat(frontend/p3): implement unified P3 dashboard"
```

### Task 3.5: Wire P3 in `App.tsx` and verify

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Replace import**

Change:
```typescript
import P3Dashboard from './features/p3/legacy/P3Dashboard'
```
to:
```typescript
import P3Dashboard from './features/p3/P3Dashboard'
```

- [ ] **Step 2: Manual verification**

Run: `PATH="/opt/homebrew/bin:$PATH" npm run dev`. In browser at http://localhost:5173:

| Check | Expected |
|---|---|
| Open P3 | KPI cards show, focus chart renders, history section + extensions present |
| Switch grain to 按周 | History range auto-resets to default 8-week range; everything reloads |
| Switch grain to 按月 | Same, 2-month range |
| Pick a different history start date | Aligns to grain (Mon for week, 1st for month); history section + chart history segment update; current segment unchanged |
| Try setting history end past T-1 | Rejected (no change) |
| Click a focus chart tab | Plot switches to that metric |
| Hover focus chart point | Tooltip shows bucket + formatted value |
| Open IssueStructure rows | Render with three issue types |
| Expand SPU in ProductComplaintRanking | SKC children appear; pagination works |

Compare visually against the old P3 (still in legacy file via git stash if needed).

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(frontend/p3): wire new P3Dashboard into App"
```

---

## Phase 4: P2 Rewrite

P2 is the most complex (8 cards, store filter, SPU/SKC picker with two-way linkage, listing-date filter on the table).

### Task 4.1: Move legacy P2 to `features/p2/legacy/`

- [ ] **Step 1: Move files**

```bash
mkdir -p src/features/p2/legacy
git mv src/P2Dashboard.jsx src/features/p2/legacy/P2Dashboard.jsx
git mv src/P2Dashboard.css src/features/p2/legacy/P2Dashboard.css
```

- [ ] **Step 2: Update legacy P2 import inside itself**

Edit `src/features/p2/legacy/P2Dashboard.jsx` line 2: change `import './P2Dashboard.css'` to `import './P2Dashboard.css'` (path is now relative to the same legacy dir, so already correct).

Update `src/App.tsx`:
```typescript
import P2Dashboard from './features/p2/legacy/P2Dashboard'
```

- [ ] **Step 3: Verify dev server runs, P2 still loads**

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(frontend): stash legacy P2Dashboard before rewrite"
```

### Task 4.2: Implement `useSpuSkcPicker` hook

**Files:**
- Create: `src/features/p2/useSpuSkcPicker.ts`

The two-way linkage between SPU multi-select and SKC multi-select (selecting a SPU auto-selects its SKCs; selecting a SKC includes its parent SPUs) is the most fragile logic in legacy. Extract it as a hook.

- [ ] **Step 1: Implement**

```typescript
import { useEffect, useMemo, useState } from 'react'

interface SpuSkcPair { spu: string; skc: string }

interface UseSpuSkcPickerArgs {
  spuOptions: string[]
  skcOptions: string[]
  pairs: SpuSkcPair[]
}

interface UseSpuSkcPickerResult {
  pendingSpus: string[]
  pendingSkcs: string[]
  selectedSpus: string[]
  selectedSkcs: string[]
  spuKeyword: string
  skcKeyword: string
  filteredSpuOptions: string[]
  filteredSkcOptions: string[]
  setSpuKeyword: (v: string) => void
  setSkcKeyword: (v: string) => void
  toggleSpuPending: (spu: string, checked: boolean) => void
  toggleSkcPending: (skc: string, checked: boolean) => void
  applyPending: () => void
  clearAll: () => void
}

export function useSpuSkcPicker({
  spuOptions, skcOptions, pairs,
}: UseSpuSkcPickerArgs): UseSpuSkcPickerResult {
  const [pendingSpus, setPendingSpus] = useState<string[]>([])
  const [pendingSkcs, setPendingSkcs] = useState<string[]>([])
  const [selectedSpus, setSelectedSpus] = useState<string[]>([])
  const [selectedSkcs, setSelectedSkcs] = useState<string[]>([])
  const [spuKeyword, setSpuKeyword] = useState('')
  const [skcKeyword, setSkcKeyword] = useState('')

  const skcsBySpu = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const p of pairs) {
      if (!p.spu || !p.skc) continue
      const list = map.get(p.spu) ?? []
      list.push(p.skc)
      map.set(p.spu, list)
    }
    return map
  }, [pairs])

  const spusBySkc = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const p of pairs) {
      if (!p.spu || !p.skc) continue
      const list = map.get(p.skc) ?? []
      list.push(p.spu)
      map.set(p.skc, list)
    }
    return map
  }, [pairs])

  const filteredSpuOptions = useMemo(
    () => spuOptions.filter((o) => o.toLowerCase().includes(spuKeyword.trim().toLowerCase())),
    [spuOptions, spuKeyword],
  )
  const filteredSkcOptions = useMemo(
    () => skcOptions.filter((o) => o.toLowerCase().includes(skcKeyword.trim().toLowerCase())),
    [skcOptions, skcKeyword],
  )

  // Drop selections no longer present in latest options
  useEffect(() => {
    setPendingSpus((prev) => prev.filter((s) => spuOptions.includes(s)))
    setSelectedSpus((prev) => prev.filter((s) => spuOptions.includes(s)))
  }, [spuOptions])
  useEffect(() => {
    setPendingSkcs((prev) => prev.filter((s) => skcOptions.includes(s)))
    setSelectedSkcs((prev) => prev.filter((s) => skcOptions.includes(s)))
  }, [skcOptions])

  function toggleSpuPending(spu: string, checked: boolean) {
    const related = skcsBySpu.get(spu) ?? []
    setPendingSpus((prevSpus) => {
      const nextSpus = checked
        ? [...new Set([...prevSpus, spu])]
        : prevSpus.filter((v) => v !== spu)
      setPendingSkcs((prevSkcs) => {
        if (checked) return [...new Set([...prevSkcs, ...related])]
        const nextSpuSet = new Set(nextSpus)
        return prevSkcs.filter((skc) => {
          if (!related.includes(skc)) return true
          const parents = spusBySkc.get(skc) ?? []
          return parents.some((s) => nextSpuSet.has(s))
        })
      })
      return nextSpus
    })
  }

  function toggleSkcPending(skc: string, checked: boolean) {
    setPendingSkcs((prevSkcs) => {
      const nextSkcs = checked
        ? [...new Set([...prevSkcs, skc])]
        : prevSkcs.filter((v) => v !== skc)
      const nextSpuSet = new Set<string>()
      for (const s of nextSkcs) {
        for (const sp of spusBySkc.get(s) ?? []) nextSpuSet.add(sp)
      }
      setPendingSpus([...nextSpuSet])
      return nextSkcs
    })
  }

  function applyPending() {
    setSelectedSpus(pendingSpus)
    setSelectedSkcs(pendingSkcs)
  }

  function clearAll() {
    setPendingSpus([])
    setPendingSkcs([])
    setSelectedSpus([])
    setSelectedSkcs([])
  }

  return {
    pendingSpus, pendingSkcs, selectedSpus, selectedSkcs,
    spuKeyword, skcKeyword, filteredSpuOptions, filteredSkcOptions,
    setSpuKeyword, setSkcKeyword,
    toggleSpuPending, toggleSkcPending,
    applyPending, clearAll,
  }
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/features/p2/useSpuSkcPicker.ts
git commit -m "feat(frontend/p2): extract SPU/SKC picker as reusable hook"
```

### Task 4.3: Implement `ProductRefundTable.tsx`

**Files:**
- Create: `src/features/p2/ProductRefundTable.tsx`

This is P2's "商品退款表现表" with sortable columns, SPU/SKC picker, listing-date filter, expandable rows.

- [ ] **Step 1: Read legacy `src/features/p2/legacy/P2Dashboard.jsx` lines 256–840**

This is the table + picker UI. Note: sort state + toggleSort, expandedSpu state, renderedTableRows memo, picker panel JSX with confirm/clear actions.

- [ ] **Step 2: Create `src/features/p2/ProductRefundTable.tsx`**

```typescript
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useSpuSkcPicker } from './useSpuSkcPicker'
import { fetchRefundSpuTable, fetchRefundSpuSkcOptions } from '../../api/p2'
import { formatInteger, formatMoney, formatPercent } from '../../shared/utils/format'
import type { P2Filters, P2SpuRow } from '../../api/types'

type SortKey =
  | 'sales_qty' | 'sales_amount' | 'refund_qty' | 'refund_amount'
  | 'refund_qty_ratio' | 'refund_amount_ratio'

interface ProductRefundTableProps {
  baseFilters: P2Filters  // grain + channel + history range (date_from/date_to)
}

export function ProductRefundTable({ baseFilters }: ProductRefundTableProps) {
  const [topRows, setTopRows] = useState<P2SpuRow[]>([])
  const [filteredRows, setFilteredRows] = useState<P2SpuRow[]>([])
  const [pairs, setPairs] = useState<Array<{ spu: string; skc: string }>>([])
  const [spuOptions, setSpuOptions] = useState<string[]>([])
  const [skcOptions, setSkcOptions] = useState<string[]>([])
  const [listingFrom, setListingFrom] = useState('')
  const [listingTo, setListingTo] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>(
    { key: 'refund_amount', direction: 'desc' },
  )
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [spuPickerOpen, setSpuPickerOpen] = useState(false)
  const [skcPickerOpen, setSkcPickerOpen] = useState(false)
  const [confirmKey, setConfirmKey] = useState(0)
  const [loading, setLoading] = useState(true)

  const picker = useSpuSkcPicker({ spuOptions, skcOptions, pairs })

  // Load top-20 rows + options on baseFilters change
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    Promise.all([
      fetchRefundSpuTable({ ...baseFilters, top_n: 20 }, controller.signal),
      fetchRefundSpuSkcOptions({ ...baseFilters, top_n: 20 }, controller.signal),
    ])
      .then(([table, opts]) => {
        setTopRows(table.rows ?? [])
        setFilteredRows([])
        setSpuOptions(opts.options?.spus ?? [])
        setSkcOptions(opts.options?.skcs ?? [])
        setPairs(opts.options?.pairs ?? [])
      })
      .catch((err) => { if ((err as Error).name === 'AbortError') return })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [baseFilters.date_from, baseFilters.date_to, baseFilters.grain, baseFilters.channel])

  // Load filtered rows when picker selections or listing dates change
  useEffect(() => {
    const hasFilters = picker.selectedSpus.length || picker.selectedSkcs.length || listingFrom || listingTo
    if (!hasFilters) return
    const controller = new AbortController()
    fetchRefundSpuTable({
      ...baseFilters,
      spu_list: picker.selectedSpus,
      skc_list: picker.selectedSkcs,
      listing_date_from: listingFrom,
      listing_date_to: listingTo,
      top_n: 500,
    }, controller.signal)
      .then((resp) => setFilteredRows(resp.rows ?? []))
      .catch((err) => { if ((err as Error).name === 'AbortError') return })
    return () => controller.abort()
  }, [picker.selectedSpus, picker.selectedSkcs, baseFilters, confirmKey, listingFrom, listingTo])

  const hasTableFilters =
    picker.selectedSpus.length > 0 || picker.selectedSkcs.length > 0 || filteredRows.length > 0

  const displayedRows = useMemo(() => {
    const source = hasTableFilters ? filteredRows : topRows
    const rows = [...source]
    const get = (row: P2SpuRow) => (row[sort.key] as number) ?? 0
    rows.sort((a, b) => {
      const diff = get(a) - get(b)
      return sort.direction === 'asc' ? diff : -diff
    })
    return hasTableFilters ? rows : rows.slice(0, 5)
  }, [topRows, filteredRows, sort, hasTableFilters])

  function toggleSort(key: SortKey) {
    setSort((cur) => cur.key === key
      ? { ...cur, direction: cur.direction === 'desc' ? 'asc' : 'desc' }
      : { key, direction: 'desc' })
  }

  function applyFilters() {
    picker.applyPending()
    setConfirmKey((k) => k + 1)
    setSpuPickerOpen(false)
    setSkcPickerOpen(false)
  }

  function clearFilters() {
    picker.clearAll()
    setListingFrom('')
    setListingTo('')
    setFilteredRows([])
    setSpuPickerOpen(false)
    setSkcPickerOpen(false)
  }

  // Render: see legacy P2Dashboard.jsx lines 602-840 for full JSX template.
  // Reuse classes: .table-wrap, .table-head, .table-sort-tools, .picker-wrap, .picker-trigger,
  // .picker-panel, .picker-list, .picker-item, .listing-date-field,
  // .spu-row, .skc-row, .sort-header-btn, .refund-metric-cell, .sorted-metric-cell,
  // .spu-cell-btn, .skc-cell, .skc-spu-cell, .empty-cell.
  // (Plan does not duplicate the 200-line JSX — port verbatim from legacy.)
  return (/* ... port from legacy ... */)
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/features/p2/ProductRefundTable.tsx
git commit -m "feat(frontend/p2): extract ProductRefundTable extension component"
```

### Task 4.4: Implement new `P2Dashboard.tsx`

**Files:**
- Create: `src/features/p2/P2Dashboard.tsx`

- [ ] **Step 1: Implement**

Following the same pattern as P3Dashboard, with these P2 specifics:
- 8 cards from `overview.cards` (`order_count`, `gmv`, `refund_amount`, `refund_amount_ratio` get sparklines; the other 4 don't)
- Store filter passed to `<FilterBar storeOptions={...} store={...} onStoreChange={...}>`
- `refund_amount_ratio` is the rate metric (区间均值 + 峰值 in history)
- Extension area: `<ProductRefundTable baseFilters={{ ...baseFilters, ...historyRange }} />`

```typescript
import { useMemo, useState } from 'react'
import { DashboardShell } from '../../shared/components/DashboardShell'
import { FilterBar } from '../../shared/components/FilterBar'
import { FocusLineChart, type FocusMetricSpec } from '../../shared/components/FocusLineChart'
import { KpiCard } from '../../shared/components/KpiCard'
import { KpiSection } from '../../shared/components/KpiSection'
import { useDashboardData } from '../../shared/hooks/useDashboardData'
import { fetchRefundOverview } from '../../api/p2'
import { formatInteger, formatMoney, formatPercent } from '../../shared/utils/format'
import {
  getCurrentPeriod, getPreviousPeriod, getDefaultHistoryRange, getPeriodCount,
} from '../../shared/utils/datePeriod'
import { ProductRefundTable } from './ProductRefundTable'
import type { Grain, P2Overview } from '../../api/types'

const STORE_OPTIONS = [
  { value: '2vnpww-33', label: '2vnpww-33 (US)' },
  { value: 'lintico-fr', label: 'lintico-fr' },
  { value: 'lintico-uk', label: 'lintico-uk' },
]

// Same buildDelta as P3Dashboard — copy the function (DRY in Phase 6 refactor if desired).
function buildDelta(/* ... same as P3 ... */) { /* ... */ }

export default function P2Dashboard() {
  const [grain, setGrain] = useState<Grain>('day')
  const [store, setStore] = useState('')
  const [historyRange, setHistoryRange] = useState(() => getDefaultHistoryRange('day'))

  const currentPeriod = useMemo(() => getCurrentPeriod(grain), [grain])
  const previousPeriod = useMemo(() => getPreviousPeriod(grain), [grain])

  function handleGrainChange(next: Grain) {
    setGrain(next)
    setHistoryRange(getDefaultHistoryRange(next))
  }

  const baseFilters = { grain, channel: store }

  const { current, previous, history, loading, error } = useDashboardData<typeof baseFilters, P2Overview>({
    baseFilters, currentPeriod, previousPeriod, historyRange,
    fetcher: (filters, signal) => fetchRefundOverview(filters as never, signal),
  })

  // 8 card descriptors. Each ties to a key in overview.cards and a series in overview.trends.
  const cards = [
    { key: 'order_count', label: '订单数', sparkline: true, formatter: formatInteger, deltaMode: 'percent' as const },
    { key: 'gmv', label: 'GMV', sparkline: true, formatter: formatMoney, deltaMode: 'percent' as const },
    { key: 'refund_amount', label: '退款金额', sparkline: true, formatter: formatMoney, deltaMode: 'percent' as const },
    { key: 'refund_amount_ratio', label: '退款金额占比', sparkline: true,
      formatter: (n: number) => formatPercent(n, 1), deltaMode: 'pp' as const, isRate: true },
    { key: 'sales_qty', label: '销量', formatter: formatInteger, deltaMode: 'percent' as const },
    { key: 'refund_order_count', label: '退款订单数', formatter: formatInteger, deltaMode: 'percent' as const },
    { key: 'net_received_amount', label: '净实付金额', formatter: formatMoney, deltaMode: 'percent' as const },
    { key: 'net_revenue_amount', label: '净 GMV', formatter: formatMoney, deltaMode: 'percent' as const },
  ] as const

  // Build focusMetrics, current cards, history cards using the same pattern as P3.
  // The card.key matches both overview.cards[key] and overview.trends[key].

  // Render: <DashboardShell> with FilterBar (storeOptions=STORE_OPTIONS),
  // KpiSection variant="current" with 8 KpiCards,
  // FocusLineChart with 8 FocusMetricSpec entries (default key = 'gmv'),
  // KpiSection variant="history" with 8 history KpiCards (refund_amount_ratio uses rateMode),
  // extensions = <ProductRefundTable baseFilters={{ ...baseFilters, ...historyRange } as P2Filters} />.

  return (/* ... structurally identical to P3Dashboard ... */)
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/features/p2/P2Dashboard.tsx
git commit -m "feat(frontend/p2): implement unified P2 dashboard"
```

### Task 4.5: Wire P2 in `App.tsx` and verify

- [ ] **Step 1: Update import**

```typescript
import P2Dashboard from './features/p2/P2Dashboard'
```

- [ ] **Step 2: Manual verification**

| Check | Expected |
|---|---|
| Open P2 | 8 KPI cards, focus chart with 8 tabs (default GMV), history section, ProductRefundTable below |
| Switch grain | History range resets, all data reloads |
| Pick store | Reloads filtered to that store |
| Open SPU picker, check a SPU | Related SKCs auto-checked in pending; click 确认查询 → table updates |
| Open SKC picker, check a SKC | Parent SPUs auto-checked in pending; click 确认查询 → table updates |
| Click 清空 | All filters reset, table back to default top 5 |
| Sort table by 退款数占比 | Sort order changes, header arrow flips |
| Listing date filters | Picker rows update accordingly |
| Hover focus chart | Tooltip shows formatted value |

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(frontend/p2): wire new P2Dashboard into App"
```

---

## Phase 5: P1 Rewrite

### Task 5.1: Move legacy P1 to `features/p1/legacy/`

```bash
mkdir -p src/features/p1/legacy
git mv src/P1Dashboard.jsx src/features/p1/legacy/P1Dashboard.jsx
```

Update `src/App.tsx` import. Verify dev server. Commit.

### Task 5.2: Implement `WorkloadAnalysis.tsx`

**Files:**
- Create: `src/features/p1/WorkloadAnalysis.tsx`

This is the in-line `WorkloadAverageChart` from legacy `P1Dashboard.jsx` lines 15–190 plus the workload `<Table>` immediately following it.

- [ ] **Step 1: Implement**

```typescript
import { useState } from 'react'
import { computeChartGeometry } from '../../shared/utils/computeChartGeometry'
import { Table } from '../../shared/components/Table'
import { formatDecimal, formatInteger } from '../../shared/utils/format'
import type { P1AgentRow, P1AgentTrendRow } from '../../api/types'

type MetricKey =
  | 'avg_outbound_emails_per_hour_by_span'
  | 'avg_outbound_emails_per_hour_by_schedule'

const METRIC_OPTIONS: Array<{ key: string; label: string; value: MetricKey }> = [
  { key: 'span', label: '首末封均值', value: 'avg_outbound_emails_per_hour_by_span' },
  { key: 'schedule', label: '工时表均值', value: 'avg_outbound_emails_per_hour_by_schedule' },
]

const PALETTE = ['#52728d', '#b65c68', '#3c8f89', '#b17220', '#7c6597', '#8a6f5a']

interface WorkloadAnalysisProps {
  workloadRows: P1AgentRow[]
  trendRows: P1AgentTrendRow[]
  loading: boolean
}

export function WorkloadAnalysis({ workloadRows, trendRows, loading }: WorkloadAnalysisProps) {
  const [metricKey, setMetricKey] = useState<MetricKey>('avg_outbound_emails_per_hour_by_span')
  const [hiddenAgents, setHiddenAgents] = useState<Set<string>>(new Set())
  const [tooltip, setTooltip] = useState<{ bucket: string; index: number; x: number; y: number } | null>(null)

  function toggleAgent(name: string) {
    setHiddenAgents((cur) => {
      const next = new Set(cur)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // For the multi-line chart, share Y range across visible rows.
  const visibleRows = trendRows.filter((r) => !hiddenAgents.has(r.agent_name))
  const allValues = visibleRows.flatMap((r) => r.items.map((i) => i[metricKey] ?? 0))
  const yMin = Math.min(...allValues, 0)
  const yMax = Math.max(...allValues, 0)
  const longest = trendRows.reduce(
    (cur, r) => (r.items.length > cur.items.length ? r : cur), trendRows[0],
  )

  function projectRow(row: P1AgentTrendRow) {
    return computeChartGeometry({
      items: row.items.map((i) => ({ value: i[metricKey] ?? 0, bucket: i.bucket })),
      yMinOverride: yMin, yMaxOverride: yMax,
    })
  }

  // ... Render: segmented metric toggle + agent toggle list + multi-line SVG (one polyline per visible row,
  //     colored from PALETTE indexed by stable agent position), then a <Table> for workloadRows.
  // Use existing classes: .p1-workload-chart, .p1-workload-controls, .p1-workload-metric-toggle,
  // .p1-agent-toggle-list, .p1-agent-toggle, .p1-workload-trend, .p1-workload-trend__line,
  // .trend-chart__hit-area, .trend-chart__hit-circle, .trend-chart__axis-label, .trend-tooltip.
  // Port from legacy P1Dashboard.jsx 86-189 verbatim, replacing geometry math with computeChartGeometry results.

  return (/* ... */)
}
```

The workload table columns are exactly as in legacy P1Dashboard.jsx lines 278–307 — port verbatim.

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/features/p1/WorkloadAnalysis.tsx
git commit -m "feat(frontend/p1): extract WorkloadAnalysis extension with shared geometry"
```

### Task 5.3: Implement new `P1Dashboard.tsx`

**Files:**
- Create: `src/features/p1/P1Dashboard.tsx`

Following the same pattern as P3 with these specifics:
- 6 cards: `inbound_email_count`, `outbound_email_count`, `avg_queue_hours`, `first_response_timeout_count` (4 with sparkline) + `first_email_count`, `unreplied_email_count`
- `avg_queue_hours` formatter is `formatHours`; others are `formatInteger`
- No store filter
- Optional `agent_name` filter — passed via `extras` slot in FilterBar (a `<select>` like the legacy version)
- Extension area: `<WorkloadAnalysis workloadRows={current?.agent_workload ?? []} trendRows={history?.agent_workload_trends ?? []} loading={loading} />`

- [ ] **Step 1: Implement** (analogous to P2/P3 — full file ~250 lines)

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/features/p1/P1Dashboard.tsx
git commit -m "feat(frontend/p1): implement unified P1 dashboard"
```

### Task 5.4: Wire P1 and verify

- [ ] **Step 1: Update import in `src/App.tsx`**

```typescript
import P1Dashboard from './features/p1/P1Dashboard'
```

- [ ] **Step 2: Manual verification**

| Check | Expected |
|---|---|
| Open P1 | 6 KPI cards, focus chart 6 tabs, history section, WorkloadAnalysis below |
| Switch grain | History range resets; data reloads |
| Pick agent | All cards + chart filter to that agent; workload table likely filters too (port behaviour from legacy) |
| Date range adjustments | Same as P2/P3 |
| WorkloadAnalysis: switch metric (首末封 / 工时表) | Lines redraw |
| Toggle a 客服 checkbox | Their line hides; tooltip + Y range adjust |
| Hover a chart point | Tooltip shows all visible agents' values for that bucket |
| Workload table | Renders with 客服姓名/总回邮数/两个均值/质检结果回邮数 columns |

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(frontend/p1): wire new P1Dashboard into App"
```

---

## Phase 6: Cleanup

### Task 6.1: Delete legacy code

**Files:**
- Delete: `src/features/p1/legacy/`
- Delete: `src/features/p2/legacy/`
- Delete: `src/features/p3/legacy/`
- Delete: `src/dashboardComponents.jsx`
- Delete: `src/dashboardUtils.js`

- [ ] **Step 1: Verify nothing else imports legacy**

Run: `grep -r "legacy/" src/` — expect no matches outside the legacy dirs themselves.
Run: `grep -r "dashboardComponents\|dashboardUtils" src/` — expect no matches.

- [ ] **Step 2: Delete**

```bash
rm -rf src/features/p1/legacy src/features/p2/legacy src/features/p3/legacy
rm src/dashboardComponents.jsx src/dashboardUtils.js
```

- [ ] **Step 3: Tighten `tsconfig.json`**

Set `"allowJs": false`. Run typecheck — should still pass since no `.jsx`/`.js` files remain in src/.

- [ ] **Step 4: Verify dev + build**

```bash
npm run typecheck
npm run lint
npm run build
PATH="/opt/homebrew/bin:$PATH" npm run dev
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(frontend): remove legacy Dashboard code, tighten tsconfig"
```

### Task 6.2: Reorganize CSS

**Files:**
- Create: `src/styles/tokens.css` (move `:root` from `src/index.css`, expand)
- Create: `src/styles/base.css` (reset, body, headings)
- Create: `src/styles/layout.css` (app-shell, side-nav, dashboard-shell)
- Create: `src/styles/components.css` (KPI cards, focus chart, table, filter bar)
- Create: `src/styles/extensions.css` (P1 workload, P2 product table, P3 ranking, P3 issue structure)
- Modify: `src/main.tsx` (import the new files in order)
- Delete: `src/index.css`, `src/App.css`

- [ ] **Step 1: Create `tokens.css` with expanded design system**

```css
:root {
  /* Color palette (existing) */
  --page-bg: #f3efe7;
  --surface: #fffdf8;
  --chip-bg: #f5efe3;
  --border: rgba(33, 50, 41, 0.12);
  --input-border: rgba(33, 50, 41, 0.16);
  --heading: #1d2d25;
  --text: #30443a;
  --muted: #64756b;
  --muted-strong: #54655a;
  --accent: #0b6e4f;

  /* Tones (semantic) */
  --tone-up: #0b6e4f;
  --tone-down: #b65c68;
  --tone-neutral: var(--muted);
  --tone-muted: var(--muted-strong);

  /* Sparkline / chart tones */
  --tone-sales: #52728d;
  --tone-complaints: #b65c68;
  --tone-rate: #b17220;

  /* Spacing scale */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;

  /* Font sizes */
  --fs-xs: 12px;
  --fs-sm: 14px;
  --fs-md: 16px;
  --fs-lg: 20px;
  --fs-xl: 28px;
  --fs-2xl: 40px;

  /* Radii */
  --radius-sm: 8px;
  --radius-md: 16px;
  --radius-lg: 24px;

  /* Shadows */
  --shadow-soft:
    0 18px 35px rgba(43, 56, 49, 0.08),
    0 2px 6px rgba(43, 56, 49, 0.05);

  /* Fonts */
  --sans:
    'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  --heading-font:
    Georgia, 'Times New Roman', 'Noto Serif SC', 'Songti SC', serif;
}
```

- [ ] **Step 2: Distribute existing rules from `App.css` and `index.css` into the appropriate layer files**

Walk through each rule in `App.css`:
- shell + side nav → `layout.css`
- summary-card / trend-card / table-card → rename to `kpi-card`/`focus-chart`/`data-table-card` and put in `components.css`
- filter-bar / segmented-control / date-range-control → `components.css`
- p1-* / p2-* / p3-* → `extensions.css`
- empty-state, status-banner, mini-chart → `components.css`

Replace any hardcoded color/spacing values with the new tokens.

- [ ] **Step 3: Update import order in `src/main.tsx`**

```typescript
import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/components.css'
import './styles/extensions.css'
import { StrictMode } from 'react'
// ... rest unchanged
```

- [ ] **Step 4: Delete obsolete CSS**

```bash
rm src/index.css src/App.css
```

- [ ] **Step 5: Visual verification**

Run dev server, walk through P1/P2/P3, compare visually against the screenshots/memory of pre-refactor app. The new class names (`kpi-card`, `data-table-card`, `focus-chart`) require the components to be re-rendered — should be live since this is the final commit of the refactor.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "style(frontend): split CSS into layered files with token system"
```

### Task 6.3: Frontend architecture doc

**Files:**
- Create: `docs/frontend-architecture.md`

- [ ] **Step 1: Write the doc**

Sections to cover:
- 目录结构 (`src/shared/`, `src/features/`, `src/api/`, `src/styles/`)
- 共享组件契约 (one paragraph per component, link to source)
- 时间口径语义 (locked rules from this plan)
- 数据加载策略 (3-window parallel fetch via `useDashboardData`)
- 类型来源 (单一 `src/api/types.ts`, 与后端契约的同步责任)
- 新增 Dashboard 的步骤指南
- CSS layers + token usage rules

Target ~150 lines.

- [ ] **Step 2: Commit**

```bash
git add docs/frontend-architecture.md
git commit -m "docs: add frontend architecture overview"
```

### Task 6.4: README updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Edit README**

- Add a "Frontend" section linking to `docs/frontend-architecture.md`
- Replace `npm.cmd run` with `npm run` everywhere (Windows-only artifact)
- Fix the broken local Windows path on line 77 (`/d:/lxx/Internship/...` → relative `config/README.md`)
- Mention the Homebrew node PATH note (or fix once and forget — see Phase 1 setup)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): add frontend section, fix Windows-isms"
```

---

## Self-Review Checklist

After Phase 6, walk this list:

- [ ] All tasks have file paths, code blocks, and concrete commands — no placeholders
- [ ] `Grain` and `PeriodWindow` types match across `api/types.ts`, `datePeriod.ts`, hooks, and component props
- [ ] Tests pass: `npm test`
- [ ] Typecheck passes with `allowJs: false`: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] Build passes: `npm run build`
- [ ] Manual verification matrix walked for each Dashboard
- [ ] Legacy code removed; `grep` for old class names (`summary-card`, `trend-card`, `metric-card`, `dashboard-shell` 旧版) returns no matches
- [ ] No remaining hardcoded colors outside `tokens.css` (allow ≤ 5 exceptions for chart tones inlined in palette arrays)

---

## Verification Matrix (Per Dashboard, end-to-end)

After Phase 5 — every Dashboard must satisfy all of these against the legacy behaviour:

| Behaviour | P1 | P2 | P3 |
|---|---|---|---|
| 当前周期 KPI shows for 按日 / 按周 / 按月 | ✓ | ✓ | ✓ |
| 环比 vs 上一周期 (按 percent for absolute, pp for rate) | ✓ | ✓ | ✓ |
| Sparkline appears only on the 4 designated cards | ✓ | ✓ | ✓ |
| 焦点折线图 tab switching includes ALL N metrics | ✓ | ✓ | ✓ |
| Focus chart history band + current band background distinction | ✓ | ✓ | ✓ |
| Focus chart history mean reference line | ✓ | ✓ | ✓ |
| Focus chart highlights the latest current point + tooltip | ✓ | ✓ | ✓ |
| 历史区间 KPI: 总值 + 周期均值 | ✓ | ✓ | ✓ |
| Rate-type history card: 区间均值 + 区间峰值 | – | refund_amount_ratio | complaint_rate |
| Switching grain auto-resets history range | ✓ | ✓ | ✓ |
| History date_to past T-1 is rejected | ✓ | ✓ | ✓ |
| Date inputs align to grain | ✓ | ✓ | ✓ |
| Extension area: original feature parity | 坐席工作量 | SPU/SKC 表 | 问题结构 + 商品排行 |
| Loading state | ✓ | ✓ | ✓ |
| Error banner on fetch failure | ✓ | ✓ | ✓ |
| `meta.partial_data` notes show as info banner | ✓ | ✓ | ✓ |


