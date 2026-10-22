// Bedien-Test: Straßen-/Kreuzungsauswahl, Kreisverkehr umschalten, Knoten ziehen, Mitteltaste, Richtung drehen.
import { chromium } from 'playwright-core';
import { scenes, ll } from './scenes.mjs';
const out = process.argv[2];
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
const p = structuredClone(scenes.style); p.basemap = 'none';
await page.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), p);
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.editor);
await page.waitForTimeout(1500);
const px = (x, y) => page.evaluate(([q]) => { const s = window.__streetlab.map.project(q); const r = document.getElementById('map').getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, [ll(x, y)]);
const st = () => page.evaluate(() => { const { editor, store } = window.__streetlab; return { road: editor.selectedId, node: editor.selectedNode, junctions: Object.values(store.project.junctions ?? {}).map((j) => j.kind) }; });

// 1. Straße "wohn" anklicken (Parkstreifen bei y=30)
let q = await px(4.5, 30); await page.mouse.click(q.x, q.y); await page.waitForTimeout(400);
console.log('Straße gewählt:', await st());
await page.screenshot({ path: `${out}/ui2-road.png` });

// 2. Fahrtrichtungen drehen → Querschnitt gespiegelt?
const before = await page.evaluate(() => window.__streetlab.store.road(window.__streetlab.editor.selectedId).profile.map((s) => s.type + s.dir).join(' '));
await page.click('[data-action=reverse]');
const after = await page.evaluate(() => window.__streetlab.store.road(window.__streetlab.editor.selectedId).profile.map((s) => s.type + s.dir).join(' '));
console.log('vorher:', before, '\nnachher:', after);
await page.keyboard.press('Control+z');

// 3. Kreisverkehr anklicken (Ringfahrbahn bei x=160+12)
q = await px(172, 0); await page.mouse.click(q.x, q.y); await page.waitForTimeout(400);
console.log('Knoten gewählt:', await st());
await page.screenshot({ path: `${out}/ui2-node.png` });

// 4. Knoten verschieben → Einstellungen wandern mit
const a = await px(160, 0), b = await px(170, 8);
await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(500);
console.log('nach Verschieben:', await st());

// 5. auf Kreuzung umschalten
await page.locator('#panel [data-action=kind] button[data-value=cross]').click(); await page.waitForTimeout(500);
console.log('umgeschaltet:', await st());

// 6. mittlere Maustaste: Karte verschieben
const c0 = await page.evaluate(() => window.__streetlab.map.getCenter().toArray());
await page.mouse.move(900, 500); await page.mouse.down({ button: 'middle' }); await page.mouse.move(700, 450, { steps: 5 }); await page.mouse.up({ button: 'middle' });
const c1 = await page.evaluate(() => window.__streetlab.map.getCenter().toArray());
console.log('Karte verschoben:', c0[0] !== c1[0] && c0[1] !== c1[1]);
await page.screenshot({ path: `${out}/ui2-after.png` });
await browser.close();
