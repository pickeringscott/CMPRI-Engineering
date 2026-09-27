// Isolated production-server smoke checks. No real account or production data.
import { spawn } from 'node:child_process';
const port = 3110;
const anonymousDenied = [401, 403];
const apiReachable = [401, 403, 405];
const uiPaths = [
  '/', '/engineering', '/engineering/enseo-assignments', '/engineering/gss',
  '/engineering/import-work-orders', '/engineering/parts', '/engineering/pool-log',
  '/engineering/preventive-maintenance', '/engineering/purchasing', '/engineering/room-operations',
  '/engineering/room-ranker', '/management/equipment', '/management/rooms', '/management/users',
  '/setup-guide', '/technician', '/work-orders', '/work-orders/test-id',
];
const apiPaths = [
  '/api/session', '/api/assets', '/api/assets/documentation', '/api/corporate-pm',
  '/api/engineering/catalog', '/api/engineering/operations', '/api/enseo/assignments',
  '/api/integrations/email/scan', '/api/integrations/room-ranker/sync', '/api/maintenance-ai',
  '/api/maintenance-reference', '/api/pool-log', '/api/room-operations', '/api/room-ranker',
  '/api/rooms', '/api/users', '/api/work-orders', '/api/work-orders/test-id',
  '/api/work-orders/test-id/activity', '/api/work-orders/drafts', '/api/work-orders/import',
];
const mutationCases = [
  ['/api/engineering/operations', 'PATCH'], ['/api/pool-log', 'POST'], ['/api/assets', 'POST'],
  ['/api/assets', 'PATCH'], ['/api/users', 'POST'], ['/api/users', 'PATCH'],
  ['/api/maintenance-ai', 'POST'], ['/api/work-orders', 'POST'], ['/api/room-ranker', 'PATCH'],
  ['/api/corporate-pm', 'PATCH'], ['/api/work-orders/test-id', 'PATCH'], ['/api/room-operations', 'POST'],
  ['/api/work-orders/drafts', 'POST'], ['/api/work-orders/import', 'POST'],
];
const cases = [
  ...uiPaths.map(path => ({ path, method: 'GET', expected: [200] })),
  ...apiPaths.map(path => ({ path, method: 'GET', expected: path === '/api/session' ? anonymousDenied : apiReachable })),
  ...mutationCases.map(([path, method]) => ({ path, method, expected: anonymousDenied })),
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
