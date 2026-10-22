/** Vorlagen-Galerie: Querschnitte als kleine, mit dem echten Renderer erzeugte Vorschaubilder. */
import type { Polygon } from 'geojson';
import { PRESETS, PRESET_CATEGORIES, leftEdge, presetProfile, type PresetCategory, type Strip } from './model';
import { buildRoad } from './render';
import { fmtM, h, icon } from './ui';

const M = 111320;
const SVG = 'http://www.w3.org/2000/svg';
const cache = new Map<string, string>();

/**
 * Straßenstück als SVG-Markup (Draufsicht, Fahrtrichtung nach rechts). Die Länge richtet sich
 * nach dem Seitenverhältnis `aspect`, damit immer der ganze Querschnitt zu sehen ist.
 */
export function profileSvg(profile: Strip[], aspect = 2.45): string {
  const total0 = profile.reduce((s, x) => s + x.width, 0);
  const length = Math.max(14, (total0 + 1.2) * aspect);
  const key = JSON.stringify(profile.map((s) => [s.type, s.width, s.dir, s.planting])) + aspect;
  const hit = cache.get(key);
  if (hit) return hit;
  // Straße am Äquator, damit Grad und Meter einfach umrechenbar sind
  const road = { id: 'preview', name: '', smooth: false, profile, points: [[-length / 2 / M, 0], [length / 2 / M, 0]] as [number, number][] };
  const f = buildRoad(road);
  const total = profile.reduce((s, x) => s + x.width, 0);
  // Querschnitt reicht von leftEdge (links, oben im Bild) bis leftEdge − total
  const top = -leftEdge(profile);
  const pad = 0.6;
  const byRank = (a: { properties: any }, b: { properties: any }) => (a.properties?.rank ?? 0) - (b.properties?.rank ?? 0);
  const path = (poly: Polygon) => 'M' + poly.coordinates[0].map(([x, y]) => `${(x * M).toFixed(2)} ${(-y * M).toFixed(2)}`).join('L') + 'Z';
  const layers = [...f.surfaces].sort(byRank).concat(f.markings, [...f.decor].sort(byRank));
  const body = layers.map((ft) => `<path fill="${ft.properties?.color}" d="${path(ft.geometry)}"/>`).join('');
  const svg =
    `<svg xmlns="${SVG}" viewBox="${-length / 2} ${top - pad} ${length} ${total + 2 * pad}" preserveAspectRatio="xMidYMid meet">` +
    `<rect x="${-length / 2}" y="${top - pad}" width="${length}" height="${total + 2 * pad}" fill="#26282b"/>${body}</svg>`;
  cache.set(key, svg);
  return svg;
}

/**
 * Galerie der Vorlagen nach Kategorien. `onPick` erhält den Index in PRESETS.
 * Wird im Andock-Bereich oben links angezeigt.
 */
export function presetPicker(title: string, current: number | null, onPick: (index: number) => void, onClose: () => void): HTMLElement {
  let category: PresetCategory = current !== null ? PRESETS[current].category : 'Wohnen';
  const root = h('div', { class: 'picker' });
  const render = () => {
    const tabs = h(
      'div',
      { class: 'picker-tabs' },
      ...PRESET_CATEGORIES.map((c) =>
        h(
          'button',
          {
            class: c === category ? 'on' : '',
            onclick: () => {
              category = c;
              render();
            },
          },
          c,
        ),
      ),
    );
    const grid = h(
      'div',
      { class: 'picker-grid' },
      ...PRESETS.map((p, i) => ({ p, i }))
        .filter(({ p }) => p.category === category)
        .map(({ p, i }) => {
          const profile = presetProfile(i);
          const width = profile.reduce((s, x) => s + x.width, 0);
          const thumb = h('div', { class: 'thumb' });
          thumb.innerHTML = profileSvg(profile);
          return h(
            'button',
            { class: 'preset' + (i === current ? ' on' : ''), 'data-preset': i, onclick: () => onPick(i) },
            thumb,
            h('span', { class: 'preset-name' }, p.name),
            h('span', { class: 'preset-meta' }, `${profile.length} Streifen · ${fmtM(width)}`),
          );
        }),
    );
    root.replaceChildren(
      h('div', { class: 'picker-head' }, h('span', {}, title), h('button', { class: 'dock-close', title: 'Schließen (Esc)', onclick: onClose }, icon('close', 14))),
      tabs,
      grid,
    );
  };
  render();
  return root;
}
