import type { Feature, Polygon } from 'geojson';
import { add, cumulativeLength, leftNormal, linePolygons, mul, offsetPolyline, pointAt, type Vec } from './geometry';
import { bus, cyclist, pedestrian, roadText, tram, type Shape } from './glyphs';
import { STRIP_TYPES, type Planting, type Strip } from './model';

/** Details eines Streifens: Pfeile, Parkstände, Autos, Gleise, Bepflanzung. */
export interface DecorOut {
  markings: Feature<Polygon>[];
  decor: Feature<Polygon>[];
}

const CAR_COLORS = ['#e2e3e4', '#e2e3e4', '#c9ccd0', '#2e3033', '#8e959c', '#9b2c2c', '#2c4a7a', '#f1efe9'];
/** Kronenfarben wie in der Streetcraft-Baumpalette: hell- bis dunkelgrün */
const CROWNS = [
  ['#a9c46c', '#7f9c4a'],
  ['#c9dc9f', '#9fb877'],
  ['#5f8a4f', '#3f6435'],
  ['#86a06d', '#5e7a4b'],
  ['#7a9a7e', '#506e57'],
];
const FLOWER_COLORS = ['#f2c94c', '#eb7a52', '#f4a6c1', '#ffffff', '#b48ee0', '#e8505b'];

/** Deterministischer Zufall je Schlüssel — gleiche Straße, gleiche Bäume. */
function rand(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

type Push = (pts: Vec[], color: string, rank: number) => void;

/** Baumkrone mit welligem Rand, Blattstruktur und Schatten (Draufsicht) */
export function tree(push: Push, c: Vec, r: number, rnd: () => number) {
  const [base, dark] = CROWNS[Math.floor(rnd() * CROWNS.length)];
  const ph = rnd() * 6.28, k = 7 + Math.floor(rnd() * 4);
  const crown: Vec[] = [];
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * 2 * Math.PI;
    const q = r * (1 + 0.05 * Math.sin(k * a + ph) + 0.03 * (rnd() - 0.5));
    crown.push([c[0] + q * Math.cos(a), c[1] + q * Math.sin(a)]);
  }
  crown.push(crown[0]);
  push(circle(add(c, [r * 0.18, -r * 0.18]), r * 1.04, 20), 'rgba(0,0,0,0.3)', 1);
  push(crown, base, 4);
  // Blattbüschel
  const tufts = 6 + Math.floor(rnd() * 4);
  for (let i = 0; i < tufts; i++) {
    const a = rnd() * 2 * Math.PI, d = r * (0.2 + rnd() * 0.55);
    push(circle([c[0] + d * Math.cos(a), c[1] + d * Math.sin(a)], r * (0.12 + rnd() * 0.1), 7), dark, 5);
  }
}

export function circle(c: Vec, r: number, n = 12): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}

/** Lokaler Rahmen an Bogenlänge s: Punkt, Längs- und Querrichtung */
function frame(line: Vec[], s: number) {
  const { p, t } = pointAt(line, s);
  return { p, t, n: leftNormal(t) };
}

/** Form in Fahrzeug-/Pfeilkoordinaten (x längs, y quer) an die Linie setzen */
function place(line: Vec[], s: number, shape: Vec[], flip = false): Vec[] {
  const f = frame(line, s);
  const k = flip ? -1 : 1;
  const ring = shape.map(([x, y]) => add(add(f.p, mul(f.t, x * k)), mul(f.n, y * k)));
  return [...ring, ring[0]];
}

const ARROW: Vec[] = [
  [-2.5, -0.09], [0.7, -0.09], [0.7, -0.45], [2.5, 0], [0.7, 0.45], [0.7, 0.09], [-2.5, 0.09],
];

