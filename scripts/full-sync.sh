#!/usr/bin/env bash
# Full cache sync: target→sqlite + full 400-day BigQuery / Shopify BI cache
# refresh. This intentionally does not run source→target: the Feishu target
# table keeps stable record ids and review state, so source→target backfills
# should be run explicitly with --from/--to windows.
#
# The scheduled worker uses incremental tail refresh and never runs this.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Target-to-sqlite + full 400-day BigQuery cache refresh"
npm run sync:run --silent -- --full

echo
echo "Full sync done."
