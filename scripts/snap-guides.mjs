// Bedientest Richtungsfang beim Zeichnen: Verlängerung, rechtwinklig abzweigen, Schnitt mit einer
// Straße, 90° zum vorigen Stück, Länge in ganzen Metern, Alt schaltet ab.
// Aufruf: node scripts/snap-guides.mjs <ausgabeordner>   (Dev-Server auf Port 5180)
import { chromium } from 'playwright-core';
const out = process.argv[2] ?? '.';
const O = [9.1706, 48.7795];
const M = 111320, kx = Math.cos((O[1] * Math.PI) / 180);
const ll = (x, y) => [O[0] + x / (M * kx), O[1] + y / M];
const xy = ([lng, lat]) => [(lng - O[0]) * M * kx, (lat - O[1]) * M];
const strip = (id, type, width, dir = 1) => ({ id, type, width, dir, lineRight: 'auto' });
const profile = (k) => [strip(`${k}s1`, 'sidewalk', 2.5), strip(`${k}d1`, 'drive', 3.25, -1), strip(`${k}d2`, 'drive', 3.25), strip(`${k}s2`, 'sidewalk', 2.5)];
const project = {
  version: 1,
  name: 'Fang',
  basemap: 'none',
  view: { center: ll(0, 20), zoom: 18 },
  roads: [
    { id: 'A', name: 'Unten', points: [ll(-60, 0), ll(60, 0)], profile: profile('a'), smooth: true },
    { id: 'C', name: 'Oben', points: [ll(-60, 50), ll(60, 50)], profile: profile('c'), smooth: true },
  ],
};

const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = 0;
const check = (ok, what) => (ok ? console.log(`ok   ${what}`) : (failed++, console.log(`FEHLER ${what}`)));
await page.addInitScript((p) => { localStorage.clear(); indexedDB.deleteDatabase('streetlab'); localStorage.setItem('streetlab.project.v1', JSON.stringify(p)); }, project);
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.editor);
await page.waitForTimeout(800);

