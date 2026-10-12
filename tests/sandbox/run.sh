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
if ! supabase start --workdir .sandbox --exclude realtime,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor >.sandbox/startup.log 2>&1; then
  python - <<'PY_DIAGNOSTICS'
from pathlib import Path
import json, re
lines = Path('.sandbox/startup.log').read_text().splitlines()
errors = [line for line in lines if re.search(r'error|failed|fatal|no space', line, re.I)][-20:]
errors = [re.sub(r'eyJ[\w-]+\.[\w-]+\.[\w-]+', '[redacted JWT]', line) for line in errors]
Path('.sandbox/setup-diagnostics.json').write_text(json.dumps({'phase': 'local Supabase startup', 'passed': False, 'errors': errors}, indent=2))
print('Local Supabase startup failed; sanitized diagnostics recorded')
PY_DIAGNOSTICS
  exit 1
fi
supabase status --workdir .sandbox --output json >.sandbox/local-keys.json 2>.sandbox/status.log
openssl req -x509 -newkey rsa:2048 -nodes -keyout .sandbox/push-key.pem -out .sandbox/push-cert.pem -days 1 -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1' >.sandbox/tls.log 2>&1
node --require ./tests/sandbox/network-guard.cjs tests/sandbox/seed.mjs
node tests/sandbox/push-sink.mjs >.sandbox/push-sink.log 2>&1 &
sink_pid=$!
node tests/sandbox/launch.mjs &
app_pid=$!
export CMPRI_SANDBOX_PHASE="app startup"
on_exit() {
  local result=$?
  CMPRI_SANDBOX_EXIT="$result" python tests/sandbox/server_diagnostics.py || true
  kill "$app_pid" "$sink_pid" 2>/dev/null || true
  exit "$result"
}
trap on_exit EXIT
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
export CMPRI_SANDBOX_PHASE="Auth/session/draft API preflight"
node --require ./tests/sandbox/network-guard.cjs tests/sandbox/auth-preflight.mjs
export CMPRI_SANDBOX_PHASE="browser login preflight"
python tests/sandbox/browser_preflight.py
export CMPRI_SANDBOX_PHASE="draft access prerequisites"
node --require ./tests/sandbox/network-guard.cjs tests/sandbox/drafts-check.mjs
draft_status=$?
export CMPRI_SANDBOX_PHASE="seven-role browser matrix"
set +e
python tests/sandbox/e2e.py
browser_status=$?
export CMPRI_SANDBOX_PHASE="backend verification"
node --require ./tests/sandbox/network-guard.cjs tests/sandbox/rls-check.mjs
rls_status=$?
node --require ./tests/sandbox/network-guard.cjs tests/sandbox/storage-check.mjs
storage_status=$?
node --require ./tests/sandbox/network-guard.cjs tests/sandbox/lifecycle.mjs
lifecycle_status=$?
NODE_EXTRA_CA_CERTS="$PWD/.sandbox/push-cert.pem" node --require ./tests/sandbox/network-guard.cjs tests/sandbox/notification-db-check.mjs
notification_status=$?
node --require ./tests/sandbox/network-guard.cjs tests/sandbox/notification-state.mjs
notification_state_status=$?
set -e
node --input-type=module - "$browser_status" "$rls_status" "$notification_status" "$lifecycle_status" "$draft_status" "$storage_status" "$notification_state_status" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const gaps=JSON.parse(readFileSync('.sandbox/role-gaps.json'));
const statuses=process.argv.slice(2).map(Number);
const result={browserExit:statuses[0],rlsExit:statuses[1],notificationExit:statuses[2],lifecycleExit:statuses[3],notificationStateExit:statuses[6],draftExit:statuses[4],storageExit:statuses[5],roleGaps:gaps,passed:statuses.every(code=>code===0)&&gaps.length===0,limitations:['No production data or deployed environment tested','No browser push enrollment or device notification delivery','Lifecycle transitions use real Auth/API/DB; detail-page transition controls are not exercised','Spanish text preservation and Cancel labels only; content translation is not implemented','Physical phone push and manual refresh remain separate']};
writeFileSync('.sandbox/summary.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
if(!result.passed)process.exitCode=1;
JS
