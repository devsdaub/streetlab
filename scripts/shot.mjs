// Screenshots per Edge (headless): node scripts/shot.mjs <szene> <datei.png> [zoom] [dx dy]
import { chromium } from 'playwright-core';
import { scenes, ll } from './scenes.mjs';

const [scene = 'all', out = 'shot.png', zoom, dx, dy] = process.argv.slice(2);
const project = structuredClone(scenes[scene]);
if (process.env.BASEMAP) project.basemap = process.env.BASEMAP;
if (zoom) project.view = { center: ll(+dx || 0, +dy || 0), zoom: +zoom };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()));
await page.addInitScript((p) => localStorage.setItem('streetlab.project.v1', JSON.stringify(p)), project);
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => document.querySelector('#panel .inspector-head'));
await page.waitForTimeout(4000);
await page.screenshot({ path: out });
await browser.close();
console.log('ok', out);
