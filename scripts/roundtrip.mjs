// Bedien-Test „hin und zurück“: jede Straße am Stück verschieben und wieder zurück, jeden Knoten
// wegziehen und zurück — danach muss das Projekt exakt wie vorher sein, ohne Fehler im Browser.
// Aufruf: node scripts/roundtrip.mjs <projekt.json|szene> <ausgabeordner>
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { scenes } from './scenes.mjs';
const [scene = 'fixtures/mein-stadtteil.json', out = '.'] = process.argv.slice(2);
const load = () => (scene.endsWith('.json') ? JSON.parse(readFileSync(new URL(scene, import.meta.url), 'utf8')) : structuredClone(scenes[scene]));
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true });
const errors = [];
let failed = 0;

const open = async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  const p = load();
  p.basemap = 'none';
  await page.addInitScript((p) => { localStorage.clear(); indexedDB.deleteDatabase('streetlab'); localStorage.setItem('streetlab.project.v1', JSON.stringify(p)); }, p);
  await page.goto('http://localhost:5180/');
  await page.waitForFunction(() => window.__streetlab?.editor);
  await page.waitForTimeout(1500);
  return page;
};
const px = (page, q) => page.evaluate(([q]) => { const s = window.__streetlab.map.project(q); const r = document.getElementById('map').getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, [q]);
const drag = async (page, a, b) => {
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(700);
};
const state = (page) => page.evaluate(() => JSON.stringify({ roads: window.__streetlab.store.project.roads.map((r) => [r.id, r.points, r.sections?.map((s) => s.index)]), j: Object.keys(window.__streetlab.store.project.junctions ?? {}).sort() }));
const features = (page) => page.evaluate(() => { const m = window.__streetlab.map; return ['surfaces', 'markings'].map((k) => m.querySourceFeatures ? m.getStyle().layers.length : 0); });
const diff = (a, b) => {
  const A = JSON.parse(a), B = JSON.parse(b);
  const out = [];
  if (A.j.join() !== B.j.join()) out.push(`Knoten-Einstellungen: ${A.j.length} → ${B.j.length}`);
  for (const [i, ra] of A.roads.entries()) {
    const rb = B.roads.find((r) => r[0] === ra[0]);
    if (!rb) { out.push(`Straße ${ra[0]} fehlt`); continue; }
    if (ra[1].length !== rb[1].length) { out.push(`${ra[0]}: ${ra[1].length} → ${rb[1].length} Punkte`); continue; }
    const d = Math.max(...ra[1].map((p, k) => Math.hypot((p[0] - rb[1][k][0]) * 73000, (p[1] - rb[1][k][1]) * 111000)));
    if (d > 0.05) out.push(`${ra[0]}: Punkte um bis zu ${d.toFixed(2)} m verschoben`);
    if (JSON.stringify(ra[2]) !== JSON.stringify(rb[2])) out.push(`${ra[0]}: Abschnitte ${JSON.stringify(ra[2])} → ${JSON.stringify(rb[2])}`);
  }
  if (A.roads.length !== B.roads.length) out.push(`Straßen: ${A.roads.length} → ${B.roads.length}`);
  return out;
};
const report = (what, d, page) => {
  if (d.length || errors.length) {
    failed++;
    console.log(`FEHLER ${what}: ${[...d, ...errors.splice(0)].join(' · ')}`);
    return page.screenshot({ path: `${out}/roundtrip-fehler-${failed}.png` });
  }
  console.log(`ok ${what}`);
};

const p0 = load();
// 1. jede Straße am Stück 12 m verschieben und zurück
// kleine und große Bewegungen, auch quer über andere Straßen (Pixel bei Zoom 19)
const MOVES = [[0, -60], [220, 0], [-160, 160]];
for (const road of p0.roads) for (const [mx, my] of MOVES) {
  const page = await open();
  const before = await state(page);
  // Mitte eines mittleren Abschnitts (nicht an einem Knoten)
  const i = Math.floor((road.points.length - 1) / 2);
  const a = road.points[i], b = road.points[i + 1];
  // bei 30 % greifen — in der Mitte sitzt der Griff „Punkt einfügen“
  const mid = [a[0] + (b[0] - a[0]) * 0.3, a[1] + (b[1] - a[1]) * 0.3];
  await page.evaluate((c) => window.__streetlab.map.jumpTo({ center: c, zoom: 19 }), mid);
  await page.waitForTimeout(800);
  const q = await px(page, mid);
  await page.mouse.click(q.x, q.y); await page.waitForTimeout(300);
  const sel = await page.evaluate(() => window.__streetlab.editor.selectedId);
  if (sel !== road.id) { console.log(`übersprungen ${road.name}: Klick wählte ${sel}`); await page.close(); continue; }
  const off = { x: q.x + mx, y: q.y + my };
  await drag(page, q, off);
  await drag(page, off, q);
  await report(`${road.name} um ${mx},${my} px verschieben und zurück`, diff(before, await state(page)), page);
  await page.close();
}
// 2. jeden Knoten (gemeinsamer Punkt mehrerer Straßen) wegziehen und zurück
const keys = new Map();
for (const r of p0.roads) for (const p of r.points) keys.set(p.join(), (keys.get(p.join()) ?? 0) + 1);
for (const [k, n] of keys) for (const [mx, my] of MOVES) {
  if (n < 2) continue;
  const pt = k.split(',').map(Number);
  const page = await open();
  const before = await state(page);
  await page.evaluate((c) => window.__streetlab.map.jumpTo({ center: c, zoom: 19 }), pt);
  await page.waitForTimeout(800);
  // Knoten zuerst anklicken (Griffe erscheinen), dann ziehen
  const q = await px(page, pt);
  await page.mouse.click(q.x, q.y); await page.waitForTimeout(300);
  const off = { x: q.x + mx, y: q.y + my };
  await drag(page, q, off);
  await drag(page, off, q);
  await report(`Knoten ${pt.map((x) => x.toFixed(5))} um ${mx},${my} px wegziehen und zurück`, diff(before, await state(page)), page);
  await page.close();
}
await browser.close();
console.log(failed ? `${failed} Fehler` : 'alle Rundwege ok');
process.exit(failed ? 1 : 0);
