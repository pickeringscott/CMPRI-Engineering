import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import nextConfig from '../next.config.ts';

const require = createRequire(import.meta.url);
const { unstable_getResponseFromNextConfig } = require('next/experimental/testing/server');
const originalTarget = process.env.VERCEL_ENV;
const originalNodeEnv = process.env.NODE_ENV;

test.after(() => {
  if (originalTarget === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalTarget;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

for (const target of ['preview', 'development', undefined]) {
  test(`${target ?? 'unset'} deployment keeps sign-in, guide, API and asset routes on their own host`, async () => {
    if (target === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = target;
    process.env.NODE_ENV = 'production';
    for (const path of ['/', '/work-orders?status=open', '/management/equipment', '/api/assets/documentation/reviewed-text', '/local-ocr/manual.pdf']) {
      const response = await unstable_getResponseFromNextConfig({
        url: `https://cmpri-engineering-git-repair-team.vercel.app${path}`,
        nextConfig,
      });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('location'), null, path);
    }
  });
}

test('production Vercel hosts keep the permanent canonical redirect and preserve path and query', async () => {
  process.env.VERCEL_ENV = 'production';
  for (const path of ['/', '/work-orders?status=open', '/management/equipment', '/api/session']) {
    const response = await unstable_getResponseFromNextConfig({
      url: `https://cmpri-engineering.vercel.app${path}`,
      nextConfig,
    });
    assert.equal(response.status, 308, path);
    assert.equal(response.headers.get('location'), `https://cmpri-engineering.com${path}`, path);
  }
});

test('production canonical/custom hosts and the existing cron exception are unchanged', async () => {
  process.env.VERCEL_ENV = 'production';
  for (const url of ['https://cmpri-engineering.com/work-orders', 'https://www.cmpri-engineering.com/work-orders', 'http://localhost:3000/work-orders']) {
    const response = await unstable_getResponseFromNextConfig({ url, nextConfig });
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('location'), null, url);
  }
  const response = await unstable_getResponseFromNextConfig({
    url: 'https://cmpri-engineering.vercel.app/api/assets/documentation/ocr/dispatch',
    nextConfig,
    headers: { 'x-vercel-cron-schedule': '* * * * *' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
});

test('preview static cache headers remain active without a canonical redirect', async () => {
  process.env.VERCEL_ENV = 'preview';
  const response = await unstable_getResponseFromNextConfig({
    url: 'https://cmpri-engineering-git-repair-team.vercel.app/sw.js',
    nextConfig,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('location'), null);
});
