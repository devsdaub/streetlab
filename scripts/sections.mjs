// Bedien-Test: Abbiegespur an einer Kreuzung + Straße per Klick in Abschnitte teilen.
import { chromium } from 'playwright-core';
import { scenes, ll } from './scenes.mjs';
const out = process.argv[2];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
page.on('dialog', (d) => { console.log('DIALOG', d.message()); d.dismiss(); });
const p = structuredClone(scenes.style); p.basemap = 'none'; p.view = { center: ll(-20, 0), zoom: 18.3 };
await page.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), p);
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.editor);
await page.waitForTimeout(1200);
const px = (x, y) => page.evaluate(([q]) => { const s = window.__streetlab.map.project(q); const r = document.getElementById('map').getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, [ll(x, y)]);

// 1. Kreuzung wählen, Linksabbieger für die Zufahrt aus Westen
let q = await px(0, 0); await page.mouse.click(q.x, q.y); await page.waitForTimeout(300);
const labels = await page.locator('.arm-name').allTextContents();
console.log('Zufahrten:', labels);
const west = labels.findIndex((l) => l.startsWith('haupt') && l.includes('Westen'));
await page.locator('.arm').nth(west).locator('[data-action=turn-left]').click();
await page.waitForTimeout(800);
console.log('haupt:', await page.evaluate(() => { const r = window.__streetlab.store.road('haupt'); return { punkte: r.points.length, abschnitte: (r.sections ?? []).map((s) => s.index + ': ' + s.profile.map((x) => x.type[0] + (x.turn ? '(' + x.turn + ')' : '')).join(' ')) }; }));
await page.screenshot({ path: `${out}/sec-turn.png` });

// 2. Straße "wohn" auswählen, teilen, im neuen Abschnitt Vorlage "Allee" setzen
q = await px(4.5, 35); await page.mouse.click(q.x, q.y); await page.waitForTimeout(300);
await page.click('[data-action=split]');
q = await px(0, 40); await page.mouse.click(q.x, q.y); await page.waitForTimeout(400);
console.log('nach Teilen:', await page.evaluate(() => { const e = window.__streetlab.editor; const r = window.__streetlab.store.road('wohn'); return { abschnitt: e.selectedSection, grenzen: (r.sections ?? []).map((s) => s.index) }; }));
await page.click('[data-action=preset]');
await page.click('.picker-tabs button:has-text("Hauptverkehr")');
await page.click('.preset:has-text("Allee mit Mittelinsel")');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/sec-split.png` });
await browser.close();
