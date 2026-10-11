#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
test ! -e .env.local || { echo 'Refusing an app checkout containing .env.local'; exit 1; }
test ! -d .sandbox || { echo 'Use a fresh ephemeral checkout; .sandbox already exists'; exit 1; }
umask 077
mkdir -p .sandbox/supabase
cp tests/sandbox/config.toml .sandbox/supabase/config.toml
cp -R supabase/migrations .sandbox/supabase/migrations

# Never link, db push, or load remote credentials. Only this local project starts.
export SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io
supabase start --workdir .sandbox --exclude realtime,storage-api,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor >.sandbox/startup.log 2>&1
supabase status --workdir .sandbox --output json >.sandbox/local-keys.json 2>.sandbox/status.log
openssl req -x509 -newkey rsa:2048 -nodes -keyout .sandbox/push-key.pem -out .sandbox/push-cert.pem -days 1 -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1' >.sandbox/tls.log 2>&1
node tests/sandbox/seed.mjs
node tests/sandbox/push-sink.mjs >.sandbox/push-sink.log 2>&1 &
sink_pid=$!
node tests/sandbox/launch.mjs &
app_pid=$!
trap 'kill "$app_pid" "$sink_pid" 2>/dev/null || true' EXIT
python - <<'PY'
import time, urllib.request
for attempt in range(120):
    try:
        urllib.request.urlopen('http://127.0.0.1:3112/', timeout=2)
        break
    except Exception:
        time.sleep(1)
else:
    raise SystemExit('Local app failed to become ready; inspect private app.log')
PY
set +e
python tests/sandbox/e2e.py
browser_status=$?
node tests/sandbox/rls-check.mjs
rls_status=$?
NODE_EXTRA_CA_CERTS="$PWD/.sandbox/push-cert.pem" node --require ./tests/sandbox/network-guard.cjs tests/sandbox/notification-db-check.mjs
notification_status=$?
set -e
node --input-type=module - "$browser_status" "$rls_status" "$notification_status" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const gaps=JSON.parse(readFileSync('.sandbox/role-gaps.json'));
const statuses=process.argv.slice(2).map(Number);
const result={browserExit:statuses[0],rlsExit:statuses[1],notificationExit:statuses[2],roleGaps:gaps,passed:statuses.every(code=>code===0)&&gaps.length===0,limitations:['No production data or deployed environment tested','No browser push enrollment or device notification delivery','Verified manual storage fixtures and full engineering lifecycle still require additional E2E coverage']};
writeFileSync('.sandbox/summary.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
if(!result.passed)process.exitCode=1;
JS