const px = (x, y) => page.evaluate((q) => { const s = window.__streetlab.map.project(q); const r = document.getElementById('map').getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, ll(x, y));
const move = async (x, y) => { const p = await px(x, y); await page.mouse.move(p.x, p.y, { steps: 4 }); await page.waitForTimeout(60); };
const click = async (x, y) => { const p = await px(x, y); await page.mouse.click(p.x, p.y); await page.waitForTimeout(80); };
/** Lage des Entwurfspunkts unter dem Cursor (m) und Beschriftung */
const hover = () => page.evaluate(() => {
  const e = window.__streetlab.editor;
  const l = document.querySelector('.snap-label');
  return { p: e.hover, label: l?.style.display === 'block' ? l.textContent : '' };
});
const draw = async () => { await page.keyboard.press('Escape'); await page.keyboard.press('d'); };
/** tatsächlich gesetzter letzter Punkt (m) — der Klick selbst rastet pixelgenau ein */
const anchor = async () => xy(await page.evaluate(() => window.__streetlab.editor.draft.at(-1)));
// bei Zoom 18 ist 1 px ≈ 0,2 m: Versätze von etwa 1 m liegen in der Fangzone

// 1. Verlängerung am Straßenende
await draw();
await click(60, 0);
let [ax, ay] = await anchor();
await move(97.6, 1.0);
let h = await hover();
let [x, y] = xy(h.p);
check(Math.abs(y - ay) < 0.05 && h.label.includes('Verlängerung'), `Verlängerung: y=${y.toFixed(2)} m, „${h.label}“`);
check(Math.abs(x - ax - Math.round(x - ax)) < 0.05, `Länge in ganzen Metern (${(x - ax).toFixed(2)} m)`);
await page.screenshot({ path: `${out}/fang-1-verlaengerung.png` });

// 2. rechtwinklig von der Straßenmitte abzweigen
await draw();
await click(-20, 0);
[ax, ay] = await anchor();
await move(-19.0, -30);
h = await hover();
[x, y] = xy(h.p);
check(Math.abs(x - ax) < 0.05 && h.label.includes('rechtwinklig'), `rechtwinklig: x=${x.toFixed(2)} m, „${h.label}“`);

// 3. Schnitt: rechtwinklig nach oben, rastet genau auf der oberen Straße ein und verbindet
await draw();
await click(10, 0);
[ax, ay] = await anchor();
await move(11.2, 49);
h = await hover();
[x, y] = xy(h.p);
check(Math.abs(x - ax) < 0.05 && Math.abs(y - 50) < 0.05 && h.label.includes('Anschluss'), `Schnitt mit Straße: (${x.toFixed(2)}, ${y.toFixed(2)}), „${h.label}“`);
await page.screenshot({ path: `${out}/fang-2-anschluss.png` });
const affected = await page.evaluate(() => window.__streetlab.map.getSource('affected')._data.features.length);
check(affected === 1, `Zielstraße ist blau umrandet (${affected})`);
await click(11.2, 49);
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const linked = await page.evaluate(() => {
  const roads = window.__streetlab.store.project.roads;
  const key = (p) => p[0].toFixed(8) + ',' + p[1].toFixed(8);
  const nu = roads[roads.length - 1];
  const C = roads.find((r) => r.id === 'C');
  const A = roads.find((r) => r.id === 'A');
  return { top: C.points.some((p) => key(p) === key(nu.points[nu.points.length - 1])), bottom: A.points.some((p) => key(p) === key(nu.points[0])) };
});
check(linked.top && linked.bottom, `neue Straße an beiden Enden verknüpft (${JSON.stringify(linked)})`);

// 4. 90° zum vorigen Stück (frei begonnen, abseits der Straßen)
await draw();
await click(-50, 25);
await click(-30, 25.4);
await move(-29.4, 37);
h = await hover();
const d = await page.evaluate(() => window.__streetlab.editor.draft.slice(-2));
const [a, b] = d.map(xy);
[x, y] = xy(h.p);
const dot = ((b[0] - a[0]) * (x - b[0]) + (b[1] - a[1]) * (y - b[1])) / (Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(x - b[0], y - b[1]));
check(Math.abs(dot) < 0.002 && h.label.includes('90°'), `90° zum vorigen Stück (cos=${dot.toFixed(4)}), „${h.label}“`);

// 5. Alt: kein Fang, keine Hilfslinie
const p5 = await px(-29.4, 37);
await page.keyboard.down('Alt');
await page.mouse.move(p5.x + 1, p5.y);
await page.waitForTimeout(80);
h = await hover();
const guides = await page.evaluate(() => window.__streetlab.map.getSource('draft')._data.features.filter((f) => f.properties?.guide).length);
check(!guides && !h.label.includes('·'), `Alt schaltet den Fang ab (${guides} Hilfslinien, „${h.label}“)`);
await page.keyboard.up('Alt');
await page.keyboard.press('Escape');
check((await page.evaluate(() => getComputedStyle(document.querySelector('.snap-label')).display)) === 'none', 'Esc blendet die Beschriftung aus');

// 6. Schalter G: Fang aus — Alt fängt dann ausnahmsweise
await draw();
await page.keyboard.press('g');
check(!(await page.evaluate(() => window.__streetlab.editor.snapping)), 'Taste G schaltet den Fang aus');
// knapp neben dem Straßenende: ohne Fang bleibt der Punkt, wo der Cursor ist …
await move(60.6, 0.5);
h = await hover();
let [hx, hy] = xy(h.p);
check(Math.hypot(hx - 60, hy) > 0.3, `ohne Fang kein Einrasten am Straßenende (${hx.toFixed(2)}, ${hy.toFixed(2)})`);
// … mit Alt rastet er genau dort ein
await page.keyboard.down('Alt');
const p6 = await px(60.6, 0.5);
await page.mouse.move(p6.x + 1, p6.y);
await page.waitForTimeout(80);
h = await hover();
await page.keyboard.up('Alt');
[hx, hy] = xy(h.p);
check(Math.hypot(hx - 60, hy) < 0.01, `Alt fängt bei ausgeschaltetem Fang (${hx.toFixed(2)}, ${hy.toFixed(2)})`);
await page.keyboard.press('Escape');
await page.keyboard.press('g');
check(await page.evaluate(() => window.__streetlab.editor.snapping && localStorage.getItem('streetlab.snapping') === '1'), 'wieder an und gespeichert');

check(!errors.length, `keine Fehler im Browser${errors.length ? ': ' + errors.join(' · ') : ''}`);
await browser.close();
process.exit(failed ? 1 : 0);
