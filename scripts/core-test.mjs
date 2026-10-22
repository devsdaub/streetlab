// Kern des Spurmodells (src/core/net.ts) ohne Browser prüfen: Umrechnung hin und zurück an echten
// Projekten, Operationen mit Invarianten. Aufruf: node scripts/core-test.mjs
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
mkdirSync('scripts/.build', { recursive: true });
execSync('npx --yes esbuild src/core/net.ts src/render.ts src/network.ts src/sim.ts src/model.ts --bundle --format=esm --platform=node --outdir=scripts/.build --log-level=error', { stdio: 'inherit' });
const N = await import('./.build/core/net.js');
const { checkRender } = await import('./checks.mjs');
const { PRESETS, presetProfile } = await import('./.build/model.js');

let failed = 0;
const check = (ok, what) => (ok ? console.log(`ok   ${what}`) : (failed++, console.log(`FEHLER ${what}`)));

// Gesamtfläche je Flächenart (m²) — Vergleich der Darstellung vor und nach der Umrechnung
const areas = (built) => {
  const out = {};
  for (const f of built.surfaces.features) {
    const r = f.geometry.coordinates[0];
    const [O] = r, kx = Math.cos((O[1] * Math.PI) / 180);
    let a = 0;
    for (let i = 1; i < r.length; i++) a += (r[i - 1][0] - O[0]) * kx * (r[i][1] - O[1]) - (r[i][0] - O[0]) * kx * (r[i - 1][1] - O[1]);
    const k = f.properties.kind ?? f.properties.type;
    out[k] = (out[k] ?? 0) + Math.abs(a / 2) * 111320 * 111320;
  }
  return out;
};

// ---- 1. Rundweg an echten Projekten ----
const projects = [
  ['Beispiel-Stadtteil', 'scripts/fixtures/mein-stadtteil.json'],
  ['Stadtteil 2', 'scripts/fixtures/mein-stadtteil-2.json'],
];
for (const extra of ['scripts/.build/user-project.json', 'scripts/.build/osm-project.json']) {
  try {
    readFileSync(extra);
    projects.push([extra.includes('user') ? 'Nutzerprojekt' : 'OSM-Import', extra]);
  } catch {
    /* nicht vorhanden */
  }
}
for (const [label, file] of projects) {
  const p = JSON.parse(readFileSync(file, 'utf8'));
  const net = N.fromProject(p);
  const errs = N.checkNet(net);
  check(!errs.length, `${label}: Netz gültig (${Object.keys(net.nodes).length} Knoten, ${Object.keys(net.corridors).length} Straßenzüge)${errs.length ? ' — ' + errs.slice(0, 3).join(' · ') : ''}`);
  const back = { ...p, ...N.toRoads(net) };
  const before = checkRender(p), after = checkRender(back);
  check(after.errs.length <= before.errs.length, `${label}: keine neuen Regelverstöße (${before.errs.length} → ${after.errs.length})`);
  const A = areas(before.built), B = areas(after.built);
  const worst = Object.keys({ ...A, ...B }).map((k) => [k, Math.abs((A[k] ?? 0) - (B[k] ?? 0)) / Math.max(1, A[k] ?? 0)]).sort((x, y) => y[1] - x[1])[0];
  check(!worst || worst[1] < 0.02, `${label}: gleiche Darstellung (größte Abweichung ${worst ? `${worst[0]} ${(worst[1] * 100).toFixed(1)} %` : '-'})`);
}

// ---- 2. Operationen ----
const O = [9.1706, 48.7795], M = 111320, kx = Math.cos((O[1] * Math.PI) / 180);
const ll = (x, y) => [O[0] + x / (M * kx), O[1] + y / M];
const xy = ([lng, lat]) => [(lng - O[0]) * M * kx, (lat - O[1]) * M];
const prof = presetProfile(0);
const ok = (net, what) => {
  const e = N.checkNet(net);
  check(!e.length, `${what}: Invarianten${e.length ? ' — ' + e.join(' · ') : ''}`);
};

let net = N.emptyNet();
const main = N.addCorridor(net, { pos: ll(-100, 0) }, [ll(0, 0)], { pos: ll(100, 0) }, prof, 'Hauptstraße');
ok(net, 'Straße anlegen');
check(Object.keys(net.nodes).length === 2, 'zwei Knoten an den Enden');

