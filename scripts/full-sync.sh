#!/usr/bin/env bash
# Full sync: source→target (no date filter) + target→sqlite + full 400-day
# BigQuery / Shopify BI cache refresh. Use this for one-off bootstraps or when
# upstream data has back-edits beyond the cache_tail_days window.
#
# The scheduled worker uses incremental tail refresh and never runs this.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> [1/2] Source-to-target (full, no date filter)"
npm run sync:source-to-target --silent

echo
echo "==> [2/2] Target-to-sqlite + full 400-day BigQuery cache refresh"
npm run sync:run --silent -- --full

echo
echo "Full sync done."
