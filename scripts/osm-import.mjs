// Bedientest „Bestand übernehmen“: Werkzeug wählen, Bereich mit dem Lasso umfahren, übernehmen
// (mit Fortschrittsbalken), abbrechen, rückgängig.
// Overpass wird auf die gespeicherten Stuttgarter Daten umgeleitet (kein Netz nötig).
// Aufruf: node scripts/osm-import.mjs <ausgabeordner>   (Dev-Server auf Port 5180)
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const out = process.argv[2] ?? '.';
const fixture = readFileSync(new URL('fixtures/osm-stuttgart.json', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
let failed = 0;
const check = (ok, what) => (ok ? console.log(`ok   ${what}`) : (failed++, console.log(`FEHLER ${what}`)));
page.on('pageerror', (e) => errors.push(e.message));
let queries = 0;
/** Antwortzeit des umgeleiteten Servers (ms) — lang genug, um den Fortschritt zu sehen */
let delay = 1200;
await page.route(/overpass/, async (route) => {
  queries++;
  await new Promise((r) => setTimeout(r, delay));
  route.fulfill({ status: 200, contentType: 'application/json', body: fixture }).catch(() => {});
});
const p = { version: 1, name: 'Import-Test', roads: [], basemap: 'none', view: { center: [9.1705, 48.7795], zoom: 17 } };
await page.addInitScript((p) => { localStorage.clear(); indexedDB.deleteDatabase('streetlab'); localStorage.setItem('streetlab.project.v1', JSON.stringify(p)); }, p);
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.editor);
await page.waitForTimeout(800);

const px = (q) => page.evaluate((q) => { const s = window.__streetlab.map.project(q); const r = document.getElementById('map').getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, q);
const roads = () => page.evaluate(() => window.__streetlab.store.project.roads.length);
const mode = () => page.evaluate(() => window.__streetlab.editor.mode);
const center = await page.evaluate(() => window.__streetlab.map.getCenter().toArray());
const M = 111320, kx = Math.cos((center[1] * Math.PI) / 180);
/** Lasso: unregelmäßige Form (Ellipse mit Delle) mit dem Radius r Metern um die Mitte umfahren */
const lasso = async (r) => {
  const pts = [];
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * 2 * Math.PI;
    const rr = r * (1 - 0.35 * Math.max(0, Math.cos(a - 1)) ** 4); // Einbuchtung
    pts.push(await px([center[0] + (rr * 1.3 * Math.cos(a)) / (M * kx), center[1] + (rr * Math.sin(a)) / M]));
  }
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const q of pts.slice(1)) await page.mouse.move(q.x, q.y, { steps: 2 });
  await page.mouse.up();
};

await page.keyboard.press('b');
check((await mode()) === 'import', 'Taste B wählt das Werkzeug');

await lasso(4);
check(!(await page.$('[data-dialog="osm-import"]')), 'winziges Lasso öffnet keinen Dialog');

await lasso(140);
const after = await page.evaluate(() => window.__streetlab.map.getCenter().toArray());
check(Math.abs(after[0] - center[0]) < 1e-9 && Math.abs(after[1] - center[1]) < 1e-9, 'Umfahren verschiebt die Karte nicht');
check(!!(await page.$('[data-dialog="osm-import"]')), 'Dialog nach dem Umfahren');
const ring = await page.evaluate(() => window.__streetlab.map.getSource('import-box')._data.features[0].geometry);
check(ring.type === 'Polygon' && ring.coordinates[0].length > 12, `Lasso als Fläche mit ${ring.coordinates[0].length} Punkten`);
await page.screenshot({ path: `${out}/osm-import-1-lasso.png` });

// Abbrechen während des Ladens: nichts wird übernommen
delay = 2500;
await page.click('[data-action="osm-run"]');
await page.waitForTimeout(300);
check(!!(await page.$('[data-dialog="osm-progress"] .progress-fill.waiting')), 'Fortschrittsbalken wartet auf den Server');
await page.click('[data-action="osm-cancel"]');
await page.waitForTimeout(3000);
check((await mode()) === 'select' && (await roads()) === 0 && !(await page.$('[data-dialog="osm-done"]')), 'Abbrechen während des Ladens übernimmt nichts');

// richtig übernehmen
delay = 1200;
await page.keyboard.press('b');
await lasso(140);
await page.click('[data-action="osm-run"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/osm-import-2-fortschritt.png` });
await page.waitForSelector('[data-dialog="osm-done"]', { timeout: 30000 });
const n = await roads();
check(n > 15, `übernommen: ${n} Straßen (Abfragen: ${queries})`);
check((await mode()) === 'select', 'danach wieder Auswählen');
// alle Punkte innerhalb der umfahrenen Ellipse (Lasso in Pixel gerundet: 1 m Spielraum)
const pts = await page.evaluate(() => window.__streetlab.store.project.roads.flatMap((r) => r.points));
const outside = pts.filter(([x, y]) => Math.hypot(((x - center[0]) * M * kx) / 1.3, (y - center[1]) * M) > 141);
check(!outside.length, `alle Punkte liegen im Lasso${outside.length ? ` (${outside.length} außerhalb)` : ''}`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/osm-import-3-ergebnis.png` });

await page.keyboard.press('Control+z');
await page.waitForTimeout(500);
check((await roads()) === 0, 'Strg+Z nimmt den ganzen Import zurück');

// Esc bricht das Werkzeug ab und entfernt das Lasso
await page.keyboard.press('b');
await lasso(100);
await page.keyboard.press('Escape');
const left = await page.evaluate(() => window.__streetlab.map.getSource('import-box')._data?.features?.length ?? 0);
check((await mode()) === 'select' && !left && !(await page.$('[data-dialog="osm-import"]')), 'Esc beendet Werkzeug, Lasso und Dialog');

check(!errors.length, `keine Fehler im Browser${errors.length ? ': ' + errors.join(' · ') : ''}`);
await browser.close();
process.exit(failed ? 1 : 0);
