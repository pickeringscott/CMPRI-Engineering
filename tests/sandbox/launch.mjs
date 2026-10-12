import { readFileSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const mode=process.argv[2] || 'production';
if(!['development','production','build'].includes(mode)) throw Error('Invalid local runtime mode');
const root = new URL('../../', import.meta.url);
const keys = JSON.parse(readFileSync(new URL('.sandbox/local-keys.json', root)));
if (!/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(keys.API_URL)) throw Error('Local stack only');
const env = {
  PATH: process.env.PATH,
  NODE_OPTIONS: `--require ${fileURLToPath(new URL('./network-guard.cjs', import.meta.url))}`,
  NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('.sandbox/push-cert.pem', root)),
  NODE_ENV: mode==='development'?'development':'production', NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_SUPABASE_URL: keys.API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: keys.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: keys.SERVICE_ROLE_KEY,
  NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3112',
};
const log = openSync(new URL('.sandbox/app.log', root), 'a');
const args=mode==='build'?['build','--webpack']:mode==='development'?['dev','--webpack','--hostname','127.0.0.1','--port','3112']:['start','--hostname','127.0.0.1','--port','3112'];
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', ...args], { cwd: root, env, stdio: ['ignore', log, log] });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
