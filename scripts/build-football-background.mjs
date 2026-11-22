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

// Keep the standalone stadium in its original team colors.
const palette = JSON.parse(readFileSync(resolve(source, 'palette.json'), 'utf8'));
const tint = rgb => 'rgb(' + rgb.split(',').map(n => Math.round(Number(n) * .18 + 255 * .82)).join(',') + ')';
const paletteTokens = { 'modal-base': palette.modalBase, maintenance: palette.maintenance, 'maintenance-text': tint(palette.maintenance), ...palette.semantic };
for (const [name, value] of Object.entries(palette.desktop)) paletteTokens['desktop-' + name] = value;
for (const accent of palette.accents) { paletteTokens[accent.name + '-rgb'] = accent.rgb; paletteTokens[accent.name + '-text'] = tint(accent.rgb); }
for (const [name, scheme] of Object.entries(palette.special)) { paletteTokens[name + '-rgb'] = scheme.rgb; paletteTokens[name + '-base'] = scheme.base; }
for (const [name, value] of Object.entries(palette.signOut)) paletteTokens['sign-out-' + name] = value;
const paletteCss = ':root{' + Object.entries(paletteTokens).map(([name, value]) => '--cmpri-palette-' + name + ':' + value + ';').join('') + '}';
// Resolve canvas annotations once at build time, never during animation frames.
const canvasUiPalette = { overlay: palette.desktop['tone-14'], illinois: 'rgb(' + palette.desktop['action-rgb'] + ')', iowa: palette.semantic.gold };

const artwork = await sharp(resolve(root, 'public/GiesOverheadView.jpg')).webp({ quality: 82, effort: 6 }).toBuffer();
// Keep the no-script explanation without duplicating the full embedded stadium.
const template = readFileSync(resolve(source, 'index.template.html'), 'utf8').replace(/(<noscript>[\s\S]*?)<img\b[^>]*>([\s\S]*?<\/noscript>)/g, '$1$2');
const rules = readFileSync(resolve(source, 'football-rules.js'), 'utf8').replace(/^export const FootballRules\b/m, 'const FootballRules');
let html = template
  .replaceAll('__UI_LANGUAGE_SCRIPT__', () => readFileSync(resolve(root, 'public/ui-language.js'), 'utf8'))
  .replaceAll('__SITE_PALETTE_CSS__', paletteCss)
  .replaceAll('__SITE_THEME_COLOR__', palette.desktop['tone-1'])
  .replaceAll('__CANVAS_UI_PALETTE__', JSON.stringify(canvasUiPalette))
  .replaceAll('__FOOTBALL_RULES__', rules)
  .replaceAll('__STADIUM_IMAGE__', 'data:image/webp;base64,' + artwork.toString('base64'))
  .replaceAll('__ILLINOIS_LOGO__', svgUri('illinois-block-i-official.svg'))
  .replaceAll('__IOWA_LOGO__', svgUri('iowa-hawkeye-official.svg'))
  .replaceAll('__ASSET_DIGEST__', hash(artwork));
const script = html.match(/<script>([\s\S]*?)<\/script>/);
if (!script) throw new Error('Football template must contain its inline game script');
const result = await minify(script[1], { compress: { passes: 2 }, mangle: true, format: { comments: false } });
if (!result.code) throw new Error('Football game script did not minify');
html = html.replace(script[0], () => '<script>' + result.code + '</script>');
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
