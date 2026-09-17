// Isolated production-server smoke checks. No real account or production data.
import { spawn } from 'node:child_process';
const port = 3110;
const anonymousDenied = [401, 403];
const cases = [
  ...['/', '/engineering', '/engineering/purchasing', '/engineering/gss',
    '/engineering/pool-log', '/engineering/preventive-maintenance', '/engineering/room-ranker',
    '/work-orders', '/work-orders/test-id', '/management/equipment',
    '/management/rooms', '/management/users', '/technician', '/reset-password']
    .map(path => ({ path, method: 'GET', expected: [200] })),
  ...['/api/session', '/api/engineering/operations', '/api/integrations/email/scan',
    '/api/work-orders/test-id/activity', '/api/pool-log', '/api/assets', '/api/assets/documentation',
    '/api/users', '/api/room-ranker', '/api/corporate-pm']
    .map(path => ({path, method: 'GET', expected: anonymousDenied})),
  ...['/api/engineering/operations', '/api/pool-log', '/api/assets', '/api/users',
    '/api/maintenance-ai', '/api/work-orders', '/api/room-ranker', '/api/corporate-pm',
    '/api/work-orders/test-id']
    .map(path => ({path, method: path === '/api/engineering/operations' || path === '/api/assets' || path === '/api/users' || path === '/api/room-ranker' || path === '/api/corporate-pm' || path === '/api/work-orders/test-id' ? 'PATCH' : 'POST', expected: anonymousDenied})),
];
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start',
  '--hostname', '127.0.0.1', '--port', String(port)], {
  env: {...process.env, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'cmpri-local-test-placeholder',
    SUPABASE_SERVICE_ROLE_KEY: '', CRON_SECRET: ''},
  stdio: ['ignore', 'pipe', 'pipe'],
});
let started = false;
let finished = false;
const deadline = setTimeout(() => {
  console.error('FAIL: production server test deadline exceeded');
  process.exitCode = 1;
  server.kill();
}, 45000);
server.stderr.on('data', d => process.stderr.write(d));
server.on('error', e => { console.error(e); process.exitCode = 1; clearTimeout(deadline); });
server.on('exit', () => {
  clearTimeout(deadline);
  if (!finished) process.exitCode = 1;
});
server.stdout.on('data', async chunk => {
  if (started || !chunk.toString().includes('Ready')) return;
  started = true;
  let failures = 0;
  try {
    for (const test of cases) {
      const response = await fetch(`http://127.0.0.1:${port}${test.path}`, {
        method: test.method, signal: AbortSignal.timeout(10000),
        ...(test.method !== 'GET' ? {headers: {'Content-Type': 'application/json'}, body: '{}'} : {}),
      });
      const passed = test.expected.includes(response.status);
      failures += Number(!passed);
      console.log(JSON.stringify({...test, actual: response.status, result: passed ? 'PASS' : 'FAIL'}));
    }
    console.log(`${cases.length - failures}/${cases.length} HTTP checks passed. Not authenticated workflow or browser tests.`);
    process.exitCode = failures ? 1 : 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    finished = true;
    clearTimeout(deadline);
    server.kill();
  }
});
