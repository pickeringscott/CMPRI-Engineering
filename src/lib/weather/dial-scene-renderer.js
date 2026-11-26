// Decorative, pointer-free weather dial art on the shared 100-unit artboard.

const squirrelNest = { x: 26.7, y: 33.7 };

function createDialSquirrels() {
  const base = { x: 28, y: 77 };
  const top = [
    { x: 27, y: 70 }, { x: 26, y: 63 }, { x: 26.5, y: 56 },
    { x: 29, y: 49 }, { x: 26, y: 44 }, { x: 23, y: 40 },
  ];
  const coats = [
    { fur: '#954927', tail: '#6e361e', highlight: '#ee9f65', chest: '#f8d5a4' },
    { fur: '#a86232', tail: '#77441f', highlight: '#e4a66b', chest: '#ffe0b0' },
    { fur: '#b36742', tail: '#81432b', highlight: '#edac78', chest: '#f8d7b3' },
  ];
  const range = (low, high) => low + Math.random() * (high - low);
  const tracks = [];
  const pawPattern = [
    [0.42, -0.39, 0.35, 0.18], [0.52, 0.33, 0.33, 0.17],
    [-0.27, -0.25, 0.2, 0.13], [-0.4, 0.17, 0.2, 0.13],
  ];
  const animals = [
    { x: 26, y: 44, tree: true, heading: 0.9, facing: 1, stops: 2 },
    { x: 46, y: 81, tree: false, heading: 0, facing: 1, stops: 2 },
    { x: 70, y: 78, tree: false, heading: Math.PI, facing: -1, stops: 4 },
  ].map((animal, index) => ({
    ...animal,
    coat: coats[index],
    nest: { x: squirrelNest.x + (index - 1) * 6.1, y: squirrelNest.y + (index === 1 ? -.4 : .1), tree: true, insideNest: true },
    phase: range(0, 2 * Math.PI),
    wait: range(0.15, 0.48) + 0.15 * index,
    speed: range(10, 14),
    strides: 0,
    printAt: range(1.5, 2.7),
    waypoints: [],
  }));
  const treePoint = (point) => ({ ...point, tree: true });
  const approach = top.slice(0, -1).map(treePoint);
  const fork = treePoint({ x: 28.5, y: 42.6 });
  let climber = animals[0];
  let snow = 0;
  let mode;
  animals[0].waypoints = [top[3], top[2], top[1], top[0]].map(treePoint).concat(base);

  function nearestTreePoint(animal) {
    const distance = point => Math.hypot(point.x - animal.x, point.y - animal.y);
    return approach.reduce((closest, point, index) => distance(point) < distance(approach[closest]) ? index : closest, 0);
  }

  function setMode(next) {
    if (mode === next) return;
    const previous = mode;
    mode = next;
    if (!previous) {
      if (mode !== 'roam') {
        climber = null;
        animals.forEach(animal => Object.assign(animal, animal.nest, { waypoints: [] }));
      }
      return;
    }
    if (previous !== 'roam' && mode !== 'roam') return;
    climber = null;
    animals.forEach((animal, index) => {
      const onTree = animal.tree || Boolean(animal.destination?.tree);
      const branchIndex = onTree ? nearestTreePoint(animal) : 0;
      if (mode === 'roam') {
        const descent = onTree ? approach.slice(0, branchIndex + 1).reverse().concat(base) : [];
        animal.waypoints = animal.insideNest ? [fork, ...descent] : descent;
        animal.wait = animal.insideNest ? range(.12, .4) + index * .68 : 0;
        animal.stops = Math.floor(range(2, 5));
      } else {
        const ascent = onTree ? approach.slice(branchIndex) : [base, ...approach];
        animal.waypoints = [...ascent, fork, animal.nest];
        animal.wait = range(.08, .34) + index * .1;
      }
      animal.destination = null;
    });
  }

  function groundDestination(animal) {
    // Leave space between the edge of the dial and a squirrel's nose and tail.
    for (let attempt = 0; attempt < 14; attempt++) {
      const y = range(76.5, 86); // Keep the tail below the temperature pills.
      const width = Math.sqrt(39.5 ** 2 - (y - 49) ** 2);
      const x = range(51.6 - width + 1.6, 51.6 + width - 1.6);
      if (Math.hypot(x - animal.x, y - animal.y) < 11) continue;
      if (animals.some((other) => other !== animal && Math.hypot(x - other.x, y - other.y) < 8)) continue;
      // Keep crossings away from the front of the trunk unless this animal is climbing.
      if (x < 33 && y < 75) continue;
      return { x, y };
    }
    return { x: animal.x < 51.6 ? 69 : 36, y: 79 };
  }

  function nextDestination(animal) {
    if (animal.waypoints.length) return animal.waypoints.shift();
    if (climber === animal) {
      climber = null;
      animal.stops = Math.floor(range(2, 5));
    }
    if (animal.stops <= 0 && !climber) {
      climber = animal;
      const canopy = top.slice(0, Math.random() < 0.55 ? 6 : 5);
      const descent = canopy.slice(0, -1).reverse().map(treePoint);
      animal.waypoints = canopy.map(treePoint).concat(descent, base);
      animal.waypoints[canopy.length - 1].perch = true;
      return base;
    }
    animal.stops--;
    return groundDestination(animal);
  }

  function leaveTracks(animal, distance, angle) {
    animal.strides += distance;
    if (animal.strides < animal.printAt) return;
    animal.strides -= animal.printAt;
    animal.printAt = range(1.8, 2.9);
    if (snow <= 0.2) return;
    const lifetime = range(13, 21);
    tracks.push({ x: animal.x, y: animal.y, angle, life: lifetime, lifetime });
  }

  function step(delta, scene) {
    const dt = Math.max(0, Math.min(0.075, Number(delta) || 0));
    snow = scene.snowCover ? 1 : 0;
    const inclement = scene.rain || scene.snow || scene.thunder || scene.fog || scene.strongWind;
    setMode(!scene.isDay ? 'sleep' : inclement ? 'shelter' : 'roam');
    for (let index = tracks.length - 1; index >= 0; index--) {
      const track = tracks[index];
      track.life -= dt * (snow > 0.2 ? 1 : 6);
      if (track.life <= 0) tracks.splice(index, 1);
    }
    for (const animal of animals) {
      if (animal.insideNest && mode !== 'roam') {
        animal.phase += dt * 1.6;
        continue;
      }
      if (animal.wait > 0) {
        animal.wait = Math.max(0, animal.wait - dt);
        animal.phase += dt * 3;
        continue;
      }
      animal.insideNest = false;
      animal.destination ??= nextDestination(animal);
      const target = animal.destination;
      const dx = target.x - animal.x;
      const dy = target.y - animal.y;
      const distance = Math.hypot(dx, dy);
      const climbing = animal.tree || Boolean(target.tree);
      const travel = Math.min(distance, animal.speed * (climbing ? 0.81 : 1) * (mode === 'roam' ? 1 : 1.37) * dt);
      if (distance > 0.001) {
        animal.x += travel * dx / distance;
        animal.y += travel * dy / distance;
        animal.heading = Math.atan2(dy, dx);
        if (Math.abs(dx) > 0.15) animal.facing = Math.sign(dx);
        if (!climbing) leaveTracks(animal, travel, animal.heading);
      }
      animal.phase += dt * (climbing ? 17 : 21);
      if (travel >= distance - 0.001) {
        animal.x = target.x;
        animal.y = target.y;
        animal.tree = Boolean(target.tree);
        animal.insideNest = Boolean(target.insideNest);
        animal.destination = null;
        animal.wait = target.perch ? range(0.7, 1.4) : animal.waypoints.length ? 0 : range(0.22, 0.75);
      }
    }
  }

  function drawTracks(ctx) {
    const contrast = Math.max(0, Math.min(1, (snow - 0.1) / 0.38));
    if (!contrast || !tracks.length) return;
    ctx.save();
    for (const track of tracks) {
      ctx.save();
      ctx.translate(track.x, track.y);
      ctx.rotate(track.angle);
      ctx.globalAlpha *= contrast * (track.life / track.lifetime) * 0.7;
      ctx.strokeStyle = '#b8dceb';
      ctx.fillStyle = '#354c6a';
      ctx.lineWidth = 0.17;
      ctx.beginPath();
      for (const [x, y, width, height] of pawPattern) {
        ctx.moveTo(x + width, y);
        ctx.ellipse(x, y, width, height, 0, 0, 2 * Math.PI);
      }
      ctx.stroke();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function profile(ctx, coat, phase, active, sleeping = false) {
    const motion = active ? Math.sin(phase) : 0;
    const sway = Math.sin(phase * 0.55);
    ctx.lineWidth = 0.24;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#2e1b17';
    // A tall, backward-curled tail keeps the silhouette recognizable at the smallest dial size.
    ctx.fillStyle = coat.tail;
    ctx.beginPath();
    ctx.moveTo(-1.18, -1.1);
    ctx.bezierCurveTo(-2.66, -0.92, -3.98, -1.44, -4.28, -2.57 + 0.18 * sway);
    ctx.bezierCurveTo(-4.83, -4.25 + 0.18 * sway, -3.47, -5.14 + 0.28 * sway, -2.65, -4.52 + 0.28 * sway);
    ctx.bezierCurveTo(-2, -4.05, -2.15, -3.57, -2.67, -3.27);
    ctx.bezierCurveTo(-3.15, -3, -2.71, -2.2, -1.42, -2.03);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = coat.highlight;
    ctx.lineWidth = 0.29;
    ctx.beginPath();
    ctx.moveTo(-3.55, -4.29 + 0.21 * sway);
    ctx.bezierCurveTo(-4.36, -3.53, -3.83, -2.05, -2.47, -1.81);
    ctx.stroke();

    ctx.strokeStyle = '#43261b';
    ctx.lineWidth = 0.43;
    ctx.beginPath();
    ctx.moveTo(-0.99, -0.73);
    ctx.lineTo(-1.51 - motion * 0.23, -0.22);
    ctx.lineTo(-0.85 - motion * 0.72, 0.03);
    ctx.moveTo(0.98, -1.01);
    ctx.lineTo(1.44 + motion * 0.43, -0.53);
    ctx.lineTo(1.82 + motion * 0.62, -0.2);
    ctx.stroke();

    ctx.strokeStyle = '#2e1b17';
    ctx.lineWidth = 0.23;
    ctx.fillStyle = coat.fur;
    ctx.beginPath();
    ctx.ellipse(-0.33, -1.31, 1.77, 1.07, -0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = coat.chest;
    ctx.beginPath();
    ctx.ellipse(0.56, -1.04, 0.75, 0.47, -0.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = coat.fur;
    ctx.beginPath();
    ctx.moveTo(0.65, -1.91);
    ctx.quadraticCurveTo(0.78, -2.6, 1.69, -2.64);
    ctx.quadraticCurveTo(2.43, -2.63, 2.56, -2.18);
    ctx.lineTo(3.02, -1.91);
    ctx.quadraticCurveTo(2.95, -1.47, 2.37, -1.52);
    ctx.quadraticCurveTo(1.43, -1.14, 0.68, -1.62);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(1.32, -2.79, 0.38, 0.51, -0.37, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = coat.highlight;
    ctx.beginPath();
    ctx.ellipse(1.34, -2.84, 0.16, 0.31, -0.33, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = '#261412';
    ctx.beginPath();
    ctx.ellipse(2.91, -1.93, 0.17, 0.14, 0, 0, 2 * Math.PI);
    ctx.fill();
    if (sleeping) {
      ctx.strokeStyle = '#391f19';
      ctx.lineWidth = .24;
      ctx.beginPath();
      ctx.moveTo(1.86, -2.15);
      ctx.quadraticCurveTo(2.13, -1.94, 2.41, -2.15);
      ctx.stroke();
      return;
    }
    ctx.beginPath();
    ctx.ellipse(2.14, -2.16, 0.21, 0.23, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = '#fff0c8';
    ctx.beginPath();
    ctx.arc(2.2, -2.22, 0.078, 0, 2 * Math.PI);
    ctx.fill();
  }

  function draw(ctx) {
    const viewOrder = [...animals].sort((a, b) => a.y - b.y);
    for (const animal of viewOrder) {
      const climbing = animal.tree || Boolean(animal.destination?.tree);
      const active = animal.wait <= 0;
      const hop = active ? Math.max(0, Math.sin(animal.phase)) * (climbing ? 0.12 : 0.43) : 0;
      ctx.save();
      ctx.translate(animal.x, animal.y);
      if (animal.insideNest) {
        const sleeping = mode === 'sleep';
        const height = sleeping ? .54 + .025 * Math.sin(animal.phase) : .8;
        ctx.scale(.72, height);
        profile(ctx, animal.coat, animal.phase, false, sleeping);
        ctx.restore();
        continue;
      } else if (climbing) {
        ctx.rotate(animal.heading);
        if (animal.facing < 0) ctx.scale(1, -1);
      } else {
        ctx.fillStyle = snow > 0.2 ? '#384d68' : '#2a352a';
        ctx.globalAlpha *= 0.3;
        ctx.beginPath();
        ctx.ellipse(-0.45, 0.13, 2.75, 0.47, 0, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.translate(animal.x, animal.y);
        ctx.scale(animal.facing, 1);
      }
      ctx.translate(0, -hop);
      profile(ctx, animal.coat, animal.phase, active);
      ctx.restore();
    }
  }

  return { step, drawTracks, draw };
}

/**
 * @typedef {{ time: number, isDay: boolean, sunAltitude: number, season: string,
 *   leafCover: number, cloudCover: number | null, moonPhase: number | null,
 *   moonAltitude: number, rain: boolean, snow: boolean, thunder: boolean, fog: boolean,
 *   strongWind: boolean, snowCover: boolean, treeSnow: boolean }} DialScene
 */

/** @param {HTMLCanvasElement} canvas @param {() => DialScene} readScene */
export function mountDialScene(canvas, readScene) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { wake() {}, dispose() {} };

  const center = { x: 51.6, y: 49, radius: 42.7 };
  const fullTurn = 2 * Math.PI;
  const blend = (a, b, fraction) => {
    const amount = Math.max(0, Math.min(1, fraction));
    return a.map((channel, i) => Math.round(channel + (b[i] - channel) * amount));
  };
  const color = (rgb, opacity = 1) => `rgba(${rgb.join(',')},${opacity})`;
  const surface = () => document.createElement('canvas');
  const background = surface();
  const tree = surface();
  const nestFront = surface();
  let squirrels = createDialSquirrels();
  const timeFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  });

  let seed = 191771;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  const stars = Array.from({ length: 66 }, () => [random() * 100, random() * 61, random()]);
  const grass = Array.from({ length: 240 }, () => [random() * 100, 63 + random() * 36, random()]);
  const flakes = Array.from({ length: 68 }, () => [random() * 108, random() * 111, random()]);
  const clouds = [
    [13, 32, 13, 4.7], [42, 37, 14, 5.2], [76, 28, 16, 5.2], [65, 43, 15, 4.2],
    [88, 46, 14, 3.7], [17, 22, 18, 4.5], [58, 19, 16, 4.6], [81, 35, 19, 5.7],
  ];
  const foliage = [
    [16, 40, 8], [21, 29, 9], [24, 23, 7], [31, 25, 10], [38, 32, 9], [43, 36, 6],
    [30, 35, 9], [21, 38, 8], [35, 42, 9], [22, 47, 7], [12, 44, 5.5], [42, 43, 7],
    [27, 42, 9], [17, 34, 7], [34, 30, 8], [42, 29, 6],
  ];
  const leaves = foliage.flatMap(([x, y, radius]) => Array.from({ length: 15 }, () => {
    const angle = random() * fullTurn;
    const spread = Math.sqrt(random()) * radius;
    return [x + Math.cos(angle) * spread, y + Math.sin(angle) * spread * .68, 1.3 + random() * 2.4, random()];
  }));
  const windborneLeaves = Array.from({ length: 12 }, () => [random(), random(), random()]);
  const seasons = {
    spring: { ground: [86, 126, 48], ridge: [74, 116, 73], leaves: [[115, 158, 47], [166, 199, 75], [71, 113, 50]] },
    summer: { ground: [79, 121, 50], ridge: [55, 109, 67], leaves: [[61, 123, 59], [106, 160, 67], [44, 91, 51]] },
    autumn: { ground: [139, 121, 61], ridge: [131, 117, 66], leaves: [[192, 86, 37], [218, 143, 50], [150, 62, 34]] },
    winter: { ground: [124, 112, 81], ridge: [110, 112, 99], leaves: [[114, 101, 63], [154, 132, 80], [92, 78, 55]] },
  };

  let scene = readScene();
  let scale = 1;
  let sceneKey = '';
  let frame = 0;
  let previous = 0;
  let elapsed = 0;
  let inViewport = true;
  let pausedMode = null;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function ellipse(target, x, y, rx, ry, fill, angle = 0) {
    target.beginPath();
    target.ellipse(x, y, rx, ry, angle, 0, fullTurn);
    target.fillStyle = fill;
    target.fill();
  }

  function gradient(target, y0, y1, start, end) {
    const band = target.createLinearGradient(0, y0, 0, y1);
    band.addColorStop(0, color(start));
    band.addColorStop(1, color(end));
    return band;
  }

  function glow(target, x, y, radius, rgb, brightness) {
    const light = target.createRadialGradient(x, y, 0, x, y, radius);
    light.addColorStop(0, color(rgb, brightness));
    light.addColorStop(1, color(rgb, 0));
    ellipse(target, x, y, radius, radius, light);
  }

  function drawMoon(target, x, y, phase) {
    if (!Number.isFinite(phase)) return;
    const cycle = ((phase % 1) + 1) % 1;
    const radius = 5.1;
    const terminator = Math.cos(cycle * fullTurn);
    const side = cycle <= .5 ? 1 : -1;
    if (terminator > .99) return;
    const light = (1 - terminator) / 2;
    glow(target, x, y, 10.5, [185, 214, 248], .24 * light);
    ellipse(target, x, y, radius, radius, '#67779169');

    const lit = new Path2D();
    for (let i = 0; i <= 24; i++) {
      const angle = -Math.PI / 2 + i * Math.PI / 24;
      const px = x + side * radius * Math.cos(angle);
      const py = y + radius * Math.sin(angle);
      if (!i) lit.moveTo(px, py);
      else lit.lineTo(px, py);
    }
    for (let i = 24; i >= 0; i--) {
      const angle = -Math.PI / 2 + i * Math.PI / 24;
      lit.lineTo(x + side * radius * terminator * Math.cos(angle), y + radius * Math.sin(angle));
    }
    lit.closePath();
    target.fillStyle = gradient(target, y - radius, y + radius, [255, 251, 220], [196, 212, 235]);
    target.fill(lit);
    target.save();
    target.clip(lit);
    ellipse(target, x + 1.05, y - 1.5, 1.36, 1.04, '#7f8ca044', .4);
    ellipse(target, x - 2.04, y + .95, .98, 1.2, '#7f8ca052', -.5);
    ellipse(target, x + 2.17, y + 2.12, .8, .62, '#7f8ca04b');
    target.restore();
  }

  function drawSky(target, daylight, twilight, cloudiness) {
    const storm = scene.thunder ? .72 : cloudiness * .44;
    const zenith = blend(blend([12, 24, 56], [53, 135, 186], daylight), [65, 70, 89], storm);
    const horizon = blend(blend([46, 71, 107], [192, 225, 219], daylight), [128, 143, 157], storm);
    const warmHorizon = blend(horizon, [244, 154, 105], twilight * (1 - storm));
    const sky = target.createLinearGradient(0, 5, 0, 68);
    sky.addColorStop(0, color(zenith));
    sky.addColorStop(.66, color(horizon));
    sky.addColorStop(1, color(warmHorizon));
    target.fillStyle = sky;
    target.fillRect(0, 0, 100, 100);

    const darkness = 1 - daylight;
    for (const [x, y, strength] of stars) {
      const opacity = Math.min(1, darkness * 1.5) * (1 - cloudiness * .78) * (.2 + .66 * strength);
      if (opacity < .05) continue;
      const radius = .17 + strength * .42;
      ellipse(target, x, y, radius, radius, color([222, 237, 255], opacity));
    }

    const clockParts = timeFormat.formatToParts(new Date(scene.time));
    const hours = Number(clockParts.find(part => part.type === 'hour')?.value || '0');
    const minutes = Number(clockParts.find(part => part.type === 'minute')?.value || '0');
    const hour = hours + minutes / 60;
    const altitude = scene.sunAltitude ?? (scene.isDay ? 24 : -22);
    if (scene.isDay || altitude > -3) {
      const progress = Math.min(1, Math.max(0, (hour - 5) / 15));
      const x = 24 + 55 * progress;
      const y = 61 - Math.max(0, Math.min(40, altitude * .72));
      const sun = blend([255, 160, 85], [255, 243, 175], daylight);
      if (cloudiness < .87) {
        const opacity = 1 - cloudiness * .74;
        glow(target, x, y, 13, sun, .55 * opacity);
        ellipse(target, x, y, 4.1, 4.1, color(sun, opacity));
        ellipse(target, x - .45, y - .65, 2.9, 2.9, color([255, 254, 230], opacity * .59));
      }
    } else if ((scene.moonAltitude ?? -10) > -1) {
      const night = ((hour + 5) % 24) / 12;
      const height = 47 - Math.min(28, Math.max(0, scene.moonAltitude) * .54);
      drawMoon(target, 54 + Math.min(1, night) * 20, height, scene.moonPhase);
    }

    if (scene.fog) {
      const haze = target.createLinearGradient(0, 35, 0, 71);
      haze.addColorStop(0, color([201, 216, 220], 0));
      haze.addColorStop(.69, color([201, 216, 220], .5));
      haze.addColorStop(1, color([201, 216, 220], .14));
      target.fillStyle = haze;
      target.fillRect(0, 35, 100, 37);
    }
    const layers = Math.min(8, Math.ceil(cloudiness * 8));
    for (let i = 0; i < layers; i++) {
      const [x, y, rx, ry] = clouds[i];
      const mass = blend([86, 109, 145], [232, 241, 243], daylight * (1 - storm));
      const shadow = blend([55, 73, 109], [177, 195, 206], daylight * (1 - storm));
      const opacity = Math.min(.96, cloudiness * .95 + .18);
      const light = color(mass, opacity);
      ellipse(target, x, y + ry * .55, rx, ry * .72, color(shadow, opacity));
      ellipse(target, x - rx * .45, y, rx * .58, ry * .69, light);
      ellipse(target, x - rx * .12, y - ry * .3, rx * .50, ry, light);
      ellipse(target, x + rx * .34, y - ry * .05, rx * .51, ry * .81, light);
    }
  }

  const distantRidge = new Path2D('M0 61 Q16 54 31 60 T62 60 Q83 51 100 60 V100 H0Z');
  const nearRidge = new Path2D('M0 67 Q12 61 26 63 Q41 67 57 63 Q82 57 100 66 V100 H0Z');
  const meadow = new Path2D('M0 72 Q12 66 27 69 Q45 72 60 67 Q77 61 100 71 V100 H0Z');
  function drawGround(target, daylight, palette) {
    const snow = Boolean(scene.snowCover);
    const ground = snow ? [216, 230, 231] : palette.ground;
    const ridge = snow ? [172, 190, 202] : palette.ridge;
    const moonlight = blend([39, 58, 90], [112, 140, 166], snow ? .47 : .05);
    const shaded = blend(moonlight, ground, .27 + .73 * daylight);
    const nearby = blend(moonlight, ridge, .30 + .63 * daylight);
    target.fillStyle = color(nearby, .66);
    target.fill(distantRidge);
    target.fillStyle = color(nearby);
    target.fill(nearRidge);
    const foreground = blend(shaded, snow ? [130, 161, 181] : [34, 58, 40], .24 + daylight * .13);
    target.fillStyle = gradient(target, 63, 98, shaded, foreground);
    target.fill(meadow);

    target.save();
    target.clip(meadow);
    for (const [x, y, variation] of grass) {
      if (snow) {
        ellipse(target, x, y, .38 + variation * 1.1, .12 + variation * .28,
          color(blend(shaded, variation > .5 ? [255, 255, 255] : [92, 125, 149], .26), .27));
        continue;
      }
      const blade = blend(shaded, variation > .5 ? [188, 182, 94] : [29, 68, 39], variation * .48);
      const length = .35 + (y - 59) * variation * .11;
      target.lineWidth = .18 + variation * .18;
      target.strokeStyle = color(blade, .73);
      target.beginPath();
      target.moveTo(x, y);
      target.quadraticCurveTo(x + length * .12, y - length * .77, x + length * .3, y - length);
      target.stroke();
    }
    target.restore();
  }

  const trunk = new Path2D('M20 77 Q25 75 25 70 L24 61 Q23 58 22 56 L16 49 L18 48 L24 54 Q26 56 26 51 L26 47 L21 41 L17 38 L18 36 L24 40 L27 44 L31 36 L34 29 L35 30 L33 37 L30 44 Q30 48 30 51 L39 46 L44 42 L45 43 L40 48 L31 54 L29 60 Q29 65 30 71 Q31 76 35 78 Q30 79 27 77 Q24 79 20 77Z');
  const outerBranches = [
    'M27 49 Q27 38 24 33 L21 25 M24 34 L17 32 M32 40 L40 35 L42 30 M37 36 L37 31 M23 45 L17 42 L13 37 M18 43 L11 43 M39 47 L47 45 M16 49 L12 47',
    'M28 47 L32 42 L35 37 M28 44 L26 38 L27 32 M23 38 L24 30 M39 45 L43 38 M33 36 L33 31 M18 40 L16 34',
  ].map(path => new Path2D(path));
  const barkLight = new Path2D('M26 75 Q27 72 26 66 Q25 62 27 56 Q28 52 28 48 M28 73 Q27 68 29 63 M25 59 Q24 55 21 52');
  const branchSnow = new Path2D('M13 36 L17 40 L22 42 L24 46 M19 31 L24 33 L27 38 M27 43 L31 36 L34 30 M32 51 L39 45 L45 41 M39 44 L46 43');
  const nestBowl = new Path2D('M-11.3 -.4 Q-7.9 1.1 -3.4 .9 Q3 1.55 7.4 .72 L11.3 -.3 Q10.6 2.25 8.7 3.45 Q5.55 5.45 -.9 5.75 Q-8.8 5.6 -11.3 -.4Z');
  const nestWeave = new Path2D('M-10.2 .72 Q-3 3.2 10.2 .64 M-8.9 2.25 Q-3 4.8 8.7 2.34 M-6.6 3.95 Q-2 5 6.6 3.8 M-8.3 1.17 L-4.3 4.81 M-4.7 1.46 L.15 5.45 M-.6 1.51 L4 4.8 M3.9 1.53 L7.8 3.69');
  const nestTwigs = new Path2D('M-11.7 -.8 Q-7.5 -4.7 -2.3 -4.25 Q3.7 -5.42 11.5 -.72 M-10 -2.6 L-11.6 -3.8 M-5.4 -3.85 L-6.4 -5.05 M3.8 -3.95 L5.4 -5.24 M8.45 -2.7 L10.9 -3.55 M-12.3 -.9 L-9.2 .25 M8.5 .7 L12.35 -1.1');
  function drawNest(target, daylight, front) {
    const fiber = color(blend([116, 84, 62], [181, 124, 62], daylight));
    const shade = color(blend([52, 42, 49], [108, 65, 37], daylight));
    target.save();
    target.translate(squirrelNest.x, squirrelNest.y);
    target.lineCap = 'round';
    target.lineJoin = 'round';
    target.strokeStyle = fiber;
    if (front) {
      target.fillStyle = shade;
      target.fill(nestBowl);
      target.lineWidth = .56;
      target.stroke(nestBowl);
      target.lineWidth = .32;
      target.stroke(nestWeave);
      if (scene.treeSnow) {
        const powder = color(blend([151, 173, 193], [247, 250, 239], daylight));
        ellipse(target, -8.7, .42, 1.9, .38, powder, .17);
        ellipse(target, 8.65, .42, 1.6, .36, powder, -.21);
      }
    } else {
      ellipse(target, 0, -.3, 10.95, 4.18, shade);
      ellipse(target, 0, -.4, 9.7, 2.86, color(blend([32, 31, 46], [77, 48, 30], daylight)));
      target.lineWidth = .65;
      target.stroke(nestTwigs);
    }
    target.restore();
  }

  function drawTree(target, daylight, palette) {
    const leafCover = Math.max(0, Math.min(1, scene.leafCover || 0));
    const bark = blend([41, 41, 53], [110, 69, 44], daylight);
    const barkHighlight = color(blend(bark, [193, 137, 80], .29 + daylight * .18));
    const shadow = scene.snowCover ? color([41, 55, 74], .17) : color([27, 38, 20], .22);
    ellipse(target, 29, 77.8, 12, 1.6, shadow, .04);
    target.lineCap = 'round';
    target.lineJoin = 'round';
    target.strokeStyle = color(bark);
    outerBranches.forEach((path, index) => {
      target.lineWidth = index ? .5 : .86;
      target.stroke(path);
    });
    target.fillStyle = gradient(target, 37, 77, blend(bark, [143, 105, 71], .14), bark);
    target.fill(trunk);
    target.strokeStyle = barkHighlight;
    target.lineWidth = .58;
    target.stroke(barkLight);

    for (const [x, y, radius, choice] of leaves) {
      if (choice > leafCover) continue;
      const tone = palette.leaves[Math.floor(choice * 23) % 3];
      const shade = blend([31, 46, 55], tone, .25 + .75 * daylight);
      const size = radius * (.57 + leafCover * .43);
      ellipse(target, x, y, size, size * .72, color(shade, .90), choice * Math.PI);
    }

    if (scene.treeSnow) {
      const powder = color(blend([139, 169, 196], [249, 250, 235], daylight), .91);
      target.strokeStyle = powder;
      target.lineWidth = .92;
      target.stroke(branchSnow);
      if (leafCover > .3) {
        for (const [x, y, radius] of foliage) ellipse(target, x, y - radius * .4, radius * .46, radius * .16, powder, .13);
      }
    }
  }

  function updateCaches() {
    const width = Math.round(Math.max(144, Math.min(448, canvas.clientWidth * window.devicePixelRatio)));
    const phase = Number.isFinite(scene.moonPhase) ? Math.round(scene.moonPhase * 1000) : '-';
    const signature = [
      width, Math.floor(scene.time / 120000), scene.isDay, scene.season,
      Math.round((scene.sunAltitude || 0) * 2), Math.round((scene.cloudCover || 0) * 30),
      Math.round((scene.leafCover || 0) * 50), Boolean(scene.snowCover), Boolean(scene.treeSnow),
      scene.thunder, scene.fog, phase, Math.round(scene.moonAltitude ?? -90),
    ].join('/');
    if (signature === sceneKey) return;
    sceneKey = signature;
    if (canvas.width !== width || canvas.height !== width) canvas.width = canvas.height = width;
    scale = width / 100;
    const altitude = scene.sunAltitude ?? (scene.isDay ? 20 : -20);
    const daylight = Math.max(0, Math.min(1, (altitude + 7) / 22));
    const twilight = Math.max(0, 1 - Math.abs(altitude) / 13);
    const palette = seasons[scene.season] || seasons.winter;
    for (const layer of [background, tree, nestFront]) {
      layer.width = layer.height = width;
      layer.getContext('2d').setTransform(scale, 0, 0, scale, 0, 0);
    }
    const skyAndGround = background.getContext('2d');
    drawSky(skyAndGround, daylight, twilight, scene.cloudCover ?? .32);
    drawGround(skyAndGround, daylight, palette);
    const treeContext = tree.getContext('2d');
    drawTree(treeContext, daylight, palette);
    drawNest(treeContext, daylight, false);
    drawNest(nestFront.getContext('2d'), daylight, true);
  }

  let strikeAt = 5.4;
  const lightning = new Path2D('M72 31 L67.1 39.4 L71.4 38.1 L65 49 L67.9 40.8 L64.8 41.4 L69.2 31 Z M68.7 40 L74.1 38.6 L76.1 36.4 L74.7 39.3Z');
  function drawWeather(target, time) {
    if (scene.rain || scene.snow) {
      target.lineWidth = .33;
      target.lineCap = 'round';
      const dusk = !scene.isDay;
      for (let i = 0; i < flakes.length; i++) {
        const [offsetX, offsetY, depth] = flakes[i];
        const rain = scene.rain && (!scene.snow || i % 2 === 0);
        const fall = rain ? 40 + depth * 34 : 6 + depth * 8;
        const x = ((offsetX + time * (rain ? 9 : 3)) % 110 + 110) % 110 - 5;
        const y = (offsetY + time * fall) % 100;
        const opacity = (dusk ? .42 : .62) + depth * .20;
        if (!rain) {
          ellipse(target, x + Math.sin(time * 1.5 + depth * 8) * 2, y,
            .24 + depth * .57, .25 + depth * .47, color([245, 251, 255], opacity));
          continue;
        }
        target.strokeStyle = color([183, 225, 248], opacity);
        target.beginPath();
        target.moveTo(x, y);
        target.lineTo(x - 1.1 - depth * .6, y - 3.3 - depth * 3.1);
        target.stroke();
      }
    }

    if (scene.season === 'autumn' && scene.leafCover > .08 && scene.leafCover < .93) {
      for (const [start, drift, shade] of windborneLeaves) {
        const phase = (start + time * (.065 + drift * .045)) % 1;
        const x = 18 + start * 22 + phase * 20 + Math.sin(phase * 12) * 3;
        const y = 37 + phase * 42;
        ellipse(target, x, y, .54 + drift * .23, .32, color(blend([174, 78, 34], [238, 173, 64], shade), .77), phase * 8);
      }
    }

    if (!scene.thunder) {
      strikeAt = time + 4.7;
      return;
    }
    const strike = time - strikeAt;
    if (strike >= .28) {
      strikeAt = time + 5 + random() * 5;
    } else if (strike >= 0) {
      const strength = 1 - strike / .28;
      glow(target, 71, 34, 19, [182, 201, 250], .30 * strength);
      target.fillStyle = color([237, 241, 255], strength);
      target.fill(lightning);
    }
  }

  function visible() {
    return inViewport && !document.hidden && canvas.clientWidth > 0;
  }

  function draw(time) {
    frame = 0;
    if (!visible()) {
      previous = 0;
      return;
    }
    if (!reducedMotion.matches && previous && time - previous < 32) {
      frame = requestAnimationFrame(draw);
      return;
    }
    const dt = !reducedMotion.matches && previous ? Math.min(.075, (time - previous) / 1000) : 0;
    previous = time;
    elapsed += dt;
    const current = readScene();
    if (!scene.thunder && current.thunder) strikeAt = elapsed + .6;
    scene = current;
    if (reducedMotion.matches) {
      const mode = scene.isDay ? Boolean(scene.rain || scene.snow || scene.thunder || scene.fog || scene.strongWind) : 'night';
      if (mode !== pausedMode) squirrels = createDialSquirrels();
      pausedMode = mode;
    } else {
      pausedMode = null;
    }
    updateCaches();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, 100, 100);
    ctx.save();
    ctx.beginPath();
    ctx.arc(center.x, center.y, center.radius, 0, fullTurn);
    ctx.clip();
    ctx.drawImage(background, 0, 0, 100, 100);
    squirrels.step(dt, scene);
    squirrels.drawTracks(ctx);
    ctx.drawImage(tree, 0, 0, 100, 100);
    squirrels.draw(ctx);
    ctx.drawImage(nestFront, 0, 0, 100, 100);
    drawWeather(ctx, elapsed);
    ctx.restore();
    if (!reducedMotion.matches) frame = requestAnimationFrame(draw);
  }

  function wake() {
    if (visible() && !frame) {
      previous = 0;
      frame = requestAnimationFrame(draw);
    }
  }

  const size = new ResizeObserver(wake);
  size.observe(canvas);
  const view = new IntersectionObserver(([entry]) => {
    inViewport = entry.isIntersecting;
    wake();
  });
  view.observe(canvas);
  document.addEventListener('visibilitychange', wake);
  reducedMotion.addEventListener('change', wake);
  wake();
  return {
    wake,
    dispose() {
      cancelAnimationFrame(frame);
      size.disconnect();
      view.disconnect();
      document.removeEventListener('visibilitychange', wake);
      reducedMotion.removeEventListener('change', wake);
    },
  };
}
