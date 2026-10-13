#!/usr/bin/env bash
# What CI runs before anything is published.
#
# It has one line of real content, on purpose: the repo's own quality gate,
# in the repo's own dev shell. CI and `nix develop --command bash
# tools/check.sh` on a laptop are then literally the same run, and the
# toolchain is pinned by flake.nix rather than by a list kept in CI that
# drifts from it. Called by both workflows here so the check a deploy runs is
# the check a push ran.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f tools/check.sh ]; then
  exec nix develop --command bash tools/check.sh
fi

# --- temporary: delete this block, and the `if` above, together -------------
# tools/check.sh arrives with the refactor in flight on 2026-10-13. Until it
# lands, run the same ground against the toolchain the runner carries itself
# (nixos-builds hosts/arachnea/guests/lvlnb-ci.nix). Keeping CI green through
# the refactor is the whole point of standing it up now.
echo "note: no tools/check.sh in this tree yet — running the inline gate"

echo "==> site dependencies"
( cd site && npm ci --no-audit --no-fund )

echo "==> data contract and build"
# The contract check too: data/*.json is parsed through lib/schema.ts at build
# time and a bad file fails the build loudly.
( cd site && npm run build )

echo "==> API suite"
# test.sh stands up a throwaway Postgres with initdb and throws it away after.
# This is why the runner is not root: initdb refuses to run as one.
( cd api && bash test.sh )

echo "==> browser suites"
for t in test_goals_ui test_plays_ui test_jobs_ui test_pwa test_roster_ui test_player_goals_ui; do
  echo "--- $t"
  node "tools/$t.mjs"
done

echo "==> gate passed"
