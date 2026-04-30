#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_BIN="$TMP_DIR/bin"
DEPLOY_ROOT="$TMP_DIR/deploy"
LOG_FILE="$TMP_DIR/commands.log"

mkdir -p "$FAKE_BIN" "$DEPLOY_ROOT/.git"

cat >"$FAKE_BIN/node" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "-v" ] || [ "${1:-}" = "--version" ]; then
  printf 'v24.15.0\n'
  exit 0
fi
exit 0
SH

cat >"$FAKE_BIN/npm" <<'SH'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >> "$DEPLOY_TEST_LOG"
if [ "${1:-}" = "-v" ] || [ "${1:-}" = "--version" ]; then
  printf '11.12.1\n'
fi
exit 0
SH

cat >"$FAKE_BIN/git" <<'SH'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$DEPLOY_TEST_LOG"
exit 0
SH

cat >"$FAKE_BIN/systemctl" <<'SH'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$DEPLOY_TEST_LOG"
exit 0
SH

cat >"$FAKE_BIN/curl" <<'SH'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$DEPLOY_TEST_LOG"
printf '{"status":"ok"}\n'
exit 0
SH

cat >"$FAKE_BIN/pgrep" <<'SH'
#!/usr/bin/env bash
printf 'pgrep %s\n' "$*" >> "$DEPLOY_TEST_LOG"
exit 1
SH

chmod +x "$FAKE_BIN"/*

DEPLOY_TEST_LOG="$LOG_FILE" \
DEPLOY_PATH="$DEPLOY_ROOT" \
NODE_BIN_DIR="$FAKE_BIN" \
SKIP_PULL=1 \
bash "$ROOT_DIR/scripts/deploy-systemd-user.sh" >/dev/null

grep -F 'npm ci --include=dev --no-audit --no-fund' "$LOG_FILE" >/dev/null
grep -F 'npm run build' "$LOG_FILE" >/dev/null
grep -F 'systemctl --user restart cs-bi-app.service cs-bi-worker.service' "$LOG_FILE" >/dev/null
