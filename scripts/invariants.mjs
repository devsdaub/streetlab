// Allgemeiner Prüfstand: erzeugt viele zufällige Kreuzungen und prüft feste Regeln für
// Darstellung und Simulation — damit Fehler nicht erst in einzelnen Szenarien auffallen.
// Aufruf: node scripts/invariants.mjs [anzahl=40] [start-seed=1]
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('scripts/.build', { recursive: true });
execSync('npx --yes esbuild src/render.ts src/network.ts src/sim.ts src/model.ts --bundle --format=esm --platform=node --outdir=scripts/.build --log-level=error', { stdio: 'inherit' });
const { RoadRenderer } = await import('./.build/render.js');
const { buildNetwork } = await import('./.build/network.js');
const { Simulation } = await import('./.build/sim.js');
const { PRESETS } = await import('./.build/model.js');

const COUNT = +(process.argv[2] ?? 40), SEED0 = +(process.argv[3] ?? 1);
const O = [9.1706, 48.7795];
const kx = Math.cos((O[1] * Math.PI) / 180);
const ll = (x, y) => [O[0] + x / (111320 * kx), O[1] + y / 111320];
const key = (p) => p[0].toFixed(8) + ',' + p[1].toFixed(8);

function mulberry(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- Szenen-Generator
function scene(seed) {
  const rnd = mulberry(seed * 7919);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let n = 0;
  const strip = ([type, width, dir = 1]) => ({ id: `s${seed}_${n++}`, type, width: width ?? (type === 'parking' ? 2 : 2.5), dir, lineRight: 'auto' });
  const profile = () => {
    let p = pick(PRESETS).strips.map(strip);
    const r = rnd();
    // Varianten: Radweg hinter dem Gehweg (Hochbord), Grün zwischen Rad und Fahrbahn
    if (r < 0.2) {
      const i = p.findIndex((s) => s.type === 'sidewalk');
      if (i === 0) p = [strip(['bike', 2, 1]), ...p];
    } else if (r < 0.35) {
      const i = p.findIndex((s) => s.type === 'bike');
      if (i > 0) p.splice(i + 1, 0, strip(['green', 2]));
    }
    // Einbahn ohne Gegenrichtung ist für Kreuzungsarme schwierig: mindestens eine Fahrrichtung je Seite
    if (!p.some((s) => (s.type === 'drive' || s.type === 'bus') && s.dir === 1) || !p.some((s) => (s.type === 'drive' || s.type === 'bus') && s.dir === -1))
      p = [strip(['sidewalk', 2.5]), strip(['drive', 3.25, -1]), strip(['drive', 3.25, 1]), strip(['sidewalk', 2.5])];
    return p;
  };
  const roads = [];
  const junctions = {};
  const settings = () => ({
    kind: rnd() < 0.2 ? 'roundabout' : 'cross',
    radius: 6 + Math.floor(rnd() * 6),
    crossing: pick(['zebra', 'zebra', 'furt', 'none']),
    bikeCrossing: rnd() < 0.6,
    stopLines: true,
    control: pick(['none', 'stoplines', 'priority', 'signals', 'signals', 'allstop']),
    rbRadius: 13 + Math.floor(rnd() * 5),
    rbLane: 6.5,
  });
  // Arme um den Mittelpunkt: 3 oder 4, Mindestwinkel 40°
  const arms = 3 + (rnd() < 0.55 ? 1 : 0);
  let angles;
  for (let tries = 0; ; tries++) {
    angles = Array.from({ length: arms }, () => rnd() * 360).sort((a, b) => a - b);
    const gaps = angles.map((a, i) => ((angles[(i + 1) % arms] - a + 360) % 360) || 360);
    if (Math.min(...gaps) >= 40 || tries > 50) break;
  }
  const pol = (r, deg, c = [0, 0]) => [c[0] + r * Math.cos((deg * Math.PI) / 180), c[1] + r * Math.sin((deg * Math.PI) / 180)];
  junctions[key(ll(0, 0))] = settings();
  let neighbour = rnd() < 0.3;
  angles.forEach((deg, i) => {
    const len = 45 + rnd() * 50;
    const bend = rnd() < 0.3 ? (rnd() - 0.5) * 30 : 0;
    if (neighbour) {
      // zweiter Knoten am Ende eines kurzen Arms (versetzte bzw. dicht folgende Kreuzung)
      neighbour = false;
      const d = 20 + rnd() * 25;
      const c2 = pol(d, deg);
      roads.push({ id: `r${i}`, name: `r${i}`, points: [ll(0, 0), ll(...c2)], profile: profile(), smooth: true });
      junctions[key(ll(...c2))] = settings();
      for (const off of [-80 - rnd() * 30, 80 + rnd() * 30]) {
        const end = pol(50 + rnd() * 30, deg + off, c2);
        roads.push({ id: `r${i}n${off > 0 ? 'a' : 'b'}`, name: 'nachbar', points: [ll(...c2), ll(...end)], profile: profile(), smooth: true });
      }
      const far = pol(60, deg, c2);
      roads.push({ id: `r${i}w`, name: 'weiter', points: [ll(...c2), ll(...far)], profile: profile(), smooth: true });
      return;
    }
    if (rnd() < 0.35) {
      // kurzer Arm, dann Übergang auf einen anderen Querschnitt (wie Straße 1 → Straße 5)
      const d = 12 + rnd() * 14;
      const mid = pol(d, deg);
      roads.push({ id: `r${i}`, name: `r${i}`, points: [ll(0, 0), ll(...mid)], profile: profile(), smooth: true });
      roads.push({ id: `r${i}b`, name: `r${i}b`, points: [ll(...mid), ll(...pol(len, deg + bend))], profile: profile(), smooth: true });
      return;
    }
    const pts = bend ? [[0, 0], pol(len * 0.5, deg + bend * 0.3), pol(len, deg + bend)] : [[0, 0], pol(len, deg)];
    roads.push({ id: `r${i}`, name: `r${i}`, points: pts.map((q) => ll(...q)), profile: profile(), smooth: true });
  });
  return { version: 1, name: `Zufall ${seed}`, view: { center: ll(0, 0), zoom: 18.5 }, junctions, roads };
}

// ---------------------------------------------------------------- Geometrie-Helfer
const centroid = (f) => {
  const r = f.geometry.coordinates[0];
  let x = 0, y = 0;
  for (const p of r) (x += p[0]), (y += p[1]);
  return [x / r.length, y / r.length];
};
const bbox = (f) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of f.geometry.coordinates[0]) (a = Math.min(a, x)), (b = Math.min(b, y)), (c = Math.max(c, x)), (d = Math.max(d, y));
  return [a, b, c, d];
};
const inside = (pt, f, bb) => {
  if (pt[0] < bb[0] || pt[0] > bb[2] || pt[1] < bb[1] || pt[1] > bb[3]) return false;
  const r = f.geometry.coordinates[0];
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
/** echte Kreuzung zweier nicht benachbarter Kanten des Rings (in Metern; sichtbar erst ab 25 cm) */
function selfIntersects(ring) {
  const p = ring.map(([x, y]) => [(x - O[0]) * 111320 * kx, (y - O[1]) * 111320]);
  const n = p.length - 1;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [a, b, c, d] = [p[i], p[i + 1], p[j], p[j + 1]];
      const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
      const la = Math.hypot(b[0] - a[0], b[1] - a[1]), lc = Math.hypot(d[0] - c[0], d[1] - c[1]);
      if (la < 0.05 || lc < 0.05) continue;
      if (d1 * d2 < 0 && d3 * d4 < 0 && Math.min(Math.abs(d1), Math.abs(d2)) / lc > 0.25 && Math.min(Math.abs(d3), Math.abs(d4)) / la > 0.25) return true;
    }
  return false;
}
const surfaceType = (f) => f.properties.kind ?? f.properties.type;

