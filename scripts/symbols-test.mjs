// Prüft für alle Vorlagen: jedes Spursymbol (Pfeil, Rad, Schrift) bleibt innerhalb seiner Spur.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('scripts/.build', { recursive: true });
execSync('npx --yes esbuild src/render.ts src/model.ts --bundle --format=esm --platform=node --outdir=scripts/.build --log-level=error', { stdio: 'inherit' });
const { buildRoad } = await import('./.build/render.js');
const { PRESETS, presetProfile } = await import('./.build/model.js');
const M = 111320;
let bad = 0;
PRESETS.forEach((p, i) => {
  const profile = presetProfile(i).map((s) => (s.type === 'drive' ? { ...s, text: 'TAXI' } : s));
  const road = { id: 'r', name: '', smooth: false, profile, points: [[0, 0], [200 / M, 0]] };
  const f = buildRoad(road);
  // Spurgrenzen (y in Metern, links positiv)
  const total = profile.reduce((s, x) => s + x.width, 0);
  let left = total / 2;
  const lanes = profile.map((s) => { const l = left; left -= s.width; return { type: s.type, l, r: left }; });
  for (const ft of f.markings) {
    const ys = ft.geometry.coordinates[0].map(([, lat]) => lat * M);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    // Linien entlang von Grenzen sind schmal (< 0,3 m) — hier geht es um Symbole
    if (hi - lo < 0.3) continue;
    const mid = (lo + hi) / 2;
    const lane = lanes.find((l) => mid <= l.l && mid >= l.r);
    if (!lane) continue;
    if (hi > lane.l + 0.05 || lo < lane.r - 0.05) {
      bad++;
      console.log(`ZU GROSS: ${p.name} · ${lane.type} (${(lane.l - lane.r).toFixed(2)} m) · Symbol ${(hi - lo).toFixed(2)} m`);
    }
  }
});
console.log(bad ? `${bad} Symbole ragen aus ihrer Spur` : 'Alle Spursymbole passen in ihre Spur');
process.exit(bad ? 1 : 0);
