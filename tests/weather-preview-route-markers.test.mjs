import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/previews/weather/ground-map.js', import.meta.url), 'utf8');
const ORIGIN = 20037508.342787;
const HOTEL = { lon: -88.251416, lat: 40.138080 };
const center = { x: HOTEL.lon * ORIGIN / 180, y: Math.log(Math.tan((90 + HOTEL.lat) * Math.PI / 360)) * ORIGIN / Math.PI };
const coordinate = (x, y) => [x * 180 / ORIGIN, Math.atan(Math.sinh(y * Math.PI / ORIGIN)) * 180 / Math.PI];

// Synthetic geographic features exercise placement; they are not live USGS data.
function features(westAvailable = true) {
  const line = (points, properties) => ({ type: 'Feature', properties: { stco_fipscode: '17019', ...properties },
    geometry: { type: 'LineString', coordinates: points.map(([x, y]) => coordinate(center.x + x, center.y + y)) } });
  return { type: 'FeatureCollection', features: [
    line(Array.from({ length: 17 }, (_, i) => [-4000, -32000 + i * 4000]), { interstate: '57', permanent_identifier: 'fixture-i57' }),
    line(Array.from({ length: westAvailable ? 17 : 6 }, (_, i) => [westAvailable ? -32000 + i * 4000 : 12000 + i * 4000, 4000]), { interstate: '74', permanent_identifier: 'fixture-i74' }),
    line(Array.from({ length: 9 }, (_, i) => [-16000 + i * 4000, -12000]), { state_route: '10', permanent_identifier: 'fixture-il10' }),
  ] };
}

function render(data, width, height) {
  const images = [];
  class LocalSign {
    set src(value) {
      assert.ok(['/previews/weather/signs/interstate-route.svg', '/previews/weather/signs/illinois-route.svg'].includes(value));
      this.source = value; this.onload();
    }
  }
  const context = new Proxy({ drawImage(image, x, y, w, h) { images.push({ source: image.source, x, y, width: w, height: h }); } },
    { get: (object, name) => object[name] || (() => {}) });
  const window = { addEventListener() {} };
  const sandbox = { window, document: { hidden: false }, Image: LocalSign, URLSearchParams, AbortController, Map, Set, setTimeout, clearTimeout };
  const seam = '  window.cmpriGroundMap = {';
  assert.equal(source.split(seam).length, 2);
  const instrumented = source.replace(seam, `  window.routeMarkerProbe = (data, geo, context) => {
    loadShieldImages();
    routeFeatures = { data, routes: officialRoutes(data), rendered: [], budget: 0 };
    const town = [geo.center.x - 18000, geo.center.y + 4000];
    placeLabels = { data: { features: [] }, key: 'synthetic-gnis-fixture', labels: [{ name: 'Mahomet', longitude: town[0] * 180 / ORIGIN,
      latitude: Math.atan(Math.sinh(town[1] * Math.PI / ORIGIN)) * 180 / Math.PI }] };
    const hotel = screenPoint([HOTEL.longitude, HOTEL.latitude], geo);
    const occupied = [{ x: hotel.x - 22, y: hotel.y - 22, width: 44, height: 44 },
      { x: geo.width - 55, y: 0, width: 55, height: 190 }, { x: 0, y: geo.height - 65, width: 240, height: 65 }];
    drawRouteShields(context, geo, occupied);
    return { rendered: routeFeatures.rendered, budget: routeFeatures.budget };
  };
${seam}`);
  vm.runInNewContext(instrumented, sandbox, { filename: 'ground-map.js' });
  const result = JSON.parse(JSON.stringify(window.routeMarkerProbe(data, { center, width, height, resolution: 155 }, context)));
  return { ...result, images };
}

for (const [name, width, height, size] of [['desktop', 800, 380, 30], ['mobile', 345, 340, 26]]) {
  test(`${name} keeps east I74 and adds west I74 while retaining I57 and an Illinois state marker`, () => {
    const result = render(features(), width, height);
    for (const [number, side] of [['57', 'north'], ['57', 'south'], ['74', 'east'], ['74', 'west']]) {
      assert.ok(result.rendered.some(marker => marker.type === 'interstate' && marker.number === number && marker.side === side), `${number} ${side} is visible`);
    }
    const west = result.rendered.find(marker => marker.number === '74' && marker.side === 'west');
    const east = result.rendered.find(marker => marker.number === '74' && marker.side === 'east');
    assert.ok(west.longitude < HOTEL.lon && east.longitude > HOTEL.lon);
    assert.ok(result.rendered.some(marker => marker.type === 'state' && marker.number === '10' && marker.jurisdiction === '17' && marker.illinois));
    assert.ok(result.rendered.length <= result.budget);
    assert.ok(result.images.every(image => image.width === size && image.height === size), 'official two-digit artwork uses the smaller responsive size');
    assert.ok(result.images.some(image => image.source.endsWith('/illinois-route.svg')));
  });
}

test('a west I74 marker is not invented when only eastern source geometry is available', () => {
  const result = render(features(false), 800, 380);
  assert.ok(result.rendered.some(marker => marker.number === '74' && marker.side === 'east'));
  assert.equal(result.rendered.some(marker => marker.number === '74' && marker.side === 'west'), false);
});

test('mobile I74 keeps an eastern shield on the visible source segment when its midpoint crowds map controls', () => {
  const width = 354, height = 318, resolution = 155;
  const records = [
    ['74', .80, .55], ['74', .22, .58], ['57', .43, .28], ['57', .43, .68], ['72', .22, .72],
  ].map(([number, x, y], index) => {
    const world = { x: center.x + (x - .5) * width * resolution, y: center.y + (y - .5) * height * resolution };
    return { type: 'Feature', properties: { interstate: number, stco_fipscode: '17019', permanent_identifier: 'narrow-fixture-' + index },
      geometry: { type: 'LineString', coordinates: [coordinate(world.x - 1000, world.y - 500), coordinate(world.x + 1000, world.y + 500)] } };
  });
  const result = render({ type: 'FeatureCollection', features: records }, width, height);
  const east = result.rendered.find(marker => marker.number === '74' && marker.side === 'east');
  const west = result.rendered.find(marker => marker.number === '74' && marker.side === 'west');
  assert.ok(east && west, 'both requested sides remain visible');
  const midpointX = .80 * width, midpointY = .45 * height;
  assert.ok(midpointX + 13 + 7 > width - 55 && midpointY < 190, 'the original26px midpoint conflicts with reserved controls');
  assert.ok(east.x + 13 + 7 <= width - 55, 'the alternative still clears the same control spacing');
  assert.ok(Math.hypot(east.x - midpointX, east.y - midpointY) > 1, 'a real alternative source position was selected');
  const deltaX = east.x - midpointX, deltaY = east.y - midpointY;
  assert.ok(Math.abs(deltaY + deltaX / 2) < .001, 'the shield stays on the supplied sloping road segment');
  assert.ok(Math.abs(deltaX) <= 1000 / resolution + .001 && Math.abs(deltaY) <= 500 / resolution + .001);
  assert.equal(east.jurisdiction, '17');
  assert.ok(result.rendered.some(marker => marker.number === '57' && marker.side === 'north'));
  assert.ok(result.rendered.some(marker => marker.number === '57' && marker.side === 'south'));
});