// ---------------------------------------------------------------- Prüfungen
const WALK = new Set(['sidewalk', 'green', 'median', 'island']);
const DRIVE = new Set(['drive', 'bus', 'tram', 'bike', 'parking', 'asphalt']);

function checkRender(p) {
  const errs = [];
  const built = new RoadRenderer().build(p.roads, p.junctions);
  const surf = built.surfaces.features.map((f) => ({ f, bb: bbox(f), t: surfaceType(f), morph: !!f.properties.transition }));
  const under = (pt) => surf.filter((s) => inside(pt, s.f, s.bb));
  for (const m of built.markings.features) {
    const k = m.properties.kind;
    if (!k || k === 'crossing') continue;
    const c = centroid(m), u = under(c);
    const bad = u.find((s) => WALK.has(s.t));
    if (bad) errs.push(`${k} auf ${bad.t}`);
    if ((k === 'zebra' || k === 'stopline') && u.some((s) => s.morph)) errs.push(`${k} in Verziehung`);
    if (!u.length) errs.push(`${k} außerhalb jeder Fläche`);
  }
  // Kreuzungsflächen dürfen sich nicht selbst überschneiden (gefaltete Ecken, Keile)
  for (const f of built.surfaces.features) {
    if (!f.properties.node) continue;
    if (selfIntersects(f.geometry.coordinates[0])) errs.push(`Kreuzungsfläche (${surfaceType(f)}) überschneidet sich selbst`);
  }
  for (const d of built.decor.features) {
    if (d.properties.kind !== 'sign') continue;
    const bad = under(centroid(d)).find((s) => DRIVE.has(s.t));
    if (bad) errs.push(`Schild/Ampel auf ${bad.t}`);
  }
  return { errs, built };
}

