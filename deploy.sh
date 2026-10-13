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
set -euo pipefail

HOST=${LVLNB_HOST:-arachnea}
ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

command -v node >/dev/null || { echo "node not on PATH — enter the dev shell (direnv allow / nix develop)"; exit 1; }

echo "==> validating data/ against the contract"
( cd site && npm run validate --silent )

echo "==> building"
( cd site && npm run build --silent >/dev/null )

if [[ "${1:-}" == "--posters" ]]; then
  echo "==> rendering game graphics"
  node render/render.mjs --all
fi

echo "==> publishing to $HOST"
rsync -a --delete site/dist/ "$HOST:/srv/lvlnb/"
rsync -a           data/      "$HOST:/srv/lvlnb-data/"

# The API validates game and player ids against the contract it read at start,
# so a schedule or roster change needs it to re-read. /reload needs an admin
# session; a restart is the version that works from a script.
echo "==> reloading the API"
ssh "$HOST" 'sudo systemctl restart lvlnb-api' || \
  echo "    (could not restart lvlnb-api — do it by hand if data/ changed)"

echo "==> verifying"
ssh "$HOST" 'curl -fsS --max-time 5 http://127.0.0.1:8112/health && echo' | sed 's/^/    api: /'
code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve lvlnb.ca:443:192.168.1.21 https://lvlnb.ca/ || true)
login=$(curl -sk -o /dev/null -w '%{http_code}' --resolve lvlnb.ca:443:192.168.1.21 https://lvlnb.ca/login || true)
echo "    gate: / -> $code (expect 302)   /login -> $login (expect 200)"
[[ "$code" == "302" && "$login" == "200" ]] && echo "==> done" || echo "==> WARNING: gate did not answer as expected"
