# P2/P3 Hourly Freshness Design

## Goal

P2 and P3 should use the new hourly BigQuery order data to show fresher Shopify metrics while keeping the existing dashboard grain choices: day, week, and month. This is a freshness change, not an hourly charting change.

P1 is already near-real-time and is not part of this scope.

## Current State

P2 and P3 read Shopify order, line, and refund metrics from the shared SQLite `shopify_bi_*` cache when the requested date range is covered. The sync worker refreshes a date window from BigQuery, but the due-check currently treats a successful date-window run as sufficient coverage. That means a window can be considered covered even when upstream BigQuery has newer hourly data.

The UI was also built around T-1 semantics. Defaults prefer yesterday or the previous complete period, and chart logic avoids presenting the current incomplete period as the normal default.

## Product Semantics

After this change, P2 and P3 default to the current period:

- Day view defaults to today.
- Week view includes the current week.
- Month view includes the current month.

Charts still aggregate by day, week, or month. The last bucket is allowed to be incomplete when it represents the current period. The frontend should continue to render the current incomplete bucket with the existing incomplete-period styling, such as a dotted or visually distinct final segment.

The UI should explain freshness via the existing "data as of" area, now using an hour-level timestamp from the backend.

## Architecture

```text
Hourly BigQuery order source
        |
        v
sync worker frequent tail refresh
        |
        v
SQLite shopify_bi_* cache + freshness metadata
        |
        v
P2/P3 APIs aggregate to day/week/month
        |
        v
Frontend defaults to current period and marks incomplete final bucket
```

## Backend Design

Use the existing Shopify DWD marts as the upstream source. Per the data warehouse ADR-0009, those marts are now hourly-refreshed by the upstream sync process, so the BI server does not need a new hourly-grain source table or a `grain=hour` API.

The upstream source set is the same logical input set the current cache refresh uses:

- orders fact, currently `shopify_dwd.dwd_orders_fact_usd`;
- classified line items, currently `shopify_intermediate.int_line_items_classified`;
- refund events, currently `shopify_dwd.dwd_refund_events`.

The cache should derive `data_as_of` from the BigQuery mart freshness watermark. The data warehouse exposes `_dbt_updated_at` on `dwd_orders_fact_usd` through `dwd_orders_fact`, and on `dwd_refund_events`; the BI server should use the minimum reliable freshness across those marts for the shared P2/P3 Shopify metrics.

The SQLite cache remains the serving layer. It does not need to expose hour-grain facts to P2/P3 APIs. It does need freshness metadata:

- `data_as_of`: the effective upstream timestamp represented by the cache.
- `synced_at`: when the local refresh finished.
- refreshed date window: the local date span replaced by the run.

The cache refresh should continue to replace a trailing date window, because late updates and refunds can change recent days. The due-check must stop using date-window coverage alone as a skip condition for P2/P3 freshness. In the first implementation, each regular worker tick should refresh the configured Shopify BI tail window. A later optimization can add a freshness TTL, but it is not part of this design.

The API should expose freshness in metadata:

- P2 `meta.data_as_of`
- P3 `meta.data_as_of`

Existing fields stay stable. If the cache is unavailable and P2 falls back to BigQuery, the response should still populate `data_as_of` when it can be derived from the queried source; otherwise it can be omitted.

## Frontend Design

Update P2 and P3 default range selection from T-1 to current-period semantics. The pages should continue to request day/week/month grain only.

Update the display text for freshness to use `meta.data_as_of` when present. The label should remain compact, for example:

```text
数据截至 2026-05-04 14:00
```

The incomplete-bucket visual rule should be applied to the current day/week/month bucket. This preserves the prior visual distinction but changes the reason: it now means "current period, accumulated through data_as_of" instead of "T-1-safe complete data only."

## Error Handling

If the freshness query fails, the service should still refresh the cache data and leave `data_as_of` empty for that run. The UI default range still follows current-period semantics, but the freshness label will fall back to the current date when metadata is absent.

If an hourly refresh fails, the worker should keep the last successful SQLite cache in place, log the failure, and record a failed cache run. The API should still serve the previous cache and surface normal partial/fallback notes only where existing behavior already does so.

## Testing

Backend tests should cover:

- cache metadata records `data_as_of`;
- worker refresh does not skip merely because a date window had a previous successful run;
- P2 meta includes `data_as_of`;
- P3 meta includes `data_as_of`;
- cache refresh still works when the freshness query returns no watermark.

Frontend tests should cover:

- P2 default date range includes the current period;
- P3 default date range includes the current period;
- data-as-of formatting uses hour-level timestamps;
- current incomplete day/week/month bucket keeps the incomplete-period visual marker.

## Not In Scope

- No `grain=hour`.
- No hour-level trend axis.
- No change to P2/P3 metric definitions.
- No direct online dependency on BigQuery for normal P2/P3 serving when SQLite cache coverage is available.
- No P1 changes.
