// Fehlersuche Simulation: Wer steht wie lange an der Haltelinie und warum? Auch mit Kreisverkehr statt Kreuzung.
// Aufruf: node scripts/sim-diag.mjs [szene] [kreisel]
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { scenes } from './scenes.mjs';
mkdirSync('scripts/.build', { recursive: true });
execSync('npx --yes esbuild src/render.ts src/network.ts src/sim.ts --bundle --format=esm --platform=node --outdir=scripts/.build --log-level=error', { stdio: 'inherit' });
const { RoadRenderer } = await import('./.build/render.js');
const { buildNetwork } = await import('./.build/network.js');
const { Simulation } = await import('./.build/sim.js');

const names = process.argv[2] ? [process.argv[2]] : ['all', 'style', 'stress', 'assets', 'skew', 'fixtures/mein-stadtteil.json'];
let failed = 0;
for (const name of names) {
  for (const ring of [false, true]) {
    const p = name.endsWith('.json') ? JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) : structuredClone(scenes[name]);
    p.junctions ??= {};
    let built = new RoadRenderer().build(p.roads, p.junctions);
    if (ring) {
      // Kreuzungen mit mindestens drei Armen zu Kreisverkehren – nur wo die Ringe nicht ineinander liegen
      const keys = [...built.junctions.keys()];
      const pos = (k) => k.split(',').map(Number);
      const dist = (a, b) => Math.hypot((pos(a)[0] - pos(b)[0]) * 73000, (pos(a)[1] - pos(b)[1]) * 111000);
      for (const [k, info] of built.junctions)
        if (info.arms.length >= 3 && keys.every((o) => o === k || dist(k, o) > 50)) p.junctions[k] = { ...(p.junctions[k] ?? {}), kind: 'roundabout' };
      built = new RoadRenderer().build(p.roads, p.junctions);
    }
    const sim = new Simulation(buildNetwork(p, built.junctions));
    const waitSince = new Map(); // Fahrzeug → Beginn Stillstand an der Linie
    const reasons = {};
    let longest = 0, longWhy = '', overlaps = 0;
    for (let i = 0; i < 9000; i++) {
      sim.step(0.1);
      if (i % 10) continue;
      for (const v of sim.vehicles) {
        const t = v.track;
        const atLine = t.lane && v.exit && v.v < 0.1 && v.exit.stop - v.s < 4;
        if (!atLine) { waitSince.delete(v); continue; }
        const why = sim.blockedBy(v, v.exit.conn, 0) ?? 'frei?';
        reasons[why] = (reasons[why] ?? 0) + 1;
        if (!waitSince.has(v)) waitSince.set(v, sim.time);
        const w = sim.time - waitSince.get(v);
        if (w > longest) [longest, longWhy] = [w, `${why} @${v.exit.conn.conn.node.key}`];
      }
      for (const v of sim.vehicles) {
        const list = v.track.vehicles, j = list.indexOf(v), n = list[j + 1];
        if (n && n.s - n.len < v.s - 0.5) overlaps++;
      }
    }
    const st = sim.stats();
    // Wartezeit über 2 Umläufe (120 s) an einer Linie = Hänger
    const ok = longest < 120 && overlaps === 0 && st.arrived > 20;
    if (!ok) failed++;
    console.log(`${name}${ring ? ' (Kreisel)' : ''}: ${st.arrived} angekommen, ⌀ ${st.meanTravel.toFixed(0)} s, längstes Warten ${longest.toFixed(0)} s (${longWhy}), Gründe ${JSON.stringify(reasons)}, Überlappungen ${overlaps} ${ok ? 'OK' : 'FEHLER'}`);
  }
}
process.exit(failed ? 1 : 0);
