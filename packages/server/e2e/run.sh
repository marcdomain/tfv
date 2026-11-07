#!/usr/bin/env bash
# End-to-end test of the real tfv-server image: a mock GitHub API and a git
# server run in one container, tfv-server in another, real terraform plans.
# Usage: packages/server/e2e/run.sh [image]   (default: tfv-server:dev)
set -euo pipefail

IMAGE="${1:-tfv-server:dev}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NET=tfv-e2e
PORT=18090
SECRET=whsec-e2e
WORK="$(mktemp -d)"

remove_containers() {
  docker rm -f tfv-e2e-mock tfv-e2e-server >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
remove_containers                      # leftovers from an earlier run
trap 'remove_containers; rm -rf "$WORK"' EXIT

openssl genrsa -out "$WORK/app.pem" 2048 2>/dev/null
chmod 644 "$WORK/app.pem"   # read by the non-root user in the container
docker network create "$NET" >/dev/null

# Mock GitHub + git daemon, reusing the tfv image (it has node and git).
docker create --name tfv-e2e-mock --network "$NET" --user 0 "$IMAGE" sh -c '
  set -e
  mkdir -p /tmp/src/envs/dev /tmp/git
  cd /tmp/src
  printf "resource \"terraform_data\" \"app\" {\n  input = \"hello\"\n}\n" > envs/dev/main.tf
  echo 1.9.8 > envs/dev/.terraform-version
  git init -q -b main && git -c user.name=bob -c user.email=bob@acme.dev add -A
  git -c user.name=bob -c user.email=bob@acme.dev commit -qm "Add dev app"
  git clone -q --bare /tmp/src /tmp/git/infra.git
  git -C /tmp/git/infra.git config uploadpack.allowAnySHA1InWant true
  git daemon --export-all --base-path=/tmp/git --reuseaddr --detach
  REPO_DIR=/tmp/git/infra.git exec node /tmp/mock-github.mjs' >/dev/null
docker cp "$HERE/mock-github.mjs" tfv-e2e-mock:/tmp/mock-github.mjs
docker start tfv-e2e-mock >/dev/null

docker create --name tfv-e2e-server --network "$NET" -p "$PORT:8080" \
  -e TFV_GITHUB_APP_ID=1 \
  -e TFV_GITHUB_API_URL=http://tfv-e2e-mock:3000 \
  -e TFV_GITHUB_PRIVATE_KEY_FILE=/tmp/app.pem \
  -e TFV_GITHUB_WEBHOOK_SECRET="$SECRET" \
  -e TFV_REPO_ALLOWLIST='tfv-e2e-mock:3000/acme/*' \
  -e TFV_REQUIRE_APPLY_PROJECT=true \
  -e TFV_DRIFT=false \
  "$IMAGE" >/dev/null
docker cp "$WORK/app.pem" tfv-e2e-server:/tmp/app.pem
docker start tfv-e2e-server >/dev/null

state() { docker exec tfv-e2e-mock node -e "fetch('http://localhost:3000/_state').then(r=>r.text()).then(t=>process.stdout.write(t))"; }
wait_for() { # wait_for <description> <node expression on state s>
  for _ in $(seq 1 90); do
    if state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{s=JSON.parse(s);process.exit(($2)?0:1)})" 2>/dev/null; then
      echo "ok: $1"; return 0
    fi
    sleep 2
  done
  echo "FAILED: $1"; state; echo; docker logs tfv-e2e-server | tail -20; exit 1
}
hook() { # hook <event> <json>
  local sig; sig="sha256=$(printf '%s' "$2" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
  curl -sf -X POST "localhost:$PORT/events/github" -H "x-github-event: $1" -H "x-hub-signature-256: $sig" -d "$2" >/dev/null
}

for _ in $(seq 1 30); do curl -sf "localhost:$PORT/readyz" >/dev/null && break; sleep 1; done
HEAD=$(state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).head))")
REPO='{"name":"infra","full_name":"acme/infra","owner":{"login":"acme"},"clone_url":"git://tfv-e2e-mock/infra.git"}'
PR="{\"number\":1,\"title\":\"Add dev app\",\"html_url\":\"x\",\"user\":{\"login\":\"bob\"},\"draft\":false,\"head\":{\"sha\":\"$HEAD\",\"ref\":\"feat\",\"repo\":{\"full_name\":\"acme/infra\"}},\"base\":{\"ref\":\"main\",\"repo\":{\"full_name\":\"acme/infra\"}}}"
comment() { hook issue_comment "{\"action\":\"created\",\"installation\":{\"id\":1},\"repository\":$REPO,\"issue\":{\"number\":1,\"pull_request\":{}},\"comment\":{\"id\":$1,\"body\":\"$2\",\"user\":{\"login\":\"bob\",\"type\":\"User\"}}}"; }

hook pull_request "{\"action\":\"opened\",\"installation\":{\"id\":1},\"repository\":$REPO,\"pull_request\":$PR}"
wait_for "autoplan posted the summary comment" "s.comments.some(c => c.body.includes('envs/dev') && c.body.includes('| terraform 1.9.8 | 📝 **+1**') && c.body.includes('**Next steps**'))"
wait_for "check run with an Apply button" "s.checks.some(c => c.name === 'tfv: envs/dev' && c.status === 'completed' && c.actions?.[0]?.identifier === 'apply')"

comment 101 "tfv apply"
wait_for "bare apply refused (one project at a time)" "s.comments.some(c => c.body.includes('applies one project at a time') && c.body.includes('tfv apply -p envs/dev'))"

comment 102 "tfv apply -p envs/dev"
wait_for "apply succeeded" "s.checks.some(c => c.name === 'tfv: envs/dev' && c.output?.title === 'Applied')"
wait_for "comment shows applied" "s.comments.some(c => c.body.includes('✅ applied'))"

echo "e2e passed"
