import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

export function loadTs(path, dependencies = {}, globals = {}) {
  const url = path instanceof URL ? path : new URL('../../' + path, import.meta.url);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, ...globals, require(name) {
    if (name in dependencies) return dependencies[name];
    if (name === '@/lib/server/work-order-parts-status') return partsStatusDependency;
    if (name.startsWith('.')) return loadTs(new URL(name + '.ts', url), dependencies);
    throw new Error(`Unmocked import: ${name}`);
  }});
  return exports;
}

export function ticketReadDependency(name, allows) {
  if (name === '@/lib/work-order-read-policy') return loadTs('src/lib/work-order-read-policy.ts');
  if (name === '@/lib/server/work-order-reader') return loadTs('src/lib/server/work-order-reader.ts', allows ? { './access': { allows } } : {});
  return null;
}

// Existing route fixtures leave the parts feature disabled; its enabled path has dedicated tests.
export const partsStatusDependency = loadTs('src/lib/server/work-order-parts-status.ts', {
  '@/lib/constants': { HOTEL_ID: 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6' },
}, { process: { env: {} } });
