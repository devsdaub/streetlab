// Bedientest Kurven-Werkzeug (Taste K): Bogen tangential aus einem Straßenende, tangential
// weiterbauen, Einfädeln in eine Straße mit Winkelanzeige, freier Anfang mit Richtungs-Klick.
// Aufruf: node scripts/curve-tool.mjs <ausgabeordner>   (Dev-Server auf Port 5180)
import { chromium } from 'playwright-core';
const out = process.argv[2] ?? '.';
const O = [9.1706, 48.7795];
const M = 111320, kx = Math.cos((O[1] * Math.PI) / 180);
const ll = (x, y) => [O[0] + x / (M * kx), O[1] + y / M];
const xy = ([lng, lat]) => [(lng - O[0]) * M * kx, (lat - O[1]) * M];
const key = (p) => p[0].toFixed(8) + ',' + p[1].toFixed(8);
const strip = (id, type, width, dir = 1) => ({ id, type, width, dir, lineRight: 'auto' });
const profile = (k) => [strip(`${k}1`, 'sidewalk', 2.5), strip(`${k}2`, 'drive', 3.25, -1), strip(`${k}3`, 'drive', 3.25), strip(`${k}4`, 'sidewalk', 2.5)];
const project = {
  version: 1,
  name: 'Kurve',
  basemap: 'none',
  view: { center: ll(10, 10), zoom: 17.6 },
  roads: [
    { id: 'A', name: 'Zufahrt', points: [ll(-100, 0), ll(0, 0)], profile: profile('a'), smooth: true },
    { id: 'T', name: 'Ziel', points: [ll(60, -80), ll(60, 90)], profile: profile('t'), smooth: true },
  ],
};

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
const move = async (x, y) => { const p = await px(x, y); await page.mouse.move(p.x, p.y, { steps: 4 }); await page.waitForTimeout(80); };
const click = async (x, y) => { const p = await px(x, y); await page.mouse.click(p.x, p.y); await page.waitForTimeout(250); };
const label = () => page.evaluate(() => [...document.querySelectorAll('.snap-label')].find((l) => l.style.display === 'block')?.textContent ?? '');
/** Zahlen aus der Beschriftung (Länge, Radius, Winkel) */
const nums = (t) => (t.match(/\d+/g) ?? []).map(Number);
const near = (a, b) => Math.abs(a - b) <= 1; // Cursor liegt auf ganzen Pixeln
const roads = () => page.evaluate(() => window.__streetlab.store.project.roads);
/** Winkel (°) zwischen Richtung des ersten Stücks einer Straße und d */
const startAngle = (r, d) => { const [a, b] = [xy(r.points[0]), xy(r.points[1])]; const v = [b[0] - a[0], b[1] - a[1]]; return (Math.acos((v[0] * d[0] + v[1] * d[1]) / Math.hypot(...v) / Math.hypot(...d)) * 180) / Math.PI; };

await page.keyboard.press('k');
check((await page.evaluate(() => window.__streetlab.editor.mode)) === 'curve', 'Taste K wählt das Kurven-Werkzeug');

// 1. am Straßenende beginnen: Bogen tangential, Radius und Länge stimmen
await click(0, 0);
await move(40, 30);
let l = await label();
check(/^\d+ m · r \d+ m$/.test(l) && near(nums(l)[0], 54) && near(nums(l)[1], 42), `Vorschau „${l}“ (erwartet etwa „54 m · r 42 m“)`);
await page.screenshot({ path: `${out}/kurve-1-vorschau.png` });
await click(40, 30);
let rs = await roads();
const c1 = rs[2];
check(rs.length === 3 && key(c1.points[0]) === key(project.roads[0].points[1]), `Bogen beginnt genau am Straßenende (${rs.length} Straßen)`);
check(startAngle(c1, [1, 0]) < 5, `tangential heraus (${startAngle(c1, [1, 0]).toFixed(1)}° zur Zufahrt)`);

// 2. hinter dem Anfang (über 180°): kein Bogen, Klick tut nichts
await move(-20, 40);
await move(10, 10);
await move(-30, 25);
check((await label()) === '', 'Ziel hinter dem Anfang: keine Vorschau');
await click(-30, 25);
check((await roads()).length === 3, 'Klick dort legt nichts an');

// 3. tangential weiter und in die Zielstraße einfädeln (Winkel wird angezeigt)
await move(60, 70);
l = await label();
check(/∠ \d+°$/.test(l) && near(nums(l).at(-1), 37), `Einfädeln mit Winkel: „${l}“ (erwartet etwa 37°)`);
await page.screenshot({ path: `${out}/kurve-2-einfaedeln.png` });
await click(60, 70);
rs = await roads();
const c2 = rs[3], T = rs.find((r) => r.id === 'T');
const d1 = (() => { const n = c1.points.length; const [a, b] = [xy(c1.points[n - 2]), xy(c1.points[n - 1])]; return [b[0] - a[0], b[1] - a[1]]; })();
check(startAngle(c2, d1) < 5, `zweiter Bogen schließt tangential an (${startAngle(c2, d1).toFixed(1)}°)`);
check(T.points.some((p) => key(p) === key(c2.points[c2.points.length - 1])), 'Ende ist mit der Zielstraße verknüpft');
await page.keyboard.press('Escape');
check((await page.evaluate(() => window.__streetlab.editor.mode)) === 'select', 'Esc beendet das Werkzeug');

// 4. freier Anfang: zweiter Klick legt die Richtung fest
await page.keyboard.press('k');
await click(-60, -50);
await move(-40, -50);
check((await label()) === 'Klick legt die Anfangsrichtung fest', 'Hinweis auf den Richtungs-Klick');
await click(-40, -50);
await move(-10, -30);
l = await label();
check(/^\d+ m · r \d+ m$/.test(l), `freier Bogen „${l}“`);
await click(-10, -30);
rs = await roads();
check(rs.length === 5 && startAngle(rs[4], [1, 0]) < 5, `freier Bogen tangential zur gewählten Richtung (${startAngle(rs[4], [1, 0]).toFixed(1)}°)`);
await page.keyboard.press('Escape');

await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
check((await roads()).length === 4, 'Strg+Z nimmt den letzten Bogen zurück');
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/kurve-3-ergebnis.png` });

check(!errors.length, `keine Fehler im Browser${errors.length ? ': ' + errors.join(' · ') : ''}`);
await browser.close();
process.exit(failed ? 1 : 0);
