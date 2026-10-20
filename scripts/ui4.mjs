// Bedien-Test: Straße verschieben (verbunden / mit Alt gelöst), Breite am Griff ziehen, Knoten lösen, Klick wählt Streifen.
import { chromium } from 'playwright-core';
import { scenes, ll } from './scenes.mjs';
const out = process.argv[2];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const open = async (scene, view) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
  page.on('dialog', (d) => { console.log('Hinweis:', d.message()); d.dismiss(); });
  const p = structuredClone(scenes[scene]); p.basemap = 'none'; p.view = view;
  await page.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), p);
  await page.goto('http://localhost:5180/');
  await page.waitForFunction(() => window.__streetlab?.editor);
  await page.waitForTimeout(1200);
  return page;
};
const px = (page, q) => page.evaluate(([q]) => { const s = window.__streetlab.map.project(q); const r = document.getElementById('map').getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, [q]);
const drag = async (page, a, b, alt = false) => {
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
  await page.waitForTimeout(600);
};
const shared = (page) => page.evaluate(() => {
  const r = window.__streetlab.store.project.roads; const k = (p) => p.join();
  return { AB: k(r[0].points.at(-1)) === k(r[1].points[0]), BC: k(r[1].points.at(-1)) === k(r[2].points[0]) };
});

// 1. Kette A–B–C: B auswählen und am Stück 12 m nach Norden ziehen
let page = await open('trans', { center: ll(10, 0), zoom: 18.2 });
let q = await px(page, ll(10, 2)); await page.mouse.click(q.x, q.y); await page.waitForTimeout(300);
console.log('gewählt:', await page.evaluate(() => [window.__streetlab.editor.selectedId, window.__streetlab.editor.selectedStrip]));
const yB = () => page.evaluate(() => window.__streetlab.store.road('B').points[0][1]);
const y0 = await yB();
await drag(page, await px(page, ll(0, 1)), await px(page, ll(0, 13)));
console.log('verschoben um', ((await yB() - y0) * 111320).toFixed(1), 'm, verbunden:', await shared(page));
// 2. Mit Alt erneut ziehen: B löst sich von A und C
await drag(page, await px(page, ll(0, 13)), await px(page, ll(0, 23)), true);
console.log('mit Alt, verbunden:', await shared(page));
await page.screenshot({ path: `${out}/ui4-move.png` });
await page.close();

// 3. Breite am Griff ziehen (Straße A, Kante rechts vom 2. Streifen)
page = await open('trans', { center: ll(-55, 0), zoom: 19.5 });
q = await px(page, ll(-55, 1)); await page.mouse.click(q.x, q.y); await page.waitForTimeout(400);
const handles = await page.evaluate(() => window.__streetlab.map.querySourceFeatures('width-handles').map((f) => ({ k: f.properties.k, c: f.geometry.coordinates })));
const h1 = handles.find((h) => h.k === 1);
const before = await page.evaluate(() => window.__streetlab.store.road('A').profile[1].width);
const a = await px(page, h1.c); 
await drag(page, a, { x: a.x, y: a.y + 8 });
const after = await page.evaluate(() => window.__streetlab.store.road('A').profile.map((s) => s.width));
console.log('Griffe:', handles.length, 'Breite Streifen 2 vorher', before, 'nachher', after[1]);
await page.screenshot({ path: `${out}/ui4-width.png` });
await page.close();

// 4. Knoten lösen an der schiefen Einmündung (drei Straßenenden)
page = await open('all', { center: ll(0, -140), zoom: 18.5 });
q = await px(page, ll(0, -140)); await page.mouse.click(q.x, q.y); await page.waitForTimeout(400);
await page.click('[data-action=detach]'); await page.waitForTimeout(600);
console.log('nach Lösen, Straßen am Knoten:', await page.evaluate(() => { const k = (p) => p[0].toFixed(8) + ',' + p[1].toFixed(8); const r = window.__streetlab.store.project.roads.filter((x) => x.id.startsWith('y-')); const key = k(r[0].points[0]); return r.filter((x) => x.points.some((p) => k(p) === key)).length; }));
await page.close();
await browser.close();
