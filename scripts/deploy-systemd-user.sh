#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_PATH="${DEPLOY_PATH:-$HOME/work/cs_bi_server}"
NODE_BIN_DIR="${NODE_BIN_DIR:-$HOME/.nvm/versions/node/v24.15.0/bin}"
APP_SERVICE="${APP_SERVICE:-cs-bi-app.service}"
WORKER_SERVICE="${WORKER_SERVICE:-cs-bi-worker.service}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/healthz}"
SKIP_PULL="${SKIP_PULL:-0}"

log() {
  printf '[deploy] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[deploy] missing required command: %s\n' "$1" >&2
    exit 127
  fi
}

find_project_node_pids() {
  pgrep -f 'node server-dist/server/entrypoints/(app|sync-worker)\.js' 2>/dev/null | while read -r pid; do
    if [ -z "$pid" ] || [ ! -d "/proc/$pid" ]; then
      continue
    fi

    pid_cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    if [ "$pid_cwd" = "$DEPLOY_PATH" ]; then
      printf '%s\n' "$pid"
    fi
  done
}

export PATH="$NODE_BIN_DIR:$PATH"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

require_command git
require_command node
require_command npm
require_command systemctl
require_command curl
require_command pgrep

if [ ! -d "$DEPLOY_PATH/.git" ]; then
  printf '[deploy] deploy path is not a git repository: %s\n' "$DEPLOY_PATH" >&2
  exit 1
fi

cd "$DEPLOY_PATH"

log "deploying branch $DEPLOY_BRANCH in $DEPLOY_PATH"
log "using node $(node -v) and npm $(npm -v)"

if [ "$SKIP_PULL" != "1" ]; then
  git fetch origin "$DEPLOY_BRANCH"

  current_branch="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$current_branch" != "$DEPLOY_BRANCH" ]; then
    git checkout "$DEPLOY_BRANCH"
  fi

  git pull --ff-only origin "$DEPLOY_BRANCH"
fi

npm ci --include=dev --no-audit --no-fund
npm run build

log "stopping systemd user services"
systemctl --user stop "$APP_SERVICE" "$WORKER_SERVICE" || true

project_pids="$(find_project_node_pids || true)"
if [ -n "$project_pids" ]; then
  log "stopping leftover project node processes: $(printf '%s' "$project_pids" | tr '\n' ' ')"
  kill $project_pids || true

  for _ in $(seq 1 10); do
    project_pids="$(find_project_node_pids || true)"
    if [ -z "$project_pids" ]; then
      break
    fi
    sleep 1
  done

  project_pids="$(find_project_node_pids || true)"
  if [ -n "$project_pids" ]; then
    log "force stopping leftover project node processes: $(printf '%s' "$project_pids" | tr '\n' ' ')"
    kill -9 $project_pids || true
  fi
fi

log "restarting systemd user services"
systemctl --user daemon-reload
systemctl --user restart "$APP_SERVICE" "$WORKER_SERVICE"
systemctl --user is-active --quiet "$APP_SERVICE"
systemctl --user is-active --quiet "$WORKER_SERVICE"

health_body="$(mktemp)"
trap 'rm -f "$health_body"' EXIT

for _ in $(seq 1 20); do
  if curl --fail --silent --show-error "$HEALTH_URL" >"$health_body"; then
    log "health check passed: $(cat "$health_body")"
    exit 0
  fi
  sleep 1
done

systemctl --user status "$APP_SERVICE" "$WORKER_SERVICE" --no-pager || true
printf '[deploy] health check failed: %s\n' "$HEALTH_URL" >&2
exit 1
