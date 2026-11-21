import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/previews/weather/ground-map.js', import.meta.url), 'utf8');
const ORIGIN = 20037508.342787;
const HOTEL = { lon: -88.251416, lat: 40.138080 };
const center = { x: HOTEL.lon * ORIGIN / 180, y: Math.log(Math.tan((90 + HOTEL.lat) * Math.PI / 360)) * ORIGIN / Math.PI };
const coordinate = (x, y) => [x * 180 / ORIGIN, Math.atan(Math.sinh(y * Math.PI / ORIGIN)) * 180 / Math.PI];

function referenceTarget(geo) {
  const window = { addEventListener() {} };
  const seam = '  window.cmpriGroundMap = {';
  const instrumented = source.replace(seam, `  window.referenceProjectionProbe = (geo) => {
    state.referenceEnabled = true;
    prepareReferences(geo);
    return referenceTarget;
  };
${seam}`);
  vm.runInNewContext(instrumented, { window, document: { hidden: false }, setTimeout: () => 1, clearTimeout() {} }, { filename: 'ground-map.js' });
  return JSON.parse(JSON.stringify(window.referenceProjectionProbe(geo)));
}

for (const [name, width, height] of [['fullscreen', 1920, 1080], ['ultrawide', 3840, 1080], ['portrait', 1080, 2560], ['fractional', 1371.4, 831.2]]) {
  test(`${name} road exports fit their bounded pixel aspect without moving or cropping geographic points`, () => {
    const geo = { center, width, height, resolution: 155 }, target = referenceTarget(geo), extent = target.extent;
    assert.ok(Number.isInteger(target.width) && Number.isInteger(target.height));
    assert.ok(target.width <= 1500 && target.height <= 1500);
    assert.ok(target.width > 0 && target.height > 0);
    const spanX = extent.xmax - extent.xmin, spanY = extent.ymax - extent.ymin;
    assert.ok(Math.abs(spanX / spanY - target.width / target.height) < 1e-10,
      'ArcGIS receives the same geographic aspect as the output image');
    assert.ok(Math.abs((extent.xmax + extent.xmin) / 2 - center.x) < 1e-8);
    assert.ok(Math.abs((extent.ymax + extent.ymin) / 2 - center.y) < 1e-8);
    assert.ok(spanX >= width * geo.resolution - 1e-8 && spanY >= height * geo.resolution - 1e-8,
      'outward fitting retains every visible corner');
    assert.ok(spanX - width * geo.resolution < 2 * spanX / target.width);
    assert.ok(spanY - height * geo.resolution < 2 * spanY / target.height);
    for (const [screenX, screenY] of [[0, 0], [width, height], [width / 2, height / 2], [width * .23, height * .71]]) {
      const worldX = center.x + (screenX - width / 2) * geo.resolution;
      const worldY = center.y - (screenY - height / 2) * geo.resolution;
      const imageX = (worldX - extent.xmin) / spanX * target.width;
      const imageY = (extent.ymax - worldY) / spanY * target.height;
      assert.ok(imageX >= -1e-8 && imageX <= target.width + 1e-8);
      assert.ok(imageY >= -1e-8 && imageY <= target.height + 1e-8);
      const drawnX = width / 2 + (extent.xmin - center.x) / geo.resolution + imageX / target.width * spanX / geo.resolution;
      const drawnY = height / 2 - (extent.ymax - center.y) / geo.resolution + imageY / target.height * spanY / geo.resolution;
      assert.ok(Math.abs(drawnX - screenX) < 1e-8 && Math.abs(drawnY - screenY) < 1e-8,
        'export pixels redraw at the same hotel, corner and interior coordinates');
    }
  });
}

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

function render(data, width, height, resolution = 155) {
  const images = [], strokes = [];
  class LocalSign {
    set src(value) {
      assert.ok(['/previews/weather/signs/interstate-route.svg', '/previews/weather/signs/illinois-route.svg'].includes(value));
      this.source = value; this.onload();
    }
  }
  const context = new Proxy({
    drawImage(image, x, y, w, h) { images.push({ source: image.source, x, y, width: w, height: h }); },
    stroke() { strokes.push({ width: this.lineWidth, color: this.strokeStyle }); },
  },
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
    drawStateRouteLines(context, geo);
    drawRouteShields(context, geo, occupied);
    return { rendered: routeFeatures.rendered, budget: routeFeatures.budget };
  };
${seam}`);
  vm.runInNewContext(instrumented, sandbox, { filename: 'ground-map.js' });
  const result = JSON.parse(JSON.stringify(window.routeMarkerProbe(data, { center, width, height, resolution }, context)));
  return { ...result, images, strokes };
}

for (const [name, width, height, size] of [['desktop', 800, 380, 24], ['mobile', 345, 340, 20]]) {
  test(`${name} keeps east I74 and adds west I74 while retaining I57 and an Illinois state marker`, () => {
    const result = render(features(), width, height);
    for (const [number, side] of [['57', 'north'], ['57', 'south'], ['74', 'east'], ['74', 'west']]) {
      assert.ok(result.rendered.some(marker => marker.type === 'interstate' && marker.number === number && marker.side === side), `${number} ${side} is visible`);
    }
    const west = result.rendered.find(marker => marker.number === '74' && marker.side === 'west');
    const east = result.rendered.find(marker => marker.number === '74' && marker.side === 'east');
    assert.ok(west.longitude < HOTEL.lon && east.longitude > HOTEL.lon);
    assert.ok(result.rendered.some(marker => marker.type === 'state' && marker.number === '10' && marker.jurisdiction === '17' && marker.illinois));
    assert.equal(result.rendered.length, 5, 'smaller painted signs retain all five original route placements');
    assert.equal(result.budget, 5, 'shrinking artwork does not change the route-density budget');
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

test('official state-route strokes stay thin and visible with bounded map-scale widths', () => {
  const wide = render(features(), 800, 380, 5000).strokes;
  const regional = render(features(), 800, 380).strokes;
  const close = render(features(), 800, 380, 1).strokes;
  for (const strokes of [wide, regional, close]) {
    assert.equal(strokes.length, 2, 'the real state-route geometry has one dark casing and one light center');
    assert.equal(strokes[0].color, '#1a2029');
    assert.equal(strokes[1].color, '#f4f0d8');
    assert.ok(strokes[0].width <= 1.45 + 1e-9, 'the outer road stroke never grows beyond a thin casing');
    assert.ok(strokes[1].width >= .55, 'wide views retain a visible light center');
    assert.ok(strokes[0].width > strokes[1].width);
  }
  assert.ok(wide[0].width < regional[0].width && regional[0].width < close[0].width,
    'closer map scales increase road width gradually within the fixed limits');
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
