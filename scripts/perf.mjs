// Leistungstest: großes Raster mit 400 Kreuzungen — Aufbau, Ziehen eines Knotens, Ergebnis.
import { chromium } from 'playwright-core';
import { ll } from './scenes.mjs';
const out = process.argv[2];
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
let n = 0;
const S = (type, width, dir = 1, extra = {}) => ({ id: 's' + n++, type, width, dir, lineRight: 'auto', ...extra });
const prof = () => [S('sidewalk', 2.5), S('green', 2, 1, { planting: 'trees' }), S('parking', 2), S('drive', 3, -1), S('drive', 3, 1), S('parking', 2), S('sidewalk', 2.5)];
const N = 20, D = 110, roads = [];
for (let i = 0; i < N; i++) {
  roads.push({ id: 'h' + i, name: 'H' + i, smooth: true, profile: prof(), points: Array.from({ length: N }, (_, j) => ll(j * D, i * D)) });
  roads.push({ id: 'v' + i, name: 'V' + i, smooth: true, profile: prof(), points: Array.from({ length: N }, (_, j) => ll(i * D, j * D)) });
}
const project = { version: 1, name: 'Raster', basemap: 'none', traffic: true, view: { center: ll(5 * D, 5 * D), zoom: 18.2 }, roads };
await page.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), project);
let t = Date.now();
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.lastBuildMs !== undefined, null, { timeout: 120000 });
console.log('Aufbau:', Math.round(await page.evaluate(() => window.__streetlab.lastBuildMs)), 'ms (Seite bereit nach', Date.now() - t, 'ms)');
const px = (x, y) => page.evaluate(([q]) => { const s = window.__streetlab.map.project(q); const r = document.getElementById('map').getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, [ll(x, y)]);
await page.waitForTimeout(1500);
// Kreuzung (5,5) wählen und ziehen
let q = await px(5 * D, 5 * D); await page.mouse.click(q.x, q.y); await page.waitForTimeout(500);
const a = await px(5 * D, 5 * D), b = await px(5 * D + 15, 5 * D + 10);
await page.mouse.move(a.x, a.y); await page.mouse.down();
const times = [];
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
  await page.waitForTimeout(120);
  times.push(Math.round(await page.evaluate(() => window.__streetlab.lastBuildMs)));
}
await page.screenshot({ path: `${out}/perf-drag.png` });
await page.mouse.up();
await page.waitForTimeout(2500);
console.log('Ziehen, je Bild:', times.join(' '), 'ms');
console.log('nach Loslassen:', Math.round(await page.evaluate(() => window.__streetlab.lastBuildMs)), 'ms');
await page.screenshot({ path: `${out}/perf-after.png` });
await browser.close();
