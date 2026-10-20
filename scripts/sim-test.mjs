// Simulationskern in Node: mehrere Szenen 15 Minuten simulieren, Plausibilität prüfen.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { scenes } from './scenes.mjs';
mkdirSync('scripts/.build', { recursive: true });
execSync('npx --yes esbuild src/render.ts src/network.ts src/sim.ts --bundle --format=esm --platform=node --outdir=scripts/.build --log-level=error', { stdio: 'inherit' });
const { RoadRenderer } = await import('./.build/render.js');
const { buildNetwork } = await import('./.build/network.js');
const { Simulation } = await import('./.build/sim.js');
let failed = 0;
for (const name of ['all', 'style', 'stress', 'assets', 'trans']) {
  const p = structuredClone(scenes[name]);
  const built = new RoadRenderer().build(p.roads, p.junctions ?? {});
  const sim = new Simulation(buildNetwork(p, built.junctions));
  let maxVeh = 0, overlaps = 0, at10 = 0;
  const t0 = performance.now();
  for (let i = 0; i < 9000; i++) {
    sim.step(0.1);
    maxVeh = Math.max(maxVeh, sim.vehicles.length);
    if (i === 6000) at10 = sim.stats().arrived;
    if (i % 50 === 0) {
      // Überlappung auf derselben Spur = Auffahrunfall
      for (const v of sim.vehicles) {
        const list = v.track.vehicles, j = list.indexOf(v), n = list[j + 1];
        if (n && n.s - n.len < v.s - 0.5) overlaps++;
      }
    }
  }
  const st = sim.stats();
  // Stillstand: in den letzten 5 Minuten müssen weiter Fahrzeuge ankommen
  const flowing = st.arrived - at10;
  const ok = st.arrived > 20 && overlaps === 0 && maxVeh < 400 && flowing > 10;
  if (!ok) failed++;
  console.log(`${name}: ${st.arrived} angekommen, max. ${maxVeh} gleichzeitig, ⌀ Reisezeit ${st.meanTravel.toFixed(0)} s, Überlappungen ${overlaps}, letzte 5 min ${flowing} angekommen, ${(performance.now() - t0).toFixed(0)} ms für 15 min ${ok ? 'OK' : 'FEHLER'}`);
}
process.exit(failed ? 1 : 0);
