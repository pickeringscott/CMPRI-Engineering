import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
const assets = JSON.parse(readFileSync('src/lib/ui/thanksgiving-assets.json', 'utf8'));
const layouts = JSON.parse(readFileSync('src/lib/ui/thanksgiving-layouts.json', 'utf8'));
const html = readFileSync('public' + assets.entry, 'utf8');
const scripts = assets.files.filter(path => path.endsWith('.js')).map(path => readFileSync('public' + path, 'utf8'));
function mount({ reduce = false, width = 1440, height = 900 } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; let next, clock = 1;
  Object.defineProperties(w, { innerWidth: { value: width, writable: true }, innerHeight: { value: height, writable: true } });
  const reduced = { matches: reduce, addEventListener(_, callback) { this.changed = callback; } };
  const mobile = { get matches() { return w.innerWidth < 768; }, addEventListener() {} };
  w.matchMedia = query => query.includes('reduced') ? reduced : mobile;
  w.requestAnimationFrame = fn => { next = fn; };
  const scene = w.document.querySelector('#scene');
  Object.defineProperties(scene, { clientWidth: { get: () => w.innerWidth }, clientHeight: { get: () => w.innerHeight } });
  scripts.forEach(script => w.eval(script));
  return { dom, scene, reduced, step(n) { for (let i = 0; i < n; i++) { clock += 100; next(clock); } } };
}
test('approved desktop and mobile coordinates, cropping and layer order are applied exactly', () => {
  for (const [mode, layout] of Object.entries(layouts)) {
    const a = mount({ width: layout.canvas.width, height: layout.canvas.height });
    for (const [id, expected] of Object.entries(layout.objects)) {
      const style = a.dom.window.document.getElementById(id).style;
      assert.deepEqual([style.left, style.top, style.width, style.height, +style.zIndex],
        [expected.x + 'px', expected.y + 'px', expected.width + 'px', expected.height + 'px', expected.layer + 10]);
    }
    assert.equal(a.scene.dataset.layout, mode);
    assert.equal(a.scene.dataset.leafCount, '96');
    assert.equal(a.scene.dataset.leafSize, mode === 'desktop' ? '41' : '32');
    assert.equal(a.scene.querySelectorAll('#leavesA .leaf').length, 48);
    assert.equal(a.scene.querySelectorAll('#leavesB .leaf').length, 48);
    assert.equal(new Set([...a.scene.querySelectorAll('.leaf')].map(e => e.dataset.species)).size, 9);
    a.dom.window.close();
  }
});
test('local animation cycles a bounded pool, pause freezes it, and reduced motion stops falling', () => {
  const a = mount(); a.step(1000);
  assert.equal(a.scene.querySelectorAll('.leaf').length, 96);
  const transforms = () => [...a.scene.querySelectorAll('.leaf')].map(e => e.style.transform);
  const before = transforms(); a.step(10); assert.notDeepEqual(transforms(), before);
  a.dom.window.document.getElementById('toggle').click();
  const paused = transforms(); a.step(200); assert.deepEqual(transforms(), paused);
  a.dom.window.document.getElementById('toggle').click(); a.step(10); assert.notDeepEqual(transforms(), paused);
  a.reduced.matches = true; a.reduced.changed();
  const still = transforms(); a.step(200); assert.deepEqual(transforms(), still);
  assert.equal(+a.scene.dataset.settled, 96);
  a.reduced.matches = false; a.reduced.changed(); a.step(20); assert.notDeepEqual(transforms(), still);
  a.dom.window.close();
});
test('viewport scaling preserves proportions and never depends on header or window state', () => {
  const a = mount({ width: 720, height: 900 });
  assert.equal(a.scene.dataset.layout, 'mobile');
  a.dom.window.innerWidth = 1440; a.dom.window.innerHeight = 900;
  a.dom.window.dispatchEvent(new a.dom.window.Event('resize'));
  assert.equal(a.dom.window.document.getElementById('turkey').style.left, '12px');
  a.dom.window.innerWidth = 1920; a.dom.window.innerHeight = 1080;
  a.dom.window.dispatchEvent(new a.dom.window.Event('resize'));
  assert.equal(a.scene.dataset.scale, '1.2');
  assert.equal(parseFloat(a.dom.window.document.getElementById('turkey').style.width), 459 * 1.2);
  a.dom.window.close();
});
test('assets use content hashes; artwork and animation have no database or recurring network operations', () => {
  for (const path of assets.files) {
    const hash = createHash('sha256').update(readFileSync('public' + path)).digest('hex').slice(0, 16);
    assert.ok(path.includes('.' + hash + '.'), path);
  }
  assert.doesNotMatch(scripts.join('\n'), /fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|supabase|setInterval|setTimeout/);
  assert.doesNotMatch(html, /pumpkin-gourd-layer|desktop-spaced-gourds|data:image/);
  const component = readFileSync('src/components/desktop/ThanksgivingBackground.tsx', 'utf8');
  assert.match(component, /ensureThanksgivingCache/); assert.match(component, /src=\{assets.entry\}/);
  assert.match(component, /sandbox="allow-scripts allow-same-origin"/);
  assert.doesNotMatch(component, /if \(!desktop\) return null/);
});