function carShape(len: number, wid: number): { body: Vec[]; glass: Vec[] } {
  const [x, y] = [len / 2, wid / 2];
  const round = (cx: number, cy: number, rx: number, ry: number, a0: number, n = 4): Vec[] =>
    Array.from({ length: n + 1 }, (_, i) => {
      const a = a0 + (i / n) * (Math.PI / 2);
      return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Vec;
    });
  // Front (+x) stärker gerundet als das Heck
  const body: Vec[] = [
    ...round(x - 0.55, -y + 0.35, 0.55, 0.35, -Math.PI / 2),
    ...round(x - 0.55, y - 0.35, 0.55, 0.35, 0),
    ...round(-x + 0.3, y - 0.3, 0.3, 0.3, Math.PI / 2),
    ...round(-x + 0.3, -y + 0.3, 0.3, 0.3, Math.PI),
  ];
  // dunkles Glasdach (Frontscheibe bis Heckscheibe)
  const glass: Vec[] = [
    [x * 0.42, -y * 0.78], [x * 0.5, -y * 0.55], [x * 0.5, y * 0.55], [x * 0.42, y * 0.78],
    [-x * 0.55, y * 0.8], [-x * 0.68, y * 0.6], [-x * 0.68, -y * 0.6], [-x * 0.55, -y * 0.8],
  ];
  return { body, glass };
}

/** Fahrradpiktogramm (Seitenansicht, liegt in Fahrtrichtung) als Linienzüge */
const BIKE: Vec[][] = (() => {
  const wheel = (cx: number) =>
    Array.from({ length: 17 }, (_, i) => [cx + 0.32 * Math.cos((i / 16) * 2 * Math.PI), 0.32 + 0.32 * Math.sin((i / 16) * 2 * Math.PI)] as Vec);
  const frame: Vec[][] = [
    [[-0.55, 0.32], [-0.05, 0.32], [0.4, 0.82], [-0.2, 0.82], [-0.55, 0.32]],
    [[-0.05, 0.32], [-0.25, 0.95]],
    [[-0.38, 0.95], [-0.12, 0.95]],
    [[0.4, 0.82], [0.55, 0.32]],
    [[0.4, 0.82], [0.3, 1.0], [0.48, 1.02]],
  ];
  // (u, v) Seitenansicht → (x längs, y quer): oben = Fahrtrichtung
  return [wheel(-0.55), wheel(0.55), ...frame].map((l) => l.map(([u, v]) => [v * 1.3 - 0.7, -u * 1.3] as Vec));
})();

export { rand };