function checkSim(p, built) {
  const errs = [];
  const net = buildNetwork(p, built.junctions);
  const sim = new Simulation(net);
  sim.flow = 500;
  // Sackgassen: Spur endet an einem Knoten ohne Weiterfahrt → Fahrzeug verschwindet mitten im Netz
  const nodeById = new Map([...net.nodes.values()].map((n) => [n.id, n]));
  for (const t of sim.tracks ?? sim['tracks'])
    if (t.lane && !t.lane.outs.length && nodeById.get(t.lane.edge.to)?.kind !== 'end' && t.lane.lane.cls === 'car' && (t.feeders?.length || nodeById.get(t.lane.edge.from)?.kind === 'end')) errs.push(`Kfz-Spur ohne Weiterfahrt (${t.id})`);
  const seen = new Set();
  const frontSince = new Map();
  const once = (k, msg) => !seen.has(k) && (seen.add(k), errs.push(msg));
  for (let i = 0; i < 6000; i++) {
    sim.step(0.1);
    if (i % 10) continue;
    const vs = sim.vehicles.filter((v) => v.kind !== 'bike');
    const body = vs.map((v) => {
      const f = sim.pointBehind(v, 0.3), m = sim.pointBehind(v, v.len / 2), b = sim.pointBehind(v, v.len - 0.3);
      const h = [f[0] - b[0], f[1] - b[1]], l = Math.hypot(...h) || 1;
      return { v, pts: [f, m, b], h: [h[0] / l, h[1] / l] };
    });
    for (let a = 0; a < body.length; a++)
      for (let b = a + 1; b < body.length; b++) {
        const A = body[a], B = body[b];
        if (A.h[0] * B.h[0] + A.h[1] * B.h[1] < 0.5) continue; // nur gleiche Fahrtrichtung (Auffahren)
        const dmin = Math.min(...A.pts.flatMap((x) => B.pts.map((y) => Math.hypot(x[0] - y[0], x[1] - y[1]))));
        if (dmin < 1.0) once(`c${A.v.id}-${B.v.id}`, `Zusammenstoß ${A.v.kind}/${B.v.kind} bei t=${sim.time.toFixed(0)} s (${A.v.track.id} / ${B.v.track.id})`);
      }
    for (const v of sim.vehicles) {
      const ex = v.track.lane ? v.exit : null;
      if (ex && v.v < 0.1 && v.cleared !== ex && v.s > ex.stop + 0.5 && ex.at - ex.stop > 1)
        once(`s${v.id}`, `hält hinter der Haltlinie (${v.track.id}, ${(v.s - ex.stop).toFixed(1)} m)`);
      // Wartezeit vorn an der Haltlinie bzw. am Kreuzungsrand (nicht im Stau dahinter)
      const atFront = ex && v.v < 0.1 && (ex.stop - v.s < 4 || (v.cleared === ex && ex.at - v.s < 4));
      if (!atFront) frontSince.delete(v);
      else {
        if (!frontSince.has(v)) frontSince.set(v, sim.time);
        if (sim.time - frontSince.get(v) > 150) once(`w${v.id}`, `wartet über 150 s an der Linie (${v.track.id}, ${sim.blockedBy(v, ex.conn, 0)})`);
      }
    }
  }
  if (sim.stats().arrived < 5) errs.push(`kaum Verkehr angekommen (${sim.stats().arrived})`);
  return errs;
}

let failed = 0;
const tally = new Map();
for (let seed = SEED0; seed < SEED0 + COUNT; seed++) {
  const p = scene(seed);
  let errs;
  try {
    const r = checkRender(p);
    errs = [...r.errs, ...checkSim(p, r.built)];
  } catch (e) {
    errs = [`Ausnahme: ${e.message}`];
  }
  const uniq = [...new Set(errs.map((e) => e.replace(/\(.*\)|t=\d+ s|\d+(\.\d+)? m/g, '').trim()))];
  for (const u of uniq) tally.set(u, (tally.get(u) ?? 0) + 1);
  if (errs.length) {
    failed++;
    writeFileSync(`scripts/.build/fail-${seed}.json`, JSON.stringify(p));
    console.log(`Szene ${seed}: ${errs.length} Verstöße — ${errs.slice(0, 4).join(' · ')}${errs.length > 4 ? ' …' : ''}`);
  }
}
console.log(`\n${COUNT - failed}/${COUNT} Szenen ohne Verstoß`);
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${v}× ${k}`);
process.exit(failed ? 1 : 0);
