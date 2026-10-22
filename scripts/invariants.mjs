// Allgemeiner Prüfstand: erzeugt viele zufällige Kreuzungen und prüft feste Regeln für
// Darstellung und Simulation — damit Fehler nicht erst in einzelnen Szenarien auffallen.
// Aufruf: node scripts/invariants.mjs [anzahl=40] [start-seed=1]
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('scripts/.build', { recursive: true });
execSync('npx --yes esbuild src/render.ts src/network.ts src/sim.ts src/model.ts src/topology.ts --bundle --format=esm --platform=node --outdir=scripts/.build --log-level=error', { stdio: 'inherit' });
const { PRESETS } = await import('./.build/model.js');
const { connectRoad } = await import('./.build/topology.js');
const { checkRender, checkSim } = await import('./checks.mjs');

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
  // sich kreuzende Straßen verknüpfen wie beim Zeichnen im Editor (sonst lägen sie übereinander)
  for (const r of roads) connectRoad(roads, r);
  return { version: 1, name: `Zufall ${seed}`, view: { center: ll(0, 0), zoom: 18.5 }, junctions, roads };
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
