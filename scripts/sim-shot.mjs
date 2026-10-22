// Simulation auf einer Szene oder Projektdatei laufen lassen und Bilder machen:
// node scripts/sim-shot.mjs <szene|datei.json> <ausgabeordner> [sekunden] [bilder]
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { scenes } from './scenes.mjs';
const [scene, out, secs = '90', count = '3'] = process.argv.slice(2);
const project = scene.endsWith('.json') ? JSON.parse(readFileSync(scene, 'utf8')) : structuredClone(scenes[scene]);
// optional andere Ansicht: VIEW="lng,lat,zoom"
if (process.env.VIEW) { const [x, y, z] = process.env.VIEW.split(',').map(Number); project.view = { center: [x, y], zoom: z }; }
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), project);
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.sim);
await page.waitForTimeout(2500);
// mehr Lkw/Busse zum Prüfen: Verkehrsmenge hoch
await page.evaluate((s) => { const v = window.__streetlab.sim; v.setFlow(700); v.fastForward(+s); v.pause(); }, secs);
for (let i = 0; i < +count; i++) {
  await page.evaluate(() => window.__streetlab.sim.fastForward(4));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/simshot-${i}.png` });
  const kinds = await page.evaluate(() => window.__streetlab.sim.sim.vehicles.map((v) => v.kind).join(','));
  console.log(i, kinds);
}
await browser.close();
