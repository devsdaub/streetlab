// Bedientest „Abschnitt ziehen“ (Taste A): entlang einer Straße ziehen, dort gilt der gewählte
// Querschnitt; davor und danach bleibt alles. Auch auf einer Kurve (Punkte auf dem Bogen).
// Aufruf: node scripts/section-brush.mjs <ausgabeordner>   (Dev-Server auf Port 5180)
import { chromium } from 'playwright-core';
const out = process.argv[2] ?? '.';
const O = [9.1706, 48.7795];
const M = 111320, kx = Math.cos((O[1] * Math.PI) / 180);
const ll = (x, y) => [O[0] + x / (M * kx), O[1] + y / M];
const xy = ([lng, lat]) => [(lng - O[0]) * M * kx, (lat - O[1]) * M];
const strip = (id, type, width, dir = 1) => ({ id, type, width, dir, lineRight: 'auto' });
const base = (k) => [strip(`${k}1`, 'sidewalk', 2.5), strip(`${k}2`, 'parking', 2), strip(`${k}3`, 'drive', 3, -1), strip(`${k}4`, 'drive', 3), strip(`${k}5`, 'parking', 2), strip(`${k}6`, 'sidewalk', 2.5)];
// Kurve: Viertelkreis mit 60 m Radius um (0, -150), Punkte alle 22,5°
const R = 60, C = [0, -150];
const arc = Array.from({ length: 5 }, (_, i) => { const a = Math.PI + (i * Math.PI) / 8; return [C[0] + R * Math.cos(a) + 60, C[1] + R * Math.sin(a) + 60]; });
const project = {
  version: 1,
  name: 'Abschnitt',
  basemap: 'none',
  view: { center: ll(0, -40), zoom: 17.3 },
  roads: [
    { id: 'A', name: 'Gerade', points: [ll(-100, 0), ll(100, 0)], profile: base('a'), smooth: true },
    { id: 'B', name: 'Kurve', points: arc.map(([x, y]) => ll(x, y)), profile: base('b'), smooth: true },
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
const road = (id) => page.evaluate((id) => window.__streetlab.store.project.roads.find((r) => r.id === id), id);
const drag = async (path, shot) => {
  const pts = [];
  for (const [x, y] of path) pts.push(await px(x, y));
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const q of pts.slice(1)) await page.mouse.move(q.x, q.y, { steps: 8 });
  const label = await page.evaluate(() => [...document.querySelectorAll('.snap-label')].find((l) => l.style.display === 'block')?.textContent ?? '');
  if (shot) await page.screenshot({ path: `${out}/${shot}` });
  await page.mouse.up();
  await page.waitForTimeout(500);
  return label;
};
const types = (p) => p.map((s) => s.type + (s.planting ? `(${s.planting})` : '')).join(' ');

// Werkzeug wählen und Vorlage „Wohnstraße mit Baumreihen“ nehmen
await page.keyboard.press('a');
check((await page.evaluate(() => window.__streetlab.editor.mode)) === 'section', 'Taste A wählt „Abschnitt ziehen“');
await page.click('[data-action="draw-preset"]');
await page.click('.preset[data-preset="9"]');
await page.waitForTimeout(200);

// 1. Mitte der Geraden: von -40 bis +30 m (über -60 hinaus und zurück: „weiter ziehen“)
const before = await road('A');
const label = await drag([[-40, 0.5], [-60, 0.8], [30, 1]], 'abschnitt-1-ziehen.png');
check(/^\d+ m · Wohnstraße mit Baumreihen/.test(label), `Beschriftung beim Ziehen: „${label}“`);
let A = await road('A');
const xs = A.points.map((p) => xy(p)[0].toFixed(1));
check(A.points.length === 4 && A.points.every((p) => Math.abs(xy(p)[1]) < 0.01), `zwei Punkte eingefügt, Straße bleibt gerade (${xs.join(', ')})`);
check(A.sections?.length === 2 && A.sections[0].index === 1 && A.sections[1].index === 2, `zwei Abschnittsgrenzen (${JSON.stringify(A.sections?.map((s) => s.index))})`);
check(types(A.sections[0].profile).includes('green(trees)'), `Abschnitt hat den neuen Querschnitt: ${types(A.sections[0].profile)}`);
check(JSON.stringify(A.profile) === JSON.stringify(before.profile) && JSON.stringify(A.sections[1].profile) === JSON.stringify(before.profile), 'davor und danach unverändert (gleiche Streifen-IDs)');
const sel = await page.evaluate(() => ({ id: window.__streetlab.editor.selectedId, sec: window.__streetlab.editor.selectedSection }));
check(sel.id === 'A' && sel.sec === 1, `neuer Abschnitt ist ausgewählt (${JSON.stringify(sel)})`);

// 2. am Anfang beginnend: Grundquerschnitt wird ersetzt, nur eine neue Grenze
await drag([[-99.5, 0], [-70, 0]]);
A = await road('A');
check(types(A.profile).includes('green(trees)') && A.sections?.length === 3, `Abschnitt am Anfang (${A.sections?.length} Grenzen, Anfang: ${types(A.profile)})`);

// 3. Kurve: neue Punkte liegen auf der geglätteten Linie — in den inneren Stücken weicht sie
// höchstens 3 cm vom Kreis ab, ein Punkt auf der Sehne läge 1,15 m daneben. Jeder eingefügte
// Punkt verändert die Glättung der Nachbarstücke etwas (hier bis 16 cm) — daher 25 cm Spielraum.
const onArc = (k, f = 0.5) => { const a = Math.PI + ((k + f) * Math.PI) / 8; return [C[0] + R * Math.cos(a) + 60, C[1] + R * Math.sin(a) + 60]; };
await drag([onArc(1, 0.4), onArc(2, 0.6)], 'abschnitt-2-kurve.png');
const B = await road('B');
const dev = B.points.map((p) => { const [x, y] = xy(p); return Math.abs(Math.hypot(x - 60 - C[0], y - 60 - C[1]) - R); });
check(B.points.length === 7 && Math.max(...dev) < 0.25, `Kurve: ${B.points.length} Punkte, Abweichung vom Bogen je Punkt ${dev.map((d) => d.toFixed(2)).join(" ")} m`);

// 4. Klick ohne Ziehen ändert nichts; ein Strg+Z nimmt einen ganzen Zug zurück
const n0 = JSON.stringify(await road('A'));
await drag([[50, 0], [50.5, 0]]);
check(JSON.stringify(await road('A')) === n0, 'nur geklickt: keine Änderung');
await page.keyboard.press('Escape');
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
check((await road('B')).points.length === 5, 'Strg+Z nimmt den letzten Zug zurück');
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
check(JSON.stringify(await road('A')) === JSON.stringify(before), 'Strg+Z stellt die Gerade wieder her');
await page.screenshot({ path: `${out}/abschnitt-3-ende.png` });

check(!errors.length, `keine Fehler im Browser${errors.length ? ': ' + errors.join(' · ') : ''}`);
await browser.close();
process.exit(failed ? 1 : 0);
