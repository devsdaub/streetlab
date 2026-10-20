// Bedien-Test: zweite Straße ungenau am Ende der ersten ansetzen → muss fangen + Verziehung zeigen.
import { chromium } from 'playwright-core';
import { ll } from './scenes.mjs';
const out = process.argv[2];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), { version: 1, name: 'Fangtest', basemap: 'none', view: { center: ll(10, 0), zoom: 18 }, roads: [] });
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.__streetlab?.editor);
await page.waitForTimeout(1000);
const px = (x, y) => page.evaluate(([q]) => { const s = window.__streetlab.map.project(q); const r = document.getElementById('map').getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, [ll(x, y)]);
const draw = async (preset, pts) => {
  await page.keyboard.press('d');
  await page.click('[data-action=draw-preset]');
  await page.click(`.picker-tabs button:has-text("${preset === 0 ? 'Wohnen' : 'Hauptverkehr'}")`);
  await page.click(`.preset[data-preset="${preset}"]`);
  for (const [x, y] of pts) { const p = await px(x, y); await page.mouse.move(p.x, p.y, { steps: 3 }); await page.mouse.click(p.x, p.y); }
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
};
await draw(0, [[-60, 0], [0, 0]]);
// Ansatz 3 m vor dem Ende und 4 m seitlich (auf dem Gehweg/Parkstreifen der ersten Straße)
await draw(2, [[-3, 4], [70, 8]]);
const res = await page.evaluate(() => {
  const [a, b] = window.__streetlab.store.project.roads;
  return { verbunden: a.points.at(-1).join() === b.points[0].join(), punkteA: a.points.length };
});
console.log(res);
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/snap.png` });
await browser.close();
