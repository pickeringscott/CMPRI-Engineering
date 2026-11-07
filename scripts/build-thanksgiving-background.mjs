import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'src/components/desktop/thanksgiving');
const publicRoot = resolve(root, 'public/backgrounds/thanksgiving-animated');
const prefix = '/backgrounds/thanksgiving-animated/';
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const write = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(bytes))) writeFileSync(path, bytes);
};
const files = [];
function publish(name, bytes, extension) {
  const path = name + '.' + hash(bytes) + '.' + extension;
  write(resolve(publicRoot, path), bytes);
  files.push(prefix + path);
  return prefix + path;
}
const artwork = JSON.parse(readFileSync(resolve(source, 'artwork.json'), 'utf8'));
const images = Object.fromEntries(Object.entries(artwork).map(([key, path]) => [key,
  publish('assets/' + (['orange', 'pale'].includes(key) ? 'pumpkin-' + key : key), readFileSync(resolve(publicRoot, path)), 'png'),
]));
const css = publish('scene', readFileSync(resolve(source, 'scene.css')), 'css');
const leaves = publish('leaves', readFileSync(resolve(source, 'leaves.js')), 'js');
const scene = publish('scene', readFileSync(resolve(source, 'scene.js')), 'js');
const layouts = readFileSync(resolve(root, 'src/lib/ui/thanksgiving-layouts.json'), 'utf8').replace(/</g, '\\u003c');
const turkey = readFileSync(resolve(source, 'turkey.svg'), 'utf8').replace('__TURKEY_IMAGE__', images.turkey);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CMPRI Thanksgiving</title><link rel="stylesheet" href="${css}"></head><body><main class="scene" id="scene" aria-label="CMPRI Thanksgiving theme"><div class="ground" aria-hidden="true"></div><div class="leaves" id="leavesA" aria-hidden="true"></div><div class="leaves" id="leavesB" aria-hidden="true"></div><div class="decor" id="turkey" aria-label="Animated Thanksgiving turkey">${turkey}</div><div class="decor" id="orange"><img src="${images.orange}" alt="Orange pumpkin: 2,492.5 lbs, STATE RECORD, Plainfield, ILL"></div><div class="decor" id="pale"><img src="${images.pale}" alt="Pale pumpkin: 2,497.5 lbs, not state record, Anamosa, Iowa, Pumpkin Fest 2026"></div><div class="decor" id="greeting"><img src="${images.greeting}" alt="Happy Thanksgiving"></div><div class="watermark" aria-hidden="true">CMPRI ENGINEERING</div><button class="control" id="toggle" type="button" aria-label="Pause animation" aria-pressed="false">Ⅱ</button></main><script id="theme-layouts" type="application/json">${layouts}</script><script src="${leaves}" defer></script><script src="${scene}" defer></script></body></html>`;
const entry = publish('index', html, 'html');
// Keep the original entry URL useful for already-open app bundles.
write(resolve(publicRoot, 'index.html'), html);
const version = hash(JSON.stringify(files));
write(resolve(root, 'src/lib/ui/thanksgiving-assets.json'), JSON.stringify({ version, entry, files }, null, 2) + '\n');
const worker = readFileSync(resolve(source, 'cache-worker.template.js'), 'utf8')
  .replace('__VERSION__', version).replace('__FILES__', JSON.stringify(files));
write(resolve(publicRoot, 'cache-worker.js'), worker);
console.log(`Thanksgiving ${version}: ${files.length} immutable files`);