export function stripDecor(
  roadId: string,
  strip: Strip,
  left: number,
  right: number,
  center: Vec[],
  ring: (pts: Vec[]) => number[][],
  phase: number,
  keepOut: [number, number],
  out: DecorOut,
  traffic = false,
) {
  const mid = (left + right) / 2;
  const w = left - right;
  const line = offsetPolyline(center, mid);
  const L = cumulativeLength(line).at(-1) ?? 0;
  if (L < 1) return;
  const push = (to: Feature<Polygon>[], pts: Vec[], color: string, rank = 0) =>
    to.push({ type: 'Feature', properties: { roadId, color, rank }, geometry: { type: 'Polygon', coordinates: [ring(pts)] } });
  /** globale Positionen (über Teilstücke hinweg stabil) im lokalen Bereich [a, b] */
  const positions = (spacing: number, offset: number, a: number, b: number) => {
    const res: { s: number; k: number }[] = [];
    for (let k = Math.ceil((phase + a - offset) / spacing); ; k++) {
      const s = offset + k * spacing - phase;
      if (s > b) break;
      if (s >= a) res.push({ s, k });
    }
    return res;
  };

  /** Formen an Bogenlänge s setzen; k = −1 dreht sie gegen die Zeichenrichtung */
  const placeShapes = (s: number, shapes: Shape[], k: number, to: Feature<Polygon>[]) => {
    const f = frame(line, s);
    for (const sh of shapes) push(to, sh.pts.map(([x, y]) => add(add(f.p, mul(f.t, x * k)), mul(f.n, y * k))), sh.color, sh.rank ?? 0);
  };
  if (traffic) {
    const k = strip.dir === -1 ? -1 : 1;
    const a = keepOut[0] + 6, b = L - keepOut[1] - 6;
    const spots = (spacing: number, salt: string, p: number) =>
      positions(spacing, 0, a, b).filter(({ k: i }) => rand(`${strip.id}:${salt}${i}`)() < p);
    if (strip.type === 'drive') {
      for (const { s, k: i } of spots(28, 'v', 0.45)) {
        const rnd = rand(`${strip.id}:c${i}`);
        const { body, glass } = carShape(4.4 + rnd() * 0.4, 1.85);
        const sh: Shape[] = [
          { pts: body.map(([x, y]) => [x + 0.25, y - 0.25] as Vec), color: 'rgba(0,0,0,0.35)', rank: 1 },
          { pts: body, color: CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)], rank: 2 },
          { pts: glass, color: '#26292d', rank: 3 },
        ];
        placeShapes(s, sh, k, out.decor);
      }
    } else if (strip.type === 'bus') {
      for (const { s } of spots(70, 'b', 0.5)) placeShapes(s, bus('#d9443b'), k, out.decor);
    } else if (strip.type === 'tram') {
      for (const { s } of spots(160, 't', 0.6)) placeShapes(s, tram(), k, out.decor);
    } else if (strip.type === 'bike') {
      for (const { s } of spots(18, 'r', 0.4)) placeShapes(s, cyclist(), k, out.decor);
    } else if (strip.type === 'sidewalk') {
      const colors = ['#c25b4a', '#3d6fb6', '#e3b341', '#4a8c5c', '#7d5ba6', '#2b2c2e'];
      for (const { s, k: i } of spots(9, 'p', 0.35)) {
        const rnd = rand(`${strip.id}:q${i}`);
        const f = frame(line, s);
        const c = add(f.p, mul(f.n, (rnd() - 0.5) * Math.max(0, w - 1)));
        const dirK = rnd() > 0.5 ? 1 : -1;
        for (const sh of pedestrian(colors[Math.floor(rnd() * colors.length)])) {
          push(out.decor, sh.pts.map(([x, y]) => add(add(c, mul(f.t, x * dirK)), mul(f.n, y * dirK))), sh.color, sh.rank ?? 0);
        }
      }
    }
  }

  switch (strip.type) {
    case 'drive':
    case 'bus':
    case 'bike': {
      // Richtungspfeile — Abstand zu Kreuzungen, dort zeichnet die Kreuzung ihre Abbiegepfeile
      const scale = strip.type === 'bike' ? 0.45 : 1;
      const a = keepOut[0] > 0 ? keepOut[0] + 30 : 4, b = L - (keepOut[1] > 0 ? keepOut[1] + 30 : 4);
      let at = positions(60, 25, a, b).map((p) => p.s);
      if (strip.type === 'bus') {
        // „BUS“ auf der Fahrbahn, in Fahrtrichtung lesbar, 8 m hinter jedem Pfeil
        const k = strip.dir === -1 ? -1 : 1;
        for (const s of at) placeShapes(s - 8 * k, roadText('BUS'), k, out.markings);
      }
      if (!at.length && b - a > 2) at = [(a + b) / 2];
      const shape = ARROW.map(([x, y]) => [x * scale, y * scale] as Vec);
      for (const s of at) {
        if (strip.type === 'bike') {
          // Fahrradsymbol mit Pfeil davor
          const k = strip.dir === -1 ? -1 : 1;
          const f = frame(line, s);
          for (const l of BIKE) {
            const pts = l.map(([x, y]) => add(add(f.p, mul(f.t, x * k)), mul(f.n, y * k)));
            for (const poly of linePolygons(pts, 0.08)) push(out.markings, poly, '#f4f4f0');
          }
          push(out.markings, place(line, s + 1.9 * k, shape, strip.dir === -1), '#f4f4f0');
        } else push(out.markings, place(line, s, shape, strip.dir === -1), '#f4f4f0');
      }
      break;
    }
    case 'parking': {
      // Parkstände (5,75 m) mit Trennmarkierung und geparkten Autos
      const bay = 5.75;
      const r = (k: number) => rand(`${strip.id}:${k}`);
      // vor Kreuzungen und Querungen 5 m frei (StVO)
      const a = keepOut[0] > 0 ? keepOut[0] + 5 : 0.3;
      const b = L - (keepOut[1] > 0 ? keepOut[1] + 5 : 0.3);
      for (const { s } of positions(bay, 0, a, b)) {
        push(out.markings, place(line, s, [[-0.05, -w / 2], [0.05, -w / 2], [0.05, w / 2], [-0.05, w / 2]]), '#e6e4dc');
      }
      const facing = mid > 0; // links der Mittellinie fährt der Verkehr entgegen
      for (const { s, k } of positions(bay, bay / 2, a + 2.1, b - 2.1)) {
        const rnd = r(k);
        if (rnd() > 0.68) continue;
        const { body, glass } = carShape(4.3 + rnd() * 0.5, Math.min(1.85, w - 0.2));
        const shadow = place(line, s, body, facing).map((p) => add(p, [0.25, -0.25]));
        push(out.decor, shadow, 'rgba(0,0,0,0.35)', 1);
        push(out.decor, place(line, s, body, facing), CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)], 2);
        push(out.decor, place(line, s, glass, facing), '#26292d', 3);
      }
      break;
    }
    case 'tram': {
      // zwei Schienen (Normalspur 1435 mm) auf grauem Gleisbett
      for (const o of [-0.7175, 0.7175]) {
        for (const poly of linePolygons(offsetPolyline(line, o), 0.14)) push(out.markings, poly, '#696967');
      }
      break;
    }
    case 'green':
    case 'median': {
      const planting: Planting | undefined = strip.planting ?? (strip.type === 'green' ? 'trees' : undefined);
      if (!planting || planting === 'lawn') break;
      const a = keepOut[0] + 1, b = L - keepOut[1] - 1;
      const treeAt = (s: number, rnd: () => number) => {
        const f = frame(line, s + (rnd() - 0.5) * 2);
        const r = Math.min(3.4, Math.max(2.2, w * 0.95)) * (0.8 + rnd() * 0.35);
        tree((pts, color, rank) => push(out.decor, pts, color, rank), f.p, r, rnd);
      };
      const bush = (s: number, rnd: () => number) => {
        const lat = (rnd() - 0.5) * Math.max(0, w - 2.2);
        const f = frame(line, s);
        const r = 0.7 + rnd() * 0.4;
        const c = add(f.p, mul(f.n, lat));
        push(out.decor, circle(add(c, [0.2, -0.2]), r, 10), 'rgba(0,0,0,0.25)', 1);
        push(out.decor, circle(c, r, 10), rnd() > 0.5 ? '#7f9c4a' : '#a9c46c', 3);
      };
      if (planting === 'trees' || planting === 'mixed') {
        const spacing = planting === 'trees' ? 11 : 16;
        for (const { s, k } of positions(spacing, spacing / 2, a, b)) treeAt(s, rand(`${strip.id}:t${k}`));
      }
      if (planting === 'bushes' || planting === 'mixed') {
        for (const { s, k } of positions(2.4, 0, a, b)) {
          if (planting === 'mixed' && Math.abs((((s + phase - 8) % 16) + 16) % 16 - 8) > 5) continue;
          bush(s, rand(`${strip.id}:b${k}`));
        }
      }
      if (planting === 'flowers') {
        const rows = Math.max(1, Math.floor((w - 0.4) / 0.5));
        for (const { s, k } of positions(0.55, 0, a, b)) {
          const rnd = rand(`${strip.id}:f${k}`);
          const f = frame(line, s);
          for (let j = 0; j < rows; j++) {
            if (rnd() < 0.3) continue;
            const lat = (j - (rows - 1) / 2) * 0.5 + (rnd() - 0.5) * 0.2;
            const color = FLOWER_COLORS[Math.floor(rnd() * FLOWER_COLORS.length)];
            push(out.decor, circle(add(f.p, mul(f.n, lat)), 0.14 + rnd() * 0.08, 6), color, 3);
          }
        }
      }
      break;
    }
  }
}

/** Grundfarbe eines Streifens — bepflanzte Mittelinseln werden grün */
export function stripColor(strip: Strip) {
  if (strip.type === 'median' && strip.planting) return STRIP_TYPES.green.color;
  return STRIP_TYPES[strip.type].color;
}