// Seitenstraße endet auf der Hauptstraße → diese wird ausdrücklich geteilt
const side = N.addCorridor(net, { pos: ll(30, 80) }, [], { corridor: main, at: 0.65 }, presetProfile(7), 'Seitenstraße');
ok(net, 'Einmündung');
const j = net.corridors[side].b;
check(N.corridorsAt(net, j).length === 3, 'Einmündung: drei Straßenzüge am neuen Knoten');
check(Math.abs(xy(net.nodes[j].pos)[0] - 30) < 0.01 && Math.abs(xy(net.nodes[j].pos)[1]) < 0.01, `Knoten genau auf der Hauptstraße (${xy(net.nodes[j].pos).map((v) => v.toFixed(2))})`);

// Knoten verschieben: alle angehängten Enden folgen, nichts sonst
const shapeBefore = JSON.stringify(net.corridors[main].shape);
N.moveNode(net, j, ll(32, 4));
const ends = N.corridorsAt(net, j).map((c) => N.corridorPoints(net, c)).flatMap((pts) => [pts[0], pts[pts.length - 1]]).filter((q) => Math.abs(xy(q)[0] - 32) < 0.01);
check(ends.length === 3, 'Knoten verschieben: alle drei Enden folgen');
check(JSON.stringify(net.corridors[main].shape) === shapeBefore, 'Knoten verschieben: Verlauf der Straße unverändert');
ok(net, 'Knoten verschieben');

// Seitenstraße löschen: Hauptstraße wird wieder ein Straßenzug, Knoten weg
N.removeCorridor(net, side);
ok(net, 'Seitenstraße löschen');
check(Object.keys(net.corridors).length === 1 && Object.keys(net.nodes).length === 2, `nach Löschen wieder eine Straße (${Object.keys(net.corridors).length} Straßenzüge, ${Object.keys(net.nodes).length} Knoten)`);

// Querschnitt in einem Bereich setzen: drei Ereignisse, Stützpunkte unverändert
const c = Object.values(net.corridors)[0];
const shapeN = c.shape.length;
N.setCross(net, c.id, 0.3, 0.6, presetProfile(9));
check(c.cross.length === 3 && c.cross[1].at === 0.3 && c.cross[2].at === 0.6 && c.shape.length === shapeN, `Abschnitt setzen: Ereignisse ${c.cross.map((e) => e.at).join(', ')}, Stützpunkte unverändert`);
N.setCross(net, c.id, 0.3, 0.6, c.cross[0].profile);
check(c.cross.length === 1, `gleichen Querschnitt zurücksetzen: Ereignisse verschwinden (${c.cross.length})`);
ok(net, 'Querschnitt setzen');

// Teilen und wieder zusammenfügen: gleiche Geometrie
N.setCross(net, c.id, 0.7, 1, presetProfile(3));
const pts0 = JSON.stringify(N.corridorPoints(net, c).map(xy).map((q) => q.map((v) => v.toFixed(3))));
const k = N.splitCorridor(net, c.id, 0.4);
ok(net, 'Teilen');
check(Object.keys(net.corridors).length === 2, 'Teilen: zwei Straßenzüge');
const healed = N.healNode(net, k);
const c2 = Object.values(net.corridors)[0];
const pts1 = JSON.stringify(N.corridorPoints(net, c2).map(xy).map((q) => q.map((v) => v.toFixed(3))).filter((q, i, a) => !(i > 0 && q.join() === a[i - 1].join())));
check(healed && Object.keys(net.corridors).length === 1, 'Zusammenfügen nach Teilen');
check(c2.cross.length === 2 && Math.abs(c2.cross[1].at - 0.7) < 0.001, `Querschnitt bleibt an seiner Lage (${c2.cross.map((e) => e.at.toFixed(3)).join(', ')})`);
check(pts1.includes(pts0.slice(1, 20)), 'Verlauf nach Teilen und Zusammenfügen gleich');
ok(net, 'Zusammenfügen');

