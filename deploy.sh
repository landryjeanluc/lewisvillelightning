#!/usr/bin/env bash
# Publish the site to arachnea.
#
# The static build bakes in data/ at build time — the spotlight player, the
# schedule, the roster. Editing data/ and rsyncing without rebuilding ships a
# stale page, which is exactly how the Oct 13 banner kept naming the wrong
# player. So this always builds first.
#
#   ./deploy.sh              build, publish, verify
#   ./deploy.sh --posters    also re-render the game graphics
#   ./deploy.sh --api-only   skip the site entirely; ship the API and restart
#
# --api-only exists because several agents share this repo: a half-written page
# from someone else breaks the site build, and that should not block shipping a
# backend fix that is ready.
set -euo pipefail

HOST=${LVLNB_HOST:-arachnea}
ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

API_ONLY=0
POSTERS=0
CHECK_ONLY=0
for a in "$@"; do
  case "$a" in
    --api-only) API_ONLY=1 ;;
    --posters) POSTERS=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    *) echo "Unknown argument: $a" >&2; exit 2 ;;
  esac
done
if [[ $API_ONLY -eq 1 && $POSTERS -eq 1 ]]; then
  echo "--api-only cannot be combined with --posters" >&2; exit 2
fi

# A clean release worktree alone is insufficient: another local checkout may
# contain newer work already shown to the user. Publishing an older snapshot
# silently undid the homepage changes on 2026-10-13. Reconcile that work first.
check_release_sources() {
  local entry checkout
  while IFS= read -r -d '' entry; do
    case "$entry" in
      'worktree '*)
        checkout=${entry#worktree }
        if [[ -n $(git -C "$checkout" status --porcelain --untracked-files=normal -- site api data render tools deploy.sh flake.nix flake.lock) ]]; then
          echo "Deployment stopped: unpublished application edits in $checkout" >&2
          echo "Review and commit the intended changes before deploying a release." >&2
          return 1
        fi
        ;;
    esac
  done < <(git worktree list --porcelain -z)
}
if [[ $CHECK_ONLY -eq 0 ]]; then check_release_sources; fi
RELEASE_REVISION=$(git rev-parse HEAD)
command -v uv >/dev/null || { echo "uv not on PATH — enter nix develop" >&2; exit 1; }
echo "==> testing the API against an isolated PostgreSQL"
uv run --project api --frozen bash api/test.sh

command -v node >/dev/null || { echo "node not on PATH — enter the dev shell (direnv allow / nix develop)"; exit 1; }

if [[ $API_ONLY -eq 0 ]]; then
  echo "==> validating data/ against the contract"
  ( cd site && npm ci --no-audit && npm run validate )
else
  echo "==> --api-only: skipping the site build"
fi

if [[ $POSTERS -eq 1 ]]; then
  echo "==> rendering game graphics"
  node render/render.mjs --all
fi

if [[ $CHECK_ONLY -eq 1 ]]; then
  echo "==> checks passed; nothing published"
  exit 0
fi

# Recheck after building in case another editor changed the shared checkout.
check_release_sources
echo "==> deploying revision $RELEASE_REVISION"

# Refuse a deploy without a restorable database backup. No credentials are
# copied to this checkout. Backups stay on the service host, mode 0600.
echo "==> backing up the database on $HOST"
ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
backup_dir=/var/backups/lvlnb
sudo install -d -o lvlnb -g lvlnb -m 700 "$backup_dir"
sudo -u lvlnb bash -c 'umask 077; pg_dump -Fc lvlnb > /var/backups/lvlnb/pre-deploy-$(date -u +%Y%m%dT%H%M%S).dump'
REMOTE

if [[ $API_ONLY -eq 0 ]]; then
  printf '{"revision":"%s"}\n' "$RELEASE_REVISION" > site/dist/deployment.json
  echo "==> publishing to $HOST"
  rsync -a --delay-updates --delete-delay site/dist/ "$HOST:/srv/lvlnb/"
fi
rsync -a --delay-updates data/ "$HOST:/srv/lvlnb-data/"

# The API runs from its own checkout in /opt/lvlnb. Publishing only the site
# meant backend changes never reached production — they sat in git looking
# deployed. Exclude the venv and the captures, which belong to the host.
echo "==> publishing the API"
# --delete with host-only state in the destination is how /opt/lvlnb/.env got
# wiped once, taking the API down: the secrets file is deliberately not in the
# repo, so rsync saw it as removed. Everything the host owns is excluded.
# -rlptD rather than -a: /opt/lvlnb is owned by the lvlnb service user and we
# connect as jl, so preserving owner/group just fails on every file. Ownership
# is set explicitly afterwards.
rsync -rlptD --delay-updates --delete-delay \
      --exclude '.venv' --exclude '__pycache__' --exclude 'private' \
      --exclude '.env' --exclude '*.log' \
      api/ "$HOST:/opt/lvlnb/"
# /opt/lvlnb stays owned by jl so deploys work; lvlnb only reads the code.
# Only .env is the service user's, and it is excluded above.

# The API validates game and player ids against the contract it read at start,
# so a schedule or roster change needs it to re-read. /reload needs an admin
# session; a restart is the version that works from a script.
echo "==> reloading the API"
ssh "$HOST" "sudo install -d -o lvlnb -g lvlnb -m 700 /opt/lvlnb/private/highlights"
ssh "$HOST" "bash -c 'cd /opt/lvlnb && uv sync --frozen --no-dev && sudo systemctl restart lvlnb-api'"

echo "==> verifying"
# systemctl returns as soon as the unit is started, not when uvicorn has bound
# the port — checking immediately reports a healthy service as dead.
# arachnea's login shell is fish, so anything with bash syntax needs wrapping.
ssh "$HOST" "bash -c '
  for i in \$(seq 1 120); do
    out=\$(curl -fsS --max-time 3 http://127.0.0.1:8112/health 2>/dev/null) && { echo \"\$out\"; exit 0; }
    sleep 0.5
  done
  echo \"API did not answer during the 60s readiness window\"; exit 1'" | sed 's/^/    api: /'
code=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' --resolve lvlnb.ca:443:192.168.1.21 https://lvlnb.ca/ || true)
login=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' --resolve lvlnb.ca:443:192.168.1.21 https://lvlnb.ca/login || true)
echo "    gate: / -> $code (expect 302)   /login -> $login (expect 200)"
if [[ "$code" != "302" || "$login" != "200" ]]; then
  echo "==> ERROR: gate did not answer as expected" >&2
  exit 1
fi
echo "==> done"
