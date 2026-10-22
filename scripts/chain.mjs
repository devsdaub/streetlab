// Bedien-Test: Straßen aneinanderhängen, Kurve ziehen, Verbindungspunkt verschieben.
import { chromium } from 'playwright-core';
import { ll } from './scenes.mjs';
const out = process.argv[2];

const project = { version: 1, name: 'Kettentest', view: { center: ll(0, 0), zoom: 17.6 }, roads: [] };
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), project);
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.map?.loaded());
await page.waitForTimeout(1500);
const px = (x, y) => page.evaluate(([p]) => { const q = window.__streetlab.map.project(p); const r = document.getElementById('map').getBoundingClientRect(); return { x: q.x + r.left, y: q.y + r.top }; }, [ll(x, y)]);
const state = () => page.evaluate(() => {
  const rs = window.__streetlab.store.project.roads;
  const key = (p) => p[0].toFixed(8) + ',' + p[1].toFixed(8);
  return rs.map((r) => `${r.name}: ${r.points.length} Pkt, Start verbunden=${rs.some((o) => o !== r && o.points.some((q) => key(q) === key(r.points[0])))}, Ende verbunden=${rs.some((o) => o !== r && o.points.some((q) => key(q) === key(r.points.at(-1))))}`);
});
const draw = async (pts) => {
  await page.keyboard.press('d');
  for (const [x, y] of pts) { const p = await px(x, y); await page.mouse.click(p.x, p.y); }
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
};
const drag = async (a, b) => {
  const p = await px(...a), q = await px(...b);
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.move(q.x, q.y, { steps: 10 }); await page.mouse.up();
};

// 1. Kette: A, dann B ab Ende von A (leicht daneben geklickt → Fangen), dann C ab Ende von B
await draw([[-90, 0], [-30, 0]]);
await draw([[-29.5, 0.6], [30, 10]]);
await draw([[30.4, 9.5], [90, -10]]);
console.log('Kette:', await state());
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/chain-1.png` });

// 2. Mittlere Straße wählen und am Zwischenpunkt eine Kurve aufziehen
let p = await px(0, 5); await page.mouse.click(p.x, p.y);
await page.waitForTimeout(300);
await drag([0, 5], [0, 22]);
console.log('nach Kurve:', await state());
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/chain-2.png` });

// 3. Verbindungspunkt A–B nach unten schieben
await drag([-30, 0], [-30, -12]);
await page.keyboard.press('Escape');
console.log('nach Verschieben:', await state());
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/chain-3.png` });
await page.evaluate(([c]) => window.__streetlab.map.jumpTo({ center: c, zoom: 20 }), [ll(-30, -12)]);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/chain-4-zoom.png` });
// 4. Härtetest: Straße 3 stark verbiegen (Zwischenpunkt 35 m zur Seite)
await page.evaluate(([c]) => window.__streetlab.map.jumpTo({ center: c, zoom: 17.6 }), [ll(0, 0)]);
await page.waitForTimeout(500);
p = await px(60, 0); await page.mouse.click(p.x, p.y);
await page.waitForTimeout(300);
await drag([60, 0], [75, -35]);
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/chain-5-stark.png` });
const zp = await page.evaluate(() => { const r = window.__streetlab.store.project.roads[2]; return r.points[1]; });
await page.evaluate(([c]) => window.__streetlab.map.jumpTo({ center: c, zoom: 19.6 }), [zp]);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/chain-6-haarnadel.png` });
await browser.close();
