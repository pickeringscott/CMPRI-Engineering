import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url), ts = require('typescript');
const root = fileURLToPath(new URL('../', import.meta.url)), sourceRoot = resolve(root, 'src/lib/i18n');
const cache = new Map();
function load(file) {
  const path = resolve(file);
  if (!path.startsWith(sourceRoot + '/')) throw Error('Language build imports only its own catalogues');
  if (cache.has(path)) return cache.get(path);
  const exports = {}; cache.set(path, exports);
  const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const execute = vm.runInNewContext('(function(exports,require){' + output + '\n})', {});
  execute(exports, name => { if (!name.startsWith('.')) throw Error('Unexpected language catalogue dependency'); return load(resolve(dirname(path), name + '.ts')); });
  return exports;
}
const common = load(resolve(sourceRoot, 'catalog.ts')).SPANISH_UI;
const weather = load(resolve(sourceRoot, 'weather.ts')).WEATHER_ES;
if (!common || !weather) throw Error('Language catalogues are missing');
const output = JSON.stringify({ common, weather }) + '\n', destination = resolve(root, 'public/ui-language.es.json');
if (!existsSync(destination) || readFileSync(destination, 'utf8') !== output) writeFileSync(destination, output);
console.log('Spanish UI: ' + Object.keys(common).length + ' common, ' + Object.keys(weather).length + ' weather phrases');
