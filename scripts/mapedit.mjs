// Bedien-Test: Bearbeiten direkt in der Karte (Streifen, Verziehung, Kreuzung).
import { chromium } from 'playwright-core';
import { scenes, ll } from './scenes.mjs';
const out = process.argv[2];
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
const p = structuredClone(scenes.trans); p.basemap = 'none'; p.view = { center: ll(-20, 0), zoom: 19 };
await page.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), p);
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.editor);
await page.waitForTimeout(1200);
const px = (x, y) => page.evaluate(([q]) => { const s = window.__streetlab.map.project(q); const r = document.getElementById('map').getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, [ll(x, y)]);
const prof = (id) => page.evaluate((id) => window.__streetlab.store.road(id).profile.map((s) => s.type[0] + s.width).join(' '), id);

// 1. Parkstreifen von Straße A anklicken (y = +4.5 liegt im Parkstreifen links)
let q = await px(-60, 4.5); await page.mouse.click(q.x, q.y); await page.waitForTimeout(400);
console.log('Popup:', await page.locator('.me-head').textContent());
await page.locator('.me [data-action=strip-width] button[title="größer"]').click(); await page.waitForTimeout(300);
await page.locator('.me select[data-action=strip-type]').selectOption('green'); await page.waitForTimeout(500);
console.log('A nach Bearbeiten:', await prof('A'));
await page.screenshot({ path: `${out}/me-strip.png` });

// 2. Verziehung A→B anklicken (Knoten bei x = −20; Mitte der Zone)
q = await px(-20, -1.5); await page.mouse.click(q.x, q.y); await page.waitForTimeout(400);
console.log('Popup:', await page.locator('.me-head').textContent());
const slider = page.locator('.me .slider input');
await slider.evaluate((el) => { el.value = '36'; el.dispatchEvent(new Event('change')); }); await page.waitForTimeout(400);
console.log('Länge:', await page.evaluate(() => Object.values(window.__streetlab.store.project.junctions ?? {}).map((j) => j.transition)));
await page.screenshot({ path: `${out}/me-trans.png` });
await browser.close();
