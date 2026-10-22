// Bedientest „Kreisverkehr aufziehen“ (Taste R): auf eine Kreuzung drücken, Radius ziehen,
// Mini-Kreisel unter 10 m, Klick ohne Ziehen, daneben drücken, rückgängig.
// Aufruf: node scripts/roundabout-tool.mjs <ausgabeordner>   (Dev-Server auf Port 5180)
import { chromium } from 'playwright-core';
const out = process.argv[2] ?? '.';
const O = [9.1706, 48.7795];
const M = 111320, kx = Math.cos((O[1] * Math.PI) / 180);
const ll = (x, y) => [O[0] + x / (M * kx), O[1] + y / M];
const key = (p) => p[0].toFixed(8) + ',' + p[1].toFixed(8);
const strip = (id, type, width, dir = 1) => ({ id, type, width, dir, lineRight: 'auto' });
const profile = (k) => [strip(`${k}1`, 'sidewalk', 2.5), strip(`${k}2`, 'drive', 3.25, -1), strip(`${k}3`, 'drive', 3.25), strip(`${k}4`, 'sidewalk', 2.5)];
const project = {
  version: 1,
  name: 'Kreisel',
  basemap: 'none',
  view: { center: ll(0, 0), zoom: 18 },
  roads: [
    { id: 'H', name: 'Quer', points: [ll(-80, 0), ll(0, 0), ll(80, 0)], profile: profile('h'), smooth: true },
    { id: 'V', name: 'Längs', points: [ll(0, -80), ll(0, 0), ll(0, 80)], profile: profile('v'), smooth: true },
  ],
};
const K = key(ll(0, 0));

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
const junction = () => page.evaluate((k) => window.__streetlab.store.project.junctions?.[k] ?? null, K);
const label = () => page.evaluate(() => [...document.querySelectorAll('.snap-label')].find((l) => l.style.display === 'block')?.textContent ?? '');
const drag = async ([x0, y0], [x1, y1], shot) => {
  const a = await px(x0, y0), b = await px(x1, y1);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  const l = await label();
  if (shot) await page.screenshot({ path: `${out}/${shot}` });
  await page.mouse.up();
  await page.waitForTimeout(500);
  return l;
};

await page.keyboard.press('r');
check((await page.evaluate(() => window.__streetlab.editor.mode)) === 'roundabout', 'Taste R wählt „Kreisverkehr aufziehen“');

// 1. Radius 20 m aufziehen (etwas neben der Mitte angefasst)
let l = await drag([1.5, -1], [14, 14.5], 'kreisel-1-aufziehen.png');
check(l === 'r 20 m · 4 Arme · Kreisverkehr', `Beschriftung „${l}“`);
let j = await junction();
check(j?.kind === 'roundabout' && j.rbRadius === 20 && j.rbLane === 6.5 && j.control === 'none', `Kreisverkehr r 20 m (${JSON.stringify(j && { kind: j.kind, r: j.rbRadius, lane: j.rbLane, control: j.control })})`);
check((await page.evaluate(() => window.__streetlab.editor.selectedNode)) === K, 'Knoten ist danach ausgewählt');
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/kreisel-2-ergebnis.png` });

// 2. kleiner als 10 m: Mini-Kreisel mit 6 m Fahrbahn
l = await drag([0, 0], [8, 0]);
j = await junction();
check(/Mini-Kreisel$/.test(l) && j.kind === 'mini' && j.rbRadius === 8 && j.rbLane === 6, `Mini-Kreisel („${l}“, r ${j.rbRadius}, Fahrbahn ${j.rbLane})`);

// 3. wieder groß: Fahrbahnbreite des Kreisverkehrs kommt zurück
await drag([0, 0], [0, 25]);
j = await junction();
check(j.kind === 'roundabout' && j.rbRadius === 25 && j.rbLane === 6.5, `zurück zum Kreisverkehr (r ${j.rbRadius}, Fahrbahn ${j.rbLane})`);

// 4. Klick ohne Ziehen ändert den Radius nicht; daneben drücken tut nichts
await drag([0, 0], [0, 0]);
check((await junction()).rbRadius === 25, 'Klick ohne Ziehen behält den Radius');
// Straßen und Knoten — die Ansicht ändert sich, weil Ziehen neben einer Kreuzung die Karte verschiebt
const net = () => page.evaluate(() => JSON.stringify([window.__streetlab.store.project.roads, window.__streetlab.store.project.junctions]));
const before = await net();
await drag([40, 40], [60, 60]);
check((await net()) === before, 'neben einer Kreuzung: Straßen und Knoten unverändert');

// 5. rückgängig bis zur Kreuzung
for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
await page.waitForTimeout(400);
j = await junction();
check(!j || j.kind === 'cross', `Strg+Z stellt die Kreuzung wieder her (${j?.kind ?? 'keine Einstellung'})`);

check(!errors.length, `keine Fehler im Browser${errors.length ? ': ' + errors.join(' · ') : ''}`);
await browser.close();
process.exit(failed ? 1 : 0);
