set -e
export PGDATA=/tmp/lvlnb-pg
export PGHOST=/tmp/lvlnb-pg-sock
rm -rf "$PGDATA" "$PGHOST"; mkdir -p "$PGHOST"
initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null 2>&1
pg_ctl -D "$PGDATA" -o "-k $PGHOST -h ''" -l /tmp/lvlnb-pg.log start >/dev/null 2>&1
for i in $(seq 1 40); do pg_isready -h "$PGHOST" -q && break; done
createdb -h "$PGHOST" -U postgres lvlnb
echo "postgres up"

export DATABASE_URL="postgresql://postgres@/lvlnb?host=$PGHOST"
export UPLOAD_DIR=/tmp/lvlnb-test-uploads; rm -rf "$UPLOAD_DIR"; mkdir -p "$UPLOAD_DIR"
export SESSION_SECRET="test-secret-not-production"
export DATA_DIR=/home/jl/repos/LewisvilleLightning/data
export COOKIE_SECURE=0
cd /home/jl/repos/LewisvilleLightning/api
python test_api.py
RC=$?
pg_ctl -D "$PGDATA" stop >/dev/null 2>&1 || true
exit $RC
