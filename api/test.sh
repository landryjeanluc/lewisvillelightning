set -euo pipefail
API_DIR=$(cd "$(dirname "$0")" && pwd)
TEST_ROOT=$(mktemp -d /tmp/lvlnb-test.XXXXXX)
export PGDATA="$TEST_ROOT/pg"
export PGHOST="$TEST_ROOT/sock"
mkdir -p "$PGHOST"
cleanup() {
  pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT
initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null 2>&1
pg_ctl -D "$PGDATA" -o "-k $PGHOST -h ''" -l "$TEST_ROOT/postgres.log" start >/dev/null 2>&1
for i in $(seq 1 40); do pg_isready -h "$PGHOST" -q && break; done
createdb -h "$PGHOST" -U postgres lvlnb
echo "postgres up"

export DATABASE_URL="postgresql://postgres@/lvlnb?host=$PGHOST"
export UPLOAD_DIR="$TEST_ROOT/uploads"; mkdir -p "$UPLOAD_DIR"
export SESSION_SECRET="test-secret-not-production"
export DATA_DIR="$API_DIR/../data"
export COOKIE_SECURE=0
cd "$API_DIR"
python test_api.py
