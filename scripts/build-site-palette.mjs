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
// Existing utility class names stay semantic while the shared theme owns their colors.
const neutralRamp = {
  50: 'var(--cmpri-palette-white)',
  100: 'var(--cmpri-palette-desktop-tone-10)',
  200: 'var(--cmpri-palette-desktop-tone-9)',
  300: 'var(--cmpri-palette-desktop-tone-8)',
  400: 'var(--cmpri-palette-desktop-tone-7)',
  500: 'var(--cmpri-palette-desktop-tone-6)',
  600: 'var(--cmpri-palette-desktop-tone-5)',
  700: 'var(--cmpri-palette-desktop-tone-4)',
  800: 'var(--cmpri-palette-desktop-tone-3)',
  900: 'var(--cmpri-palette-desktop-tone-2)',
  950: 'var(--cmpri-palette-desktop-tone-1)',
};
const actionRamp = brand => Object.fromEntries([
  ...[[50,6],[100,12],[200,28],[300,46],[400,72]].map(([step,percent]) =>
    [step, `color-mix(in srgb, ${brand} ${percent}%, var(--cmpri-palette-white))`]),
  [500,brand],
  ...[[600,85],[700,65],[800,42],[900,24],[950,13]].map(([step,percent]) =>
    [step, `color-mix(in srgb, ${brand} ${percent}%, var(--cmpri-palette-black))`]),
]);
const utilityColors = { white:'var(--cmpri-palette-white)', black:'var(--cmpri-palette-black)' };
const addRamps = (families, ramp) => {
  for (const family of families) for (const [step,value] of Object.entries(ramp)) utilityColors[family+'-'+step]=value;
};
addRamps(['slate','gray','zinc','neutral','stone'],neutralRamp);
addRamps(['red','orange','rose','pink','fuchsia'],actionRamp('rgb(var(--cmpri-palette-control-rgb))'));
addRamps(['amber','yellow','lime','green','emerald','teal','cyan','sky','blue','indigo','violet','purple'],actionRamp('var(--cmpri-palette-gold)'));
// :where(html) keeps specificity equal to modal-theme.css's attribute selector.
// Its later local slate/modal overrides continue winning inside modal documents.
const utilityBridge = ':where(html)[data-cmpri-site-theme="illinois-iowa"]{\n' +
  Object.entries(utilityColors).map(([name,value]) => '  --color-'+name+':'+value+';').join('\n') + '\n}\n';
write('src/app/site-palette.css', '/* Generated from src/lib/ui/site-palette.json. Illinois orange and Iowa gold are shared by every app surface. */\n:root{\n' + Object.entries(tokens).map(([name, value]) => '  --cmpri-palette-' + name + ':' + value + ';').join('\n') + '\n}\n'+utilityBridge);
write('src/lib/ui/site-palette-defaults.ts', '// Generated from site-palette.json; shared header/modal defaults and token names.\nexport const sitePalette = ' + JSON.stringify(palette, null, 2) + ' as const;\nexport const sitePaletteTokens = ' + JSON.stringify(tokens, null, 2) + ' as const;\nexport function paletteToken(name: string, fallback: string): string { return `var(--cmpri-palette-${name},${fallback})`; }\n');
console.log('Shared site palette: ' + Object.keys(tokens).length + ' tokens; shared Illinois/Iowa colors generated.');
