// Test: großes Projekt (> 5 MB) in IndexedDB speichern und nach Neuladen wiederfinden.
import { chromium } from 'playwright-core';
import { ll } from './scenes.mjs';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
let n = 0;
const S = (type, width, dir = 1) => ({ id: 's' + n++, type, width, dir, lineRight: 'auto' });
// 1600 Straßen mit vielen Stützpunkten → deutlich über 5 MB JSON
const roads = Array.from({ length: 2400 }, (_, i) => ({
  id: 'r' + i, name: 'Straße ' + i, smooth: true,
  points: Array.from({ length: 50 }, (_, j) => ll((i % 50) * 150 + j * 2.5, Math.floor(i / 50) * 120 + Math.sin(j) * 3)),
  profile: [S('sidewalk', 2.5), S('drive', 3, -1), S('drive', 3, 1), S('sidewalk', 2.5)],
}));
const project = { version: 1, name: 'Großprojekt', basemap: 'none', view: { center: ll(0, 0), zoom: 15 }, roads };
console.log('Projektgröße:', (JSON.stringify(project).length / 1e6).toFixed(1), 'MB');
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.editor);
// Projekt über die App laden (wie „Öffnen“) und speichern lassen
await page.evaluate((p) => window.__streetlab.store.replace(p), project);
const t0 = Date.now();
await page.waitForFunction(() => window.__streetlab.store.savedBytes > 5e6, null, { timeout: 60000 });
console.log('gespeichert:', (await page.evaluate(() => window.__streetlab.store.savedBytes) / 1e6).toFixed(1), 'MB in', Date.now() - t0, 'ms');
await page.reload();
await page.waitForFunction(() => window.__streetlab?.editor, null, { timeout: 60000 });
const count = await page.evaluate(() => window.__streetlab.store.project.roads.length);
await page.waitForTimeout(4000);
console.log('Aufbau des ganzen Netzes:', Math.round(await page.evaluate(() => window.__streetlab.lastBuildMs)), 'ms');
// Leistung beim Bearbeiten: einen Punkt verschieben → nur diese Straße wird neu berechnet
await page.evaluate(() => { const s = window.__streetlab.store; s.project.roads[5].points[3][1] += 0.00002; s.changed('geometry'); });
await page.waitForTimeout(1500);
console.log('Neuberechnung nach Änderung:', Math.round(await page.evaluate(() => window.__streetlab.lastBuildMs)), 'ms');
console.log('nach Neuladen:', count, 'Straßen', count === 2400 ? 'OK' : 'FEHLER');
await browser.close();
