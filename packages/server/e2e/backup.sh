#!/usr/bin/env bash
# End-to-end test of scheduled backups in the real teriac-server image, with real rclone,
# against a local S3 server (`rclone serve s3`, from the same image). No cloud account needed.
# Usage: packages/server/e2e/backup.sh [image]   (default: teriac-server:dev)
set -euo pipefail

IMAGE="${1:-teriac-server:dev}"
NET=teriac-bk
PORT=18091
TOKEN=e2e-api-token-0123456789abcdef
KEY=AKIDE2E SECRET=e2e-secret-key-0123456789
WORK="$(mktemp -d)"
S3=teriac-bk-s3 SRV=teriac-bk-server VOL=teriac-bk-data

cleanup() {
  docker rm -f "$S3" "$SRV" >/dev/null 2>&1 || true
  docker volume rm -f "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
cleanup
trap 'cleanup; rm -rf "$WORK"' EXIT
openssl genrsa -out "$WORK/app.pem" 2048 2>/dev/null
chmod 644 "$WORK/app.pem"
docker network create "$NET" >/dev/null

fail() { echo "FAILED: $1"; docker logs "$SRV" 2>&1 | tail -15; exit 1; }
ok() { echo "ok: $1"; }
# Saved first: `grep -q` stops reading early, which fails a pipe under pipefail.
logs_have() { docker logs "$SRV" > "$WORK/server.log" 2>&1; grep -q "$1" "$WORK/server.log"; }

start_s3() {
  docker run -d --name "$S3" --network "$NET" --entrypoint sh "$IMAGE" -c \
    "mkdir -p /tmp/s3/backups && exec rclone serve s3 --auth-key $KEY,$SECRET --addr :9000 --dir-cache-time 1s /tmp/s3" >/dev/null
  for _ in $(seq 1 30); do docker exec "$S3" node -e "require('net').connect(9000, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))" 2>/dev/null && return; sleep 0.5; done
  docker logs "$S3" 2>&1 | tail -5; fail "S3 server did not start"
}
objects() { docker exec "$S3" sh -c "ls /tmp/s3/backups/${1:-teriac/e2e} 2>/dev/null" || true; }

# start_server [secret] [path] [schedule]: a fresh container on the data volume.
start_server() {
  docker rm -f "$SRV" >/dev/null 2>&1 || true
  # Same limits as the Helm chart: read-only root filesystem, non-root, all capabilities dropped.
  docker create --name "$SRV" --network "$NET" -p "$PORT:8080" -v "$VOL:/data" \
    --read-only --tmpfs /tmp --tmpfs /home/teriac:uid=10001,gid=10001 --cap-drop ALL --security-opt no-new-privileges \
    -e TERIAC_GITHUB_APP_ID=1 -e TERIAC_GITHUB_PRIVATE_KEY="$(cat "$WORK/app.pem")" -e TERIAC_GITHUB_WEBHOOK_SECRET=x \
    -e TERIAC_REPO_ALLOWLIST='github.com/acme/*' -e TERIAC_DRIFT=false -e TERIAC_API_TOKEN="$TOKEN" \
    -e TERIAC_BACKUP_ENABLED=true -e TERIAC_BACKUP_SCHEDULE="${3:-* * * * *}" \
    -e TERIAC_BACKUP_BACKEND=s3 -e TERIAC_BACKUP_BUCKET=backups -e TERIAC_BACKUP_PATH="${2:-teriac/e2e}" \
    -e TERIAC_BACKUP_S3_ENDPOINT="http://$S3:9000" -e TERIAC_BACKUP_S3_REGION=us-east-1 \
    -e AWS_ACCESS_KEY_ID="$KEY" -e AWS_SECRET_ACCESS_KEY="${1:-$SECRET}" \
    "$IMAGE" >/dev/null
  docker start "$SRV" >/dev/null
}
wait_ready() {
  for _ in $(seq 1 60); do
    curl -sf "localhost:$PORT/readyz" >/dev/null && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$SRV")" = true ] || return 1
    sleep 1
  done
  return 1
}
api() { curl -s -H "Authorization: Bearer $TOKEN" "$@"; }
sql() { docker exec "$SRV" node -e "
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync('/data/teriac.db'); d.exec('PRAGMA busy_timeout = 5000');
  $1"; }
mark() { sql "d.prepare(\"INSERT INTO audit (at, repo, pr, user, action, project, allowed, reason) VALUES (?, 'r', 0, 'e2e', 'marker', 'p', 1, ?)\").run(new Date().toISOString(), '$1')"; }
has_mark() { [ "$(sql "console.log(d.prepare('SELECT count(*) AS n FROM audit WHERE reason = ?').get('$1').n)")" = 1 ]; }
leftovers() { docker exec "$SRV" sh -c 'ls -A /data | grep -E "^\.(backup|restore)-" || true'; }

start_s3
start_server
wait_ready || fail "server did not start with an empty bucket"
logs_have 'no backups found; starting with an empty database' || fail "empty bucket not reported"
ok "empty bucket: starts with an empty database"

mark MARKER-1
before=$(objects | wc -l | tr -d ' ')
r=$(api -X POST "localhost:$PORT/api/backups/run")
echo "$r" | grep -q '"ok":true' || fail "manual backup: $r"
name=$(echo "$r" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).name))")
if ! { [ "$(objects | wc -l | tr -d ' ')" = $((before + 1)) ] && objects | grep -qx "$name"; }; then
  fail "backup now should add $name, bucket has: $(objects)"
