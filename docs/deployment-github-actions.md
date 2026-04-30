# GitHub Actions Deployment

This project deploys to `lintico-server-1@183.6.71.38:2222` under `~/work/cs_bi_server`.

## Workflow

- File: `.github/workflows/deploy.yml`
- Triggers: push to `main`, or manual `workflow_dispatch`
- Runtime path: `/home/lintico-server-1/work/cs_bi_server`
- Node path: `/home/lintico-server-1/.nvm/versions/node/v24.15.0/bin`
- Services restarted:
  - `cs-bi-app.service`
  - `cs-bi-worker.service`

## Required GitHub Secret

Add this repository secret:

- `DEPLOY_SSH_PRIVATE_KEY`: private key for an SSH key allowed to log in as `lintico-server-1`.

The matching public key must be present in `/home/lintico-server-1/.ssh/authorized_keys` on the server.

## What Deployment Does

The deployment script:

1. Pulls `origin/main` with `git pull --ff-only`.
2. Runs `npm ci --include=dev --no-audit --no-fund`.
3. Runs `npm run build`.
4. Stops the two user-level systemd services.
5. Cleans leftover project Node processes from `~/work/cs_bi_server`.
6. Restarts the two user-level systemd services.
7. Checks `http://127.0.0.1:8787/healthz`.

Server-local `.env`, `config/sync/config.json`, `config/gcp/*.json`, and `config/data/*` are preserved because they are gitignored.

## Manual Deployment

From a machine that can SSH to the server:

```bash
ssh -p 2222 lintico-server-1@183.6.71.38 'cd ~/work/cs_bi_server && DEPLOY_BRANCH=main bash scripts/deploy-systemd-user.sh'
```
