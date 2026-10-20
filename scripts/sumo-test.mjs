// Export nach SUMO für mehrere Szenen, Prüfung mit netconvert und kurzer SUMO-Lauf mit Zufallsfahrten.
import { execSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenes } from './scenes.mjs';
const venv = process.argv[2]; // Python-Umgebung mit eclipse-sumo
const sumoBin = join(venv, 'Lib/site-packages/sumo/bin');
const out = process.argv[3];
mkdirSync('scripts/.build', { recursive: true });
execSync('npx --yes esbuild src/render.ts src/network.ts src/sumo.ts --bundle --format=esm --platform=node --outdir=scripts/.build --log-level=error', { stdio: 'inherit' });
const { RoadRenderer } = await import('./.build/render.js');
const { buildNetwork } = await import('./.build/network.js');
const { sumoFiles } = await import('./.build/sumo.js');
let failed = 0;
for (const name of ['all', 'style', 'stress', 'assets', 'trans']) {
  const p = structuredClone(scenes[name]);
  const built = new RoadRenderer().build(p.roads, p.junctions ?? {});
  const net = buildNetwork(p, built.junctions);
  const f = sumoFiles(net, name);
  const dir = join(out, 'sumo', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.nod.xml`), f.nodes);
  writeFileSync(join(dir, `${name}.edg.xml`), f.edges);
  writeFileSync(join(dir, `${name}.con.xml`), f.connections);
  writeFileSync(join(dir, `${name}.netccfg`), f.config);
  const explicit = net.conns.filter((c) => c.explicit).length;
  try {
    const log = execFileSync(join(sumoBin, 'netconvert.exe'), ['-c', `${name}.netccfg`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const net2 = readFileSync(join(dir, `${name}.net.xml`), 'utf8');
    const edges = (net2.match(/<edge id="e/g) || []).length, conns = (net2.match(/<connection from="e/g) || []).length;
    const tls = (net2.match(/<tlLogic /g) || []).length;
    // Probefahrt: Zufallsfahrten 10 Minuten lang, alle müssen ankommen
    execFileSync(join(venv, 'Scripts/python.exe'), [join(venv, 'Lib/site-packages/sumo/tools/randomTrips.py'), '-n', `${name}.net.xml`, '-o', 'trips.xml', '-e', '600', '-p', '3', '--validate', '--fringe-factor', '10'], { cwd: dir, stdio: 'ignore' });
    const run = execFileSync(join(sumoBin, 'sumo.exe'), ['-n', `${name}.net.xml`, '-r', 'trips.xml', '--end', '1200', '--no-step-log', '--duration-log.statistics'], { cwd: dir, encoding: 'utf8' });
    const num = (k) => +(run.match(new RegExp(k + ': ([0-9.]+)')) || [0, 0])[1];
    const ok = num('Inserted') > 0 && num('Running') === 0 && !/Teleports: [1-9]/.test(run);
    if (!ok) failed++;
    console.log(`${name}: ${net.edges.length} Kanten, ${explicit} Spurverbindungen → netconvert OK (${conns} Verbindungen, ${tls} Ampeln) · SUMO: ${num('Inserted')} Fahrten, ⌀ ${num('Speed').toFixed(1)} m/s, Wartezeit ${num('WaitingTime').toFixed(1)} s ${ok ? 'OK' : 'FEHLER'}`);
  } catch (e) {
    failed++;
    console.log(`${name}: netconvert FEHLER\n${(e.stderr || e.message).toString().slice(0, 800)}`);
  }
}
process.exit(failed ? 1 : 0);