fi
[ -z "$(leftovers)" ] || fail "copies left on the volume: $(leftovers)"
ok "backup now: $name in the bucket, nothing left on the volume"

for _ in $(seq 1 80); do
  api "localhost:$PORT/api/backups" | grep -q '"trigger":"schedule","ok":true' && break
  sleep 1
done
api "localhost:$PORT/api/backups" | grep -q '"trigger":"schedule","ok":true' || fail "no scheduled backup within 80s"
[ -z "$(leftovers)" ] || fail "copies left after the scheduled backup"
curl -s "localhost:$PORT/metrics" | grep -q '^teriac_backup_last_ok 1' || fail "metrics"
ok "schedule (* * * * *): backed up on its own; metrics say ok"

# Upload fails while the bucket is down: recorded, nothing left behind, then recovers.
docker stop "$S3" >/dev/null
code=$(api -o "$WORK/fail.json" -w '%{http_code}' -X POST "localhost:$PORT/api/backups/run")
[ "$code" = 502 ] || fail "expected 502 while the bucket is down, got $code"
[ -z "$(leftovers)" ] || fail "copies left after a failed upload: $(leftovers)"
curl -s "localhost:$PORT/metrics" | grep -q '^teriac_backup_last_ok 0' || fail "metrics after failure"
docker start "$S3" >/dev/null
sleep 2
api -X POST "localhost:$PORT/api/backups/run" | grep -q '"ok":true' || fail "backup after the bucket came back"
ok "bucket down: backup fails cleanly (502, nothing left on the volume) and works again after"

# Lose the volume: a new one is restored from the newest backup.
mark MARKER-2
api -X POST "localhost:$PORT/api/backups/run" >/dev/null
docker rm -f "$SRV" >/dev/null && docker volume rm "$VOL" >/dev/null
start_server
wait_ready || fail "server did not start after losing the volume"
logs_have 'database restored from backup' || fail "restore not logged"
if ! { has_mark MARKER-1 && has_mark MARKER-2; }; then fail "restored database is missing data"; fi
ok "volume lost: restored from the newest backup, with all data"

# A volume that has a database keeps it: nothing is downloaded over it.
mark MARKER-LOCAL
docker rm -f "$SRV" >/dev/null
start_server
wait_ready || fail "restart with existing volume"
logs_have 'database restored' && fail "restored over an existing database"
has_mark MARKER-LOCAL || fail "local data lost on restart"
ok "existing volume: kept as is, no restore"

# Broken newest backup (cut-short upload) and one expired after listing: skipped.
docker exec "$S3" sh -c 'printf "\037\213\010" > /tmp/s3/backups/teriac/e2e/teriac-29991231T000000Z.db.gz'
docker rm -f "$SRV" >/dev/null && docker volume rm "$VOL" >/dev/null
start_server
wait_ready || fail "start with a broken newest backup"
logs_have 'trying an older one' || fail "broken backup not skipped"
has_mark MARKER-2 || fail "fell back to the wrong backup"
ok "broken newest backup: skipped, restored the one before"

# Old backups expired by a lifecycle rule don't matter: each backup is whole on its own.
docker exec "$S3" sh -c 'cd /tmp/s3/backups/teriac/e2e && rm -f teriac-2999*; ls | sort | head -n -1 | xargs -r rm -f'
docker rm -f "$SRV" >/dev/null && docker volume rm "$VOL" >/dev/null
start_server
wait_ready || fail "start after old backups expired"
has_mark MARKER-2 || fail "restore after expiry lost data"
ok "only the newest backup left (others expired): restore still complete"

# Wrong credentials on an empty volume: refuses to start rather than start empty.
docker rm -f "$SRV" >/dev/null && docker volume rm "$VOL" >/dev/null
start_server wrong-secret
if wait_ready; then fail "started with wrong credentials"; fi
logs_have 'cannot start: cannot list backups' || fail "no clear error for wrong credentials"
ok "wrong credentials: refuses to start, says why ($(docker logs "$SRV" 2>&1 | grep -o 'cannot list backups[^.]*' | head -1 | cut -c1-90)…)"

# A bad setting stops the server at start-up with one line.
docker rm -f "$SRV" >/dev/null
start_server "$SECRET" teriac/e2e "every day"
if wait_ready; then fail "started with a bad schedule"; fi
logs_have 'TERIAC_BACKUP_SCHEDULE .*every day.* is not a cron expression' || fail "bad schedule message"
ok "bad schedule: refuses to start, says why"
echo "backup e2e passed"
