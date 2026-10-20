// Bedien-Test: Straßen über die UI zeichnen, Knoten ziehen, hochaufgelöst exportieren.
import { chromium } from 'playwright-core';
import { ll } from './scenes.mjs';
const out = process.argv[2];

const S = (type, width, dir = 1) => ({ id: Math.random().toString(36).slice(2), type, width, dir, lineRight: 'auto' });
const project = {
  version: 1, name: 'Bedientest', view: { center: ll(0, 0), zoom: 17.7 },
  roads: [{ id: 'ow', name: 'Ost-West', smooth: true, points: [ll(-80, 0), ll(80, 0)],
    profile: [S('sidewalk', 2.5), S('bike', 2, -1), S('drive', 3.25, -1), S('drive', 3.25, 1), S('bike', 2, 1), S('sidewalk', 2.5)] }],
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), project);
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.map?.loaded());
await page.waitForTimeout(1500);
const px = (x, y) => page.evaluate(([p]) => { const q = window.__streetlab.map.project(p); const r = document.getElementById('map').getBoundingClientRect(); return { x: q.x + r.left, y: q.y + r.top }; }, [ll(x, y)]);
const roads = () => page.evaluate(() => window.__streetlab.store.project.roads.map((r) => `${r.name}: ${r.points.length} Punkte`));

// 1. Nord-Süd-Straße quer über die Ost-West-Straße zeichnen → Kreuzung
await page.keyboard.press('d');
for (const [x, y] of [[-20, 60], [-20, -60]]) { const p = await px(x, y); await page.mouse.click(p.x, p.y); }
await page.keyboard.press('Enter');
console.log('nach Kreuzen:', await roads());

// 2. Stichstraße, die auf der Mittellinie (nicht auf einem Punkt) beginnt → T-Einmündung
await page.keyboard.press('d');
let p = await px(45, 0.8); await page.mouse.click(p.x, p.y);
p = await px(60, -55); await page.mouse.click(p.x, p.y);
await page.keyboard.press('Enter');
console.log('nach Einmündung:', await roads());
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/ui-1.png` });

// 3. Kreuzungspunkt ziehen → beide Straßen müssen mitgehen
p = await px(-20, 30); await page.mouse.click(p.x, p.y); // Nord-Süd auswählen
await page.waitForTimeout(300);
const from = await px(-20, 0), to = await px(-10, 8);
await page.mouse.move(from.x, from.y); await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up();
const shared = await page.evaluate(() => { const [a, b] = window.__streetlab.store.project.roads; return b.points.filter((p) => a.points.some((q) => q[0] === p[0] && q[1] === p[1])).length; });
console.log('gemeinsame Punkte nach dem Ziehen:', shared);
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/ui-2.png` });

// 4. Export mit BW-Orthofoto: PNG 4× und SVG
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
await page.selectOption('select[data-action=basemap]', 'dop-bw');
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/ui-3-dop.png` });
await page.click('details[data-fold=export] summary');
await page.click('[data-action=export-scale] button[data-value="4"]');
console.log('Export-Info:', await page.locator('.group', { hasText: 'Export' }).locator('p.muted').textContent());
const [png] = await Promise.all([page.waitForEvent('download', { timeout: 150000 }), page.click('[data-action=export-png]')]);
await png.saveAs(`${out}/export-4x.png`);
const [svg] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-svg]')]);
await svg.saveAs(`${out}/export.svg`);
await browser.close();
console.log('fertig');
