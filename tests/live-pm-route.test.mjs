import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../src/', import.meta.url));

function fixture(config = {}) {
  const calls = [];
  const modulePath = path.join(root, 'app/api/preventive-maintenance/live/route.ts');
  const exports = {};
  const source = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    exports,
    Date,
    Error,
    URL,
    URLSearchParams,
    require(name) {
      if (name === 'next/server') {
        return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers }) } };
      }
      if (name === '@/lib/server/auth') return {
        requireUser: async () => Object.hasOwn(config, 'auth') ? config.auth : { principal: { id: 'engineer' } },
      };
      if (name === '@/lib/server/access') return { allows: () => config.canView !== false };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return { handler: exports.GET, calls };
}

test('Live PM route requires an authenticated dashboard user', async () => {
  const f = fixture({ auth: null });
  const response = await f.handler({ nextUrl: new URL('https://cmpri.invalid/api/preventive-maintenance/live?week=2026-01-05') });
  assert.equal(response.status, 401);
  assert.equal(f.calls.length, 0);
});

test('Live PM route rejects a non-Monday week without reading the workbook', async () => {
  const f = fixture();
  const response = await f.handler({ nextUrl: new URL('https://cmpri.invalid/api/preventive-maintenance/live?week=2026-01-06') });
  assert.equal(response.status, 400);
  assert.equal(f.calls.length, 0);
});

test('Live PM route is disabled without reading Google Sheets', async () => {
  const f = fixture();
  const response = await f.handler({ nextUrl: new URL('https://cmpri.invalid/api/preventive-maintenance/live?week=2026-01-05') });
  assert.equal(response.status, 503);
  assert.match(response.body.error, /Google Sheets sync is temporarily disabled/);
  assert.deepEqual(f.calls, []);
});
