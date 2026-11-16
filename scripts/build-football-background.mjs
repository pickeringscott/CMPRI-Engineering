import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const { minify } = require('next/dist/compiled/terser');
const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'src/components/desktop/football');
const publicRoot = resolve(root, 'public/backgrounds/illinois-iowa');
const prefix = '/backgrounds/illinois-iowa/';
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(bytes))) writeFileSync(path, bytes);
}
function svgUri(name) {
  return 'data:image/svg+xml;base64,' + readFileSync(resolve(source, name)).toString('base64');
}

const artwork = await sharp(resolve(root, 'public/GiesOverheadView.jpg')).webp({ quality: 82, effort: 6 }).toBuffer();
// Keep the no-script explanation without duplicating the full embedded stadium.
const template = readFileSync(resolve(source, 'index.template.html'), 'utf8').replace(/(<noscript>[\s\S]*?)<img\b[^>]*>([\s\S]*?<\/noscript>)/g, '$1$2');
const rules = readFileSync(resolve(source, 'football-rules.js'), 'utf8').replace(/^export const FootballRules\b/m, 'const FootballRules');
let html = template
  .replaceAll('__FOOTBALL_RULES__', rules)
  .replaceAll('__STADIUM_IMAGE__', 'data:image/webp;base64,' + artwork.toString('base64'))
  .replaceAll('__ILLINOIS_LOGO__', svgUri('illinois-block-i-official.svg'))
  .replaceAll('__IOWA_LOGO__', svgUri('iowa-hawkeye-official.svg'))
  .replaceAll('__ASSET_DIGEST__', hash(artwork));
const script = html.match(/<script>([\s\S]*?)<\/script>/);
if (!script) throw new Error('Football template must contain its inline game script');
const result = await minify(script[1], { compress: { passes: 2 }, mangle: true, format: { comments: false } });
if (!result.code) throw new Error('Football game script did not minify');
html = html.replace(script[0], '<script>' + result.code + '</script>');
const version = hash(html);
const entry = `${prefix}index.${version}.html`;
const files = [entry];
write(resolve(publicRoot, `index.${version}.html`), html);
write(resolve(publicRoot, 'index.html'), html);
write(resolve(root, 'src/lib/ui/football-assets.json'), JSON.stringify({ version, entry, files }, null, 2) + '\n');
const worker = readFileSync(resolve(source, 'cache-worker.template.js'), 'utf8')
  .replace('__VERSION__', version).replace('__FILES__', JSON.stringify(files));
write(resolve(publicRoot, 'cache-worker.js'), worker);
// Use only for a first, unpublished PR. Published hashes remain available to
// already-open app bundles during later theme upgrades.
if (process.argv.includes('--prune-unpublished')) {
  for (const name of readdirSync(publicRoot)) {
    if (/^index\.[a-f0-9]{16}\.html$/.test(name) && name !== `index.${version}.html`) unlinkSync(resolve(publicRoot, name));
  }
}
console.log(`Illinois/Iowa ${version}: ${files.length} immutable artwork file (${Buffer.byteLength(html)} bytes)`);
