import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/supabase/config.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function load(env) {
  const exports = {};
  vm.runInNewContext(compiled, { exports, process: { env } });
  return exports;
}

test('Supabase client configuration uses deployment environment values', () => {
  const config = load({
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'local-test-key',
  });
  assert.equal(config.SUPABASE_URL, 'http://127.0.0.1:54321');
  assert.equal(config.SUPABASE_PUBLISHABLE_KEY, 'local-test-key');
});

test('Supabase client configuration fails clearly when deployment values are missing', () => {
  assert.throws(
    () => load({}),
    /NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be configured/,
  );
});
