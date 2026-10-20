// Bedien-Test: Radwege an Kreuzungen (Radfurten inkl. Rechtsabbiegen) und an Übergängen verbinden.
import { chromium } from 'playwright-core';
import { scenes, ll } from './scenes.mjs';
const out = process.argv[2];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
const key = (q) => q[0].toFixed(8) + ',' + q[1].toFixed(8);
const p = structuredClone(scenes.all); p.basemap = 'none'; p.view = { center: ll(0, 0), zoom: 19.6 };
// Kreuzung „kreuz“: Nord-Süd-Straße bekommt auch Radstreifen
const ns = p.roads.find((r) => r.id === 'kreuz-ns');
ns.profile = structuredClone(p.roads.find((r) => r.id === 'kreuz-ow').profile).map((s, i) => ({ ...s, id: 'ns' + i }));
p.junctions = { [key(ll(0, 0))]: { kind: 'cross', radius: 8, crossing: 'none', bikeCrossing: true, stopLines: true, control: 'stoplines', rbRadius: 15, rbLane: 6.5 } };
await page.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), p);
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.editor);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/bike-junction.png` });
const px = (q) => page.evaluate(([q]) => { const s = window.__streetlab.map.project(q); const r = document.getElementById('map').getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, [q]);
let q = await px(ll(0, 0)); await page.mouse.click(q.x, q.y); await page.waitForTimeout(300);
await page.click('#panel [data-action=lane-edit]'); await page.waitForTimeout(500);
const info = await page.evaluate(() => { const e = window.__streetlab.editor; return e.getInfo(e.selectedNode); });
console.log('Radspuren:', info.lanes.filter((l) => l.bike).length, 'Radverbindungen:', info.links.filter((l) => l.bike).map((l) => l.move).join(','));
await page.screenshot({ path: `${out}/bike-edit.png` });
await browser.close();

// ---- Übergang: Radweg davor mit Radweg danach in der Karte verbinden ----
{
  const browser2 = await chromium.launch({ channel: 'msedge', headless: true });
  const pg = await browser2.newPage({ viewport: { width: 1440, height: 900 } });
  pg.on('pageerror', (e) => console.error('PAGEERROR', e.message));
  const u = structuredClone(scenes.user); u.basemap = 'none'; u.view = { center: ll(0, 0), zoom: 19.6 };
  await pg.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), u);
  await pg.goto('http://localhost:5180/');
  await pg.waitForFunction(() => window.__streetlab?.editor);
  await pg.waitForTimeout(1200);
  const pp = (q) => pg.evaluate(([q]) => { const s = window.__streetlab.map.project(q); const r = document.getElementById('map').getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, [q]);
  let c = await pp(ll(0, 0)); await pg.mouse.click(c.x, c.y); await pg.waitForTimeout(400);
  await pg.click('[data-action=transition-edit]'); await pg.waitForTimeout(400);
  const t = await pg.evaluate(() => { const e = window.__streetlab.editor; return e.getTransition(e.transitionEdit); });
  const bikeA = t.A.find((s) => s.type === 'bike'), bikeB = t.B.find((s) => s.type === 'bike');
  const posA = t.ends.find((e) => e.side === 'a' && e.id === bikeA.id).pos, posB = t.ends.find((e) => e.side === 'b' && e.id === bikeB.id).pos;
  c = await pp(posA); await pg.mouse.click(c.x, c.y); await pg.waitForTimeout(200);
  c = await pp(posB); await pg.mouse.click(c.x, c.y); await pg.waitForTimeout(600);
  console.log('Verbindung:', await pg.evaluate(() => window.__streetlab.store.project.stripLinks));
  await pg.screenshot({ path: `${out}/bike-transition.png` });
  await browser2.close();
}
