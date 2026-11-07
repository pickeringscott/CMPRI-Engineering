import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const palette = JSON.parse(readFileSync(root + 'src/lib/ui/site-palette.json', 'utf8'));
const tokens = { 'modal-base': palette.modalBase, maintenance: palette.maintenance, 'maintenance-text': 'rgb('+palette.maintenance.split(',').map(n=>Math.round(Number(n)*.18+255*.82)).join(',')+')', ...palette.semantic };
for (const [name,value] of Object.entries(palette.desktop)) tokens['desktop-'+name]=value;
for (const accent of palette.accents) {
  tokens[accent.name + '-rgb'] = accent.rgb;
  tokens[accent.name + '-text'] = 'rgb(' + accent.rgb.split(',').map(n => Math.round(Number(n) * .18 + 255 * .82)).join(',') + ')';
}
for (const [name, scheme] of Object.entries(palette.special)) { tokens[name + '-rgb'] = scheme.rgb; tokens[name + '-base'] = scheme.base; }
for (const [name, value] of Object.entries(palette.signOut)) tokens['sign-out-' + name] = value;
function write(path, value) { if (!existsSync(root + path) || readFileSync(root + path, 'utf8') !== value) writeFileSync(root + path, value); }
write('src/app/site-palette.css', '/* Generated from src/lib/ui/site-palette.json. Defaults preserve the approved appearance. */\n:root{\n' + Object.entries(tokens).map(([name, value]) => '  --cmpri-palette-' + name + ':' + value + ';').join('\n') + '\n}\n');
write('src/lib/ui/site-palette-defaults.ts', '// Generated from site-palette.json; shared header/modal defaults and token names.\nexport const sitePalette = ' + JSON.stringify(palette, null, 2) + ' as const;\nexport const sitePaletteTokens = ' + JSON.stringify(tokens, null, 2) + ' as const;\nexport function paletteToken(name: string, fallback: string): string { return `var(--cmpri-palette-${name},${fallback})`; }\n');
console.log('Shared site palette: ' + Object.keys(tokens).length + ' tokens; approved colors retained.');
