// Isolated production-server smoke checks. No real account or production data.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { once } from 'node:events';
const port = 3110;
const cleanupSecret = 'cmpri-local-cleanup-test-secret';
const anonymousDenied = [401, 403];
const apiReachable = [401, 403, 405];
const uiPaths = [
  '/', '/engineering', '/engineering/enseo-assignments', '/engineering/gss',
  '/engineering/import-work-orders', '/engineering/parts', '/engineering/pool-log',
  '/engineering/preventive-maintenance', '/engineering/purchasing', '/engineering/room-operations',
  '/engineering/room-ranker', '/management/equipment', '/management/rooms', '/management/users',
  '/setup-guide', '/staff-notes', '/technician', '/work-orders', '/work-orders/test-id',
];
const retiredPaths = new Set(['/api/room-ranker', '/api/integrations/room-ranker/sync']);
const apiPaths = [
  '/api/session', '/api/profile/header-layout', '/api/staff-notes', '/api/staff-notes/names', '/api/staff-notes/uploads', '/api/room-operations/guest-reports', '/api/room-operations/guest-reports/extract', '/api/notifications/dispatch', '/api/assets', '/api/assets/documentation', '/api/corporate-pm',
  '/api/engineering/catalog', '/api/engineering/operations', '/api/enseo/assignments',
  '/api/integrations/email/scan', '/api/integrations/room-ranker/sync',
  '/api/maintenance-reference', '/api/pool-log', '/api/room-operations', '/api/room-operations/cleanup', '/api/room-ranker',
  '/api/rooms', '/api/users', '/api/work-orders', '/api/work-orders/references?target=number:123', '/api/work-orders/test-id',
  '/api/work-orders/test-id/activity', '/api/work-orders/drafts', '/api/work-orders/import',
];
const mutationCases = [
  ['/api/engineering/operations', 'PATCH'], ['/api/pool-log', 'POST'], ['/api/assets', 'POST'],
  ['/api/assets', 'PATCH'], ['/api/users', 'POST'], ['/api/users', 'PATCH'],
  ['/api/profile/header-layout', 'PUT'], ['/api/staff-notes', 'POST'], ['/api/staff-notes/names', 'POST'], ['/api/staff-notes/uploads', 'POST'], ['/api/staff-notes/uploads', 'PUT'], ['/api/room-operations/guest-reports', 'POST'], ['/api/room-operations/guest-reports/extract', 'POST'], ['/api/notifications/dispatch', 'POST'],
  ['/api/work-orders', 'POST'], ['/api/room-ranker', 'PATCH'],
  ['/api/corporate-pm', 'PATCH'], ['/api/work-orders/test-id', 'PATCH'], ['/api/room-operations', 'POST'],
  ['/api/work-orders/drafts', 'POST'], ['/api/work-orders/import', 'POST'],
];
const cases = [
  ...uiPaths.map(path => ({ path, method: 'GET', expected: [200] })),
  ...apiPaths.map(path => ({ path, method: 'GET', expected: retiredPaths.has(path) ? [410] : path === '/api/session' ? anonymousDenied : apiReachable })),
  ...mutationCases.map(([path, method]) => ({ path, method, expected: retiredPaths.has(path) ? [410] : anonymousDenied })),
];

const equipmentCases = [
  ['/api/assets', 'GET'], ['/api/assets/documentation', 'GET'],
  ['/api/maintenance-reference', 'GET'], ['/api/assets', 'POST'], ['/api/assets', 'PATCH'],
  ['/api/assets/documentation', 'POST'],
].map(([path, method]) => ({path, method, expected: anonymousDenied}));
const isEquipment = test => equipmentCases.some(item => item.path === test.path && item.method === test.method);
const configurationError = 'Equipment database configuration is unavailable.';
// This preload exists only in the spawned smoke process. The actual route/auth
// code runs unchanged. Only the read-only release marker RPC is stubbed; every
// other outbound fetch fails the test, including attempted auth/data/provider I/O.
const preload = `
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method || input.method || 'GET').toUpperCase();
    if (method === 'POST' && url.pathname === '/rest/v1/rpc/cmpri_consolidation_ready'
        && process.env.CMPRI_SMOKE_GATE !== 'missing') {
      console.log('CMPRI_SMOKE_RPC');
      return process.env.CMPRI_SMOKE_GATE === 'legacy'
        ? Response.json({code:'PGRST202',message:'Fixture: marker function absent'}, {status:404})
        : Response.json(true);
    }
    console.error('CMPRI_SMOKE_UNEXPECTED_FETCH');
    throw new Error('Unexpected outbound request in isolated HTTP smoke');
  };
`;
const preloadUrl = `data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`;
let checks = 0;
async function runPhase(mode) {
  const server = spawn(process.execPath, ['--import', preloadUrl, 'node_modules/next/dist/bin/next', 'start',
    '--hostname', '127.0.0.1', '--port', String(port)], {
    env: {...process.env, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'cmpri-local-test-placeholder',
      SUPABASE_SERVICE_ROLE_KEY: mode === 'missing' ? '' : 'cmpri-smoke-not-a-real-key',
      CRON_SECRET: cleanupSecret, CMPRI_SMOKE_GATE: mode},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let timedOut = false;
  const exited = once(server, 'exit');
  const deadline = setTimeout(() => { timedOut = true; server.kill(); }, 45000);
  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });
  try {
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.on('exit', () => reject(new Error(`Smoke server exited before ready (${mode}): ${output}`)));
      server.stdout.on('data', () => { if (output.includes('Ready')) resolve(); });
    });
    const phaseCases = mode === 'missing' ? [
      ...cases.map(test => isEquipment(test) ? {...test, expected:[503], error:configurationError} : test),
      ...equipmentCases.filter(test => !cases.some(item => item.path === test.path && item.method === test.method))
        .map(test => ({...test, expected:[503], error:configurationError})),
      {path:'/api/room-operations/cleanup', method:'GET', expected:[503],
        authorization:`Bearer ${cleanupSecret}`, error:'Room Operations cleanup is disabled until a retention policy is confirmed.'},
    ] : equipmentCases;
    for (const test of phaseCases) {
      const response = await fetch(`http://127.0.0.1:${port}${test.path}`, {
        method:test.method, signal:AbortSignal.timeout(10000),
        headers:{...(test.method !== 'GET' ? {'Content-Type':'application/json'} : {}),
          ...(test.authorization ? {Authorization:test.authorization} : {})},
        ...(test.method !== 'GET' ? {body:'{}'} : {}),
      });
      assert.ok(test.expected.includes(response.status), `${mode} ${test.method} ${test.path}: expected ${test.expected}, got ${response.status}`);
      if (test.error) assert.deepEqual(await response.json(), {error:test.error});
      checks++;
      console.log(JSON.stringify({phase:mode,path:test.path,method:test.method,expected:test.expected,actual:response.status,result:'PASS'}));
    }
  } finally {
    clearTimeout(deadline);
    server.kill();
    await exited;
  }
  assert.equal(timedOut, false, `${mode} server exceeded its deadline`);
  assert.ok(!output.includes('CMPRI_SMOKE_UNEXPECTED_FETCH'), `${mode}: unexpected outbound request`);
  assert.equal((output.match(/CMPRI_SMOKE_RPC/g) || []).length, mode === 'missing' ? 0 : equipmentCases.length,
    `${mode}: each equipment request must reach exactly one release-marker check before authentication`);
}
try {
  for (const mode of ['missing', 'current', 'legacy']) await runPhase(mode);
  console.log(`${checks}/${checks} HTTP checks passed. Configuration failures and anonymous denial checked separately; no real account or database used.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
