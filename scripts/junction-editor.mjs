// Bedien-Test Kreuzungseditor: Spurverbindungen, Vorfahrt, Querung je Arm, Mini-Kreisel, Verkehr.
import { chromium } from 'playwright-core';
import { scenes, ll } from './scenes.mjs';
const out = process.argv[2];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
const p = structuredClone(scenes.style); p.basemap = 'none'; p.view = { center: ll(0, 0), zoom: 19.2 };
await page.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), p);
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.editor);
await page.waitForTimeout(1200);
const px = (q) => page.evaluate(([q]) => { const s = window.__streetlab.map.project(q); const r = document.getElementById('map').getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, [q]);
const key = () => window.__streetlab.editor.selectedNode;

// 1. Kreuzung wählen → Spurverbindungen bearbeiten
let q = await px(ll(0, 0)); await page.mouse.click(q.x, q.y); await page.waitForTimeout(300);
await page.click('[data-action=lane-edit]'); await page.waitForTimeout(500);
const info = await page.evaluate(() => { const e = window.__streetlab.editor; return e.getInfo(e.selectedNode); });
console.log('Spurenden:', info.lanes.length, 'Verbindungen (auto):', info.links.length);
await page.screenshot({ path: `${out}/je-1.png` });
// Zufahrt aus Westen wählen (Arm haupt:b) und eine Ausfahrt abwählen
const inW = info.lanes.find((l) => l.kind === 'in' && l.armId === 'haupt:b');
q = await px(inW.pos); await page.mouse.click(q.x, q.y); await page.waitForTimeout(300);
const target = info.links.find((l) => l.from === inW.id && l.move === 'right');
const outLane = info.lanes.find((l) => l.id === target.to);
q = await px(outLane.pos); await page.mouse.click(q.x, q.y); await page.waitForTimeout(600);
console.log('nach Abwählen rechts:', await page.evaluate((id) => { const p = window.__streetlab.store.project; return Object.values(p.junctions).map((j) => j.connections?.[id]).filter(Boolean); }, inW.id));
await page.screenshot({ path: `${out}/je-2.png` });
await page.click('[data-action=lane-edit]');

// 2. Vorfahrt per Schild + Zebrastreifen nur am Nordarm
await page.locator('select[data-action=control]').selectOption('priority'); await page.waitForTimeout(400);
await page.locator('.arm', { hasText: 'wohn aus Norden' }).locator('select[data-action=arm-crossing]').selectOption('zebra'); await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/je-3.png` });

// 3. Kreisverkehr → Mini-Kreisel, Verkehr an
await page.evaluate(([c]) => window.__streetlab.map.jumpTo({ center: c, zoom: 18.6 }), [ll(160, 0)]);
await page.waitForTimeout(600);
q = await px(ll(172, 0)); await page.mouse.click(q.x, q.y); await page.waitForTimeout(300);
await page.locator('#panel [data-action=kind] button[data-value=mini]').click(); await page.waitForTimeout(400);
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
 await page.locator('[data-action=traffic] .track').click(); await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/je-4.png` });
await browser.close();
