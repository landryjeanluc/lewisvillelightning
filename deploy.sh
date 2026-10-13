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
for a in "$@"; do [[ "$a" == "--api-only" ]] && API_ONLY=1; done

command -v node >/dev/null || { echo "node not on PATH — enter the dev shell (direnv allow / nix develop)"; exit 1; }

if [[ $API_ONLY -eq 0 ]]; then
  echo "==> validating data/ against the contract"
  ( cd site && npm run validate --silent )

  echo "==> building"
  ( cd site && npm run build --silent >/dev/null )
else
  echo "==> --api-only: skipping the site build"
fi

if [[ "${1:-}" == "--posters" ]]; then
  echo "==> rendering game graphics"
  node render/render.mjs --all
fi

if [[ $API_ONLY -eq 0 ]]; then
  echo "==> publishing to $HOST"
  rsync -a --delete site/dist/ "$HOST:/srv/lvlnb/"
fi
rsync -a data/ "$HOST:/srv/lvlnb-data/"

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
rsync -rlptD --delete \
      --exclude '.venv' --exclude '__pycache__' --exclude 'private' \
      --exclude '.env' --exclude '*.log' \
      api/ "$HOST:/opt/lvlnb/"
# /opt/lvlnb stays owned by jl so deploys work; lvlnb only reads the code.
# Only .env is the service user's, and it is excluded above.

# The API validates game and player ids against the contract it read at start,
# so a schedule or roster change needs it to re-read. /reload needs an admin
# session; a restart is the version that works from a script.
echo "==> reloading the API"
ssh "$HOST" "bash -c 'sudo systemctl restart lvlnb-api'" || \
  echo "    (could not restart lvlnb-api — do it by hand if data/ changed)"

echo "==> verifying"
# systemctl returns as soon as the unit is started, not when uvicorn has bound
# the port — checking immediately reports a healthy service as dead.
# arachnea's login shell is fish, so anything with bash syntax needs wrapping.
ssh "$HOST" "bash -c '
  for i in \$(seq 1 20); do
    out=\$(curl -fsS --max-time 3 http://127.0.0.1:8112/health 2>/dev/null) && { echo \"\$out\"; exit 0; }
    sleep 0.5
  done
  echo \"API did not answer within 10s\"; exit 1'" | sed 's/^/    api: /'
code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve lvlnb.ca:443:192.168.1.21 https://lvlnb.ca/ || true)
login=$(curl -sk -o /dev/null -w '%{http_code}' --resolve lvlnb.ca:443:192.168.1.21 https://lvlnb.ca/login || true)
echo "    gate: / -> $code (expect 302)   /login -> $login (expect 200)"
[[ "$code" == "302" && "$login" == "200" ]] && echo "==> done" || echo "==> WARNING: gate did not answer as expected"