// Ende an einen anderen Knoten hängen (Einrasten) und wieder lösen
net = N.emptyNet();
const r1 = N.addCorridor(net, { pos: ll(0, 0) }, [], { pos: ll(50, 0) }, prof, 'A');
const r2 = N.addCorridor(net, { pos: ll(52, 1) }, [], { pos: ll(100, 0) }, prof, 'B');
N.mergeNodes(net, net.corridors[r1].b, net.corridors[r2].a);
ok(net, 'Einrasten');
check(net.corridors[r1].b === net.corridors[r2].a && Object.keys(net.nodes).length === 3, 'Einrasten: gemeinsamer Knoten');
const freed = N.detachEnd(net, r2, 'a');
ok(net, 'Lösen');
check(freed !== net.corridors[r1].b && Object.keys(net.nodes).length === 4, 'Lösen: eigener Knoten');

// Straße verschieben zieht angehängte Enden mit, fremde Verläufe bleiben
net = N.emptyNet();
const s1 = N.addCorridor(net, { pos: ll(0, 0) }, [ll(20, 10)], { pos: ll(40, 0) }, prof, 'S1');
const s2 = N.addCorridor(net, { node: net.corridors[s1].b }, [ll(60, -10)], { pos: ll(80, 0) }, prof, 'S2');
const s2shape = JSON.stringify(net.corridors[s2].shape);
N.translateCorridor(net, s1, [5 / (M * kx), 0]);
check(Math.abs(xy(N.corridorPoints(net, net.corridors[s2])[0])[0] - 45) < 0.01 && JSON.stringify(net.corridors[s2].shape) === s2shape, 'Verschieben: Nachbar-Ende folgt, sein Verlauf bleibt');
ok(net, 'Verschieben');

// Ableitung: Straßen teilen am Knoten exakt dieselbe Koordinate
const { roads } = N.toRoads(net);
const e1 = roads.find((r) => r.id === s1).points.at(-1), e2 = roads.find((r) => r.id === s2).points[0];
check(e1[0] === e2[0] && e1[1] === e2[1], 'abgeleitete Straßen: gemeinsamer Punkt am Knoten');

// Neue Straße kreuzt zwei bestehende: beide werden geteilt, je ein gemeinsamer Knoten
net = N.emptyNet();
const h1 = N.addCorridor(net, { pos: ll(-50, 0) }, [], { pos: ll(50, 0) }, prof, 'H1');
const h2 = N.addCorridor(net, { pos: ll(-50, 40) }, [], { pos: ll(50, 40) }, prof, 'H2');
const v = N.addCorridor(net, { pos: ll(0, -30) }, [ll(0, 20)], { pos: ll(0, 70) }, prof, 'V');
const made = N.connectCrossings(net, v);
ok(net, 'Kreuzungen beim Zeichnen');
const degree = (id) => N.corridorsAt(net, id).length;
const crossings = Object.values(net.nodes).filter((n) => degree(n.id) === 4);
check(made === 2 && crossings.length === 2, `zwei Kreuzungen mit je vier Armen (${made} angelegt, ${crossings.length} gefunden)`);
check(crossings.every((n) => Math.abs(xy(n.pos)[0]) < 0.01) && crossings.map((n) => Math.round(xy(n.pos)[1])).sort((a, b) => a - b).join() === '0,40', `Kreuzungen an (0,0) und (0,40): ${crossings.map((n) => xy(n.pos).map((x) => x.toFixed(1))).join(' / ')}`);
check(Object.keys(net.corridors).length === 7, `sieben Straßenzüge (${Object.keys(net.corridors).length})`);
void h1, h2;

// Straßen aus dem alten Format übernehmen: gemeinsamer Endpunkt → vorhandener Knoten
net = N.emptyNet();
const base = N.addCorridor(net, { pos: ll(0, 0) }, [], { pos: ll(50, 0) }, prof, 'Bestand');
const endPos = net.nodes[net.corridors[base].b].pos;
const ids = N.absorbRoads(net, { roads: [{ id: 'x', name: 'Import', points: [endPos, ll(90, 20)], profile: prof, smooth: true }] });
ok(net, 'Übernahme');
check(ids.length === 1 && net.corridors[ids[0]].a === net.corridors[base].b, 'übernommene Straße hängt am vorhandenen Knoten');

console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
process.exit(failed ? 1 : 0);
