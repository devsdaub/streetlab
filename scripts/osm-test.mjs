// OSM-Import an echten Daten prüfen: Ausschnitt umrechnen, dieselben Regeln wie im Prüfstand
// (invariants.mjs) auf Darstellung und Simulation anwenden, Projekt zum Ansehen ablegen.
// Aufruf: node scripts/osm-test.mjs [fixture=scripts/fixtures/osm-stuttgart.json] [west,süd,ost,nord]
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('scripts/.build', { recursive: true });
execSync('npx --yes esbuild src/osm.ts src/render.ts src/network.ts src/sim.ts --bundle --format=esm --platform=node --outdir=scripts/.build --log-level=error', { stdio: 'inherit' });
const { osmToRoads, profileFromTags } = await import('./.build/osm.js');
const { checkRender, checkSim, checkQuality } = await import('./checks.mjs');

// ---- Querschnitt aus Tags: feste Erwartungen ----
const types = (t) => profileFromTags(t).map((s) => s.type + (s.dir === -1 && s.type !== 'sidewalk' && s.type !== 'parking' ? '-' : '')).join(' ');
const cases = [
  [{ highway: 'residential' }, 'sidewalk drive- drive sidewalk'],
  [{ highway: 'residential', 'parking:both': 'lane', sidewalk: 'both' }, 'sidewalk parking drive- drive parking sidewalk'],
  [{ highway: 'secondary', lanes: '4', 'cycleway:both': 'lane' }, 'sidewalk bike- drive- drive- drive drive bike sidewalk'],
  [{ highway: 'primary', oneway: 'yes', lanes: '3', 'turn:lanes': 'left|through|through;right' }, 'drive drive drive sidewalk'],
  [{ highway: 'residential', oneway: '-1', 'parking:right': 'lane', 'parking:right:orientation': 'perpendicular' }, 'sidewalk drive- parking sidewalk'],
  [{ highway: 'tertiary', 'cycleway:right': 'track', sidewalk: 'right' }, 'drive- drive bike sidewalk'],
  [{ highway: 'pedestrian', width: '9' }, 'sidewalk'],
];
let bad = 0;
for (const [tags, want] of cases) {
  const got = types(tags);
  if (got !== want) (bad++, console.log(`Querschnitt ${JSON.stringify(tags)}:\n  erwartet ${want}\n  erhalten ${got}`));
}
const turns = profileFromTags({ highway: 'primary', oneway: 'yes', lanes: '3', 'turn:lanes': 'left|through|through;right' }).filter((s) => s.type === 'drive').map((s) => s.turn).join(',');
if (turns !== 'left,straight,right-straight') (bad++, console.log('Abbiegepfeile:', turns));
const park = profileFromTags({ highway: 'residential', oneway: '-1', 'parking:right': 'lane', 'parking:right:orientation': 'perpendicular' }).find((s) => s.type === 'parking');
if (park?.parkAngle !== 90 || park.width !== 5) (bad++, console.log('Senkrechtparken:', park));
console.log(`Querschnitte: ${cases.length + 2 - bad}/${cases.length + 2} ok`);

// ---- echter Ausschnitt ----
const file = process.argv[2] ?? 'scripts/fixtures/osm-stuttgart.json';
const bbox = (process.argv[3] ?? '9.1650,48.7760,9.1760,48.7830').split(',').map(Number);
const t0 = performance.now();
const res = osmToRoads(JSON.parse(readFileSync(file, 'utf8')), bbox);
console.log(`Import: ${res.roads.length} Straßen, ${Object.keys(res.junctions).length} Knoten, ${res.stats.signals} Ampelknoten, ${res.stats.roundabouts} Kreisverkehre, ${res.stats.trees} Bäume in ${(performance.now() - t0).toFixed(0)} ms`);
const withTrees = res.roads.filter((r) => r.profile.some((s) => s.planting === 'trees')).length;
const withPark = res.roads.filter((r) => r.profile.some((s) => s.type === 'parking')).length;
console.log(`  davon mit Baumreihe ${withTrees}, mit Parken ${withPark}`);

const project = { version: 1, name: 'OSM-Import', view: { center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], zoom: 17 }, roads: res.roads, junctions: res.junctions };
writeFileSync('scripts/.build/osm-project.json', JSON.stringify(project));
const r = checkRender(project);
const errs = [...r.errs, ...checkQuality(project, r.built, true), ...(process.env.NOSIM ? [] : checkSim(project, r.built, 3000))];
const tally = new Map();
for (const e of errs) {
  const k = e.replace(/\(.*\)|t=\d+ s|\d+(\.\d+)? m/g, '').trim();
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
console.log(`Regelverstöße: ${errs.length}`);
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${v}× ${k}`);
process.exit(bad ? 1 : 0);
