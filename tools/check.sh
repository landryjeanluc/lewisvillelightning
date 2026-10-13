#!/usr/bin/env bash
# The reproducible local quality gate; use `nix develop --command bash tools/check.sh`.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd site && npm ci --no-audit && npm run validate)
uv run --project api --frozen bash api/test.sh
python -m unittest discover -s tools/spordle -p '*_test.py'
node --test tools/spordle/core.test.mjs
for test in tools/test_*_ui.mjs tools/test_pwa.mjs; do
  node "$test"
done
git diff --check
