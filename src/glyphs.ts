/**
 * Vektor-Symbole im Streetcraft-Stil, nachgebaut: Pfeile, Schilder, Ampel, Fahrbahnschrift,
 * Fahrzeuge. Koordinaten in Metern, x = Fahrtrichtung, y = links. Jede Form ist eine Liste
 * gefärbter Polygone, die der Aufrufer an die Straße setzt.
 */
import { add, linePolygons, mul, type Vec } from './geometry';
import type { Turn } from './model';

export interface Shape {
  pts: Vec[];
  color: string;
  /** Zeichenreihenfolge innerhalb der Dekor-Ebene */
  rank?: number;
}

export const WHITE = '#f4f4f0';
const W = 0.18;

const ellipse = (c: Vec, rx: number, ry: number, n = 14): Vec[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [c[0] + rx * Math.cos(a), c[1] + ry * Math.sin(a)] as Vec;
  });

const roundRect = (x0: number, y0: number, x1: number, y1: number, r: number, n = 3): Vec[] => {
  const pts: Vec[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  corner(x1 - r, y0 + r, -Math.PI / 2);
  corner(x1 - r, y1 - r, 0);
  corner(x0 + r, y1 - r, Math.PI / 2);
  corner(x0 + r, y0 + r, Math.PI);
  pts.push(pts[0]);
  return pts;
};

const stroke = (pts: Vec[], color = WHITE, w = W): Shape[] => linePolygons(pts, w).map((p) => ({ pts: p, color }));
const head = (tip: Vec, dir: Vec, len = 1.3, half = 0.45): Shape => {
  const base = add(tip, mul(dir, -len));
  const n: Vec = [-dir[1], dir[0]];
  return { pts: [add(base, mul(n, half)), tip, add(base, mul(n, -half)), add(base, mul(n, half))], color: WHITE };
};

// ---- Pfeile -----------------------------------------------------------------

/** Abbiegepfeil, ca. 5 m lang (Schaft, Bögen, Spitzen) */
export function turnArrow(turn: Turn): Shape[] {
  const out: Shape[] = [];
  const left = turn === 'left' || turn === 'left-straight' || turn === 'left-right' || turn === 'all';
  const right = turn === 'right' || turn === 'right-straight' || turn === 'left-right' || turn === 'all';
  const straight = turn === 'straight' || turn.endsWith('-straight') || turn === 'all';
  const branch = (side: 1 | -1, from: number) => {
    const r = 0.9;
    const pts: Vec[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * (Math.PI / 2);
      pts.push([from + r * Math.sin(a), side * (r - r * Math.cos(a))]);
    }
    out.push(...stroke(pts));
    out.push(head([from + r, side * (r + 1.1)], [0, side]));
  };
  out.push(...stroke([[-2.5, 0], [straight ? 1.2 : -0.2, 0]]));
  if (straight) out.push(head([2.5, 0], [1, 0]));
  const from = straight ? -0.9 : -0.2;
  if (left) branch(1, from);
  if (right) branch(-1, from);
  return out;
}

/**
 * Kreisverkehrspfeil wie bei Streetcraft: Der Schaft führt rechts an einem Punkt (der Insel)
 * vorbei und biegt gegen den Uhrzeigersinn um ihn herum, die Spitze zeigt nach links.
 */
export function roundaboutArrow(): Shape[] {
  const out: Shape[] = [];
  const c: Vec = [0.9, 0.8];
  const r = Math.hypot(0.8, 0.8);
  out.push({ pts: ellipse(c, 0.3, 0.3, 12), color: WHITE });
  const pts: Vec[] = [[-2.5, 0]];
  for (let i = 0; i <= 12; i++) {
    const a = (-135 + (i / 12) * 125) * (Math.PI / 180);
    pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  out.push(...stroke(pts));
  out.push(head([c[0] + r, c[1] + 0.9], [0, 1], 1.0, 0.42));
  return out;
}

// ---- Verkehrszeichen und Ampel (aufgestellt am Fahrbahnrand, Draufsicht-Symbol) -----

const polygon = (n: number, r: number, rot = 0, c: Vec = [0, 0]): Vec[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = rot + (i / n) * 2 * Math.PI;
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as Vec;
  });

/** Zeichen 205 „Vorfahrt gewähren“: rotes Dreieck, Spitze zur Fahrbahn hin */
export const yieldSign = (): Shape[] => [
  { pts: polygon(3, 1.0, Math.PI), color: '#c8262c', rank: 6 },
  { pts: polygon(3, 0.62, Math.PI), color: '#ffffff', rank: 7 },
];

/** Zeichen 206 „Halt. Vorfahrt gewähren“: rotes Achteck mit weißem Rand */
export const stopSign = (): Shape[] => [
  { pts: polygon(8, 0.9, Math.PI / 8), color: '#ffffff', rank: 6 },
  { pts: polygon(8, 0.78, Math.PI / 8), color: '#c8262c', rank: 7 },
  ...linePolygons([[0, -0.4], [0, 0.4]], 0.16).map((p) => ({ pts: p, color: '#ffffff', rank: 8 })),
];

/** Zeichen 306 „Vorfahrtstraße“: gelbe Raute mit weißem Rand */
export const mainSign = (): Shape[] => [
  { pts: polygon(4, 0.95), color: '#ffffff', rank: 6 },
  { pts: polygon(4, 0.62), color: '#f2c230', rank: 7 },
];

/** Ampel: dunkles Gehäuse mit drei Lichtern, Rot oben (vom Fahrer aus gesehen) */
export const trafficLight = (): Shape[] => [
  { pts: roundRect(-1.0, -0.38, 1.0, 0.38, 0.2), color: '#1d1f22', rank: 6 },
  { pts: ellipse([0.6, 0], 0.24, 0.24, 10), color: '#e5383b', rank: 7 },
  { pts: ellipse([0, 0], 0.24, 0.24, 10), color: '#f5b82e', rank: 7 },
  { pts: ellipse([-0.6, 0], 0.24, 0.24, 10), color: '#2fbf71', rank: 7 },
];

/** Haifischzähne (US-Wartelinie) über eine Breite von y0 bis y1 */
export function sharkTeeth(y0: number, y1: number): Shape[] {
  const out: Shape[] = [];
  const n = Math.max(1, Math.floor(Math.abs(y1 - y0) / 0.9));
  const step = (y1 - y0) / n;
  for (let i = 0; i < n; i++) {
    const a = y0 + step * (i + 0.15), b = y0 + step * (i + 0.85);
    out.push({ pts: [[0, a], [0, b], [-0.9, (a + b) / 2], [0, a]], color: WHITE });
  }
  return out;
}

// ---- Fahrbahnschrift (Blockbuchstaben, in Fahrtrichtung gestreckt) -------------

const LETTERS: Record<string, Vec[][]> = {
  B: [[[0, 0], [0, 1], [0.6, 1], [0.75, 0.88], [0.75, 0.62], [0.6, 0.5], [0, 0.5]], [[0.6, 0.5], [0.8, 0.38], [0.8, 0.12], [0.62, 0], [0, 0]]],
  U: [[[0, 1], [0, 0.18], [0.18, 0], [0.62, 0], [0.8, 0.18], [0.8, 1]]],
  S: [[[0.8, 0.88], [0.62, 1], [0.18, 1], [0, 0.85], [0, 0.62], [0.18, 0.5], [0.62, 0.5], [0.8, 0.38], [0.8, 0.15], [0.62, 0], [0.18, 0], [0, 0.12]]],
  T: [[[0, 1], [0.8, 1]], [[0.4, 1], [0.4, 0]]],
  O: [[[0.18, 0], [0.62, 0], [0.8, 0.18], [0.8, 0.82], [0.62, 1], [0.18, 1], [0, 0.82], [0, 0.18], [0.18, 0]]],
  P: [[[0, 0], [0, 1], [0.62, 1], [0.8, 0.85], [0.8, 0.62], [0.62, 0.48], [0, 0.48]]],
  A: [[[0, 0], [0.4, 1], [0.8, 0]], [[0.16, 0.4], [0.64, 0.4]]],
  X: [[[0, 0], [0.8, 1]], [[0, 1], [0.8, 0]]],
  I: [[[0.4, 0], [0.4, 1]]],
};

/**
 * Wort auf der Fahrbahn, für den ankommenden Verkehr lesbar: Buchstaben 1,6 m hoch
 * (in Fahrtrichtung), 0,5 m breit; die erste Zeile liegt dem Fahrer am nächsten.
 */
export function roadText(word: string, height = 1.6, width = 0.55): Shape[] {
  const out: Shape[] = [];
  const total = word.length * width * 1.35;
  [...word].forEach((ch, i) => {
    const strokes = LETTERS[ch];
    if (!strokes) return;
    const y0 = total / 2 - i * width * 1.35;
    for (const s of strokes) {
      // Buchstabenkoordinaten (u nach rechts, v nach oben) → (x = v·Höhe, y = −u·Breite)
      out.push(...stroke(s.map(([u, v]) => [v * height - height / 2, y0 - u * width] as Vec), WHITE, 0.15));
    }
  });
  return out;
}

// ---- Fahrzeuge und Personen (Draufsicht) -------------------------------------

const shadow = (pts: Vec[]): Shape => ({ pts: pts.map(([x, y]) => [x + 0.25, y - 0.25] as Vec), color: 'rgba(0,0,0,0.35)', rank: 1 });

export function bus(color = '#e2e3e4'): Shape[] {
  const body = roundRect(-6, -1.27, 6, 1.27, 0.35);
  return [
    shadow(body),
    { pts: body, color, rank: 2 },
    { pts: roundRect(-5.4, -0.9, 5.2, 0.9, 0.2), color: '#cfd2d6', rank: 3 },
    { pts: roundRect(5.25, -1.1, 5.85, 1.1, 0.15), color: '#26292d', rank: 3 },
    ...[-3.5, 0, 3.5].map((x) => ({ pts: roundRect(x - 0.6, -0.5, x + 0.6, 0.5, 0.1), color: '#b5b9be', rank: 4 })),
  ];
}

/** Stadtbahn-Zug aus drei Wagen (ca. 30 m) */
export function tram(): Shape[] {
  const out: Shape[] = [];
  for (const x of [-10.2, 0, 10.2]) {
    const car = roundRect(x - 4.9, -1.32, x + 4.9, 1.32, 0.4);
    out.push(shadow(car), { pts: car, color: '#e8e9ea', rank: 2 });
    out.push({ pts: roundRect(x - 4.5, -0.55, x + 4.5, 0.55, 0.15), color: '#c3c7cc', rank: 3 });
  }
  out.push({ pts: roundRect(14.6, -1.15, 15.0, 1.15, 0.15), color: '#26292d', rank: 3 });
  out.push({ pts: roundRect(-15.0, -1.15, -14.6, 1.15, 0.15), color: '#26292d', rank: 3 });
  return out;
}

export function cyclist(): Shape[] {
  return [
    ...stroke([[-0.85, 0], [0.85, 0]], '#2b2c2e', 0.08).map((s) => ({ ...s, rank: 2 })),
    ...stroke([[0.55, -0.28], [0.55, 0.28]], '#2b2c2e', 0.07).map((s) => ({ ...s, rank: 2 })),
    { pts: ellipse([-0.05, 0], 0.32, 0.24, 12), color: '#3d6fb6', rank: 3 },
    { pts: ellipse([0.05, 0], 0.13, 0.13, 10), color: '#6b4a32', rank: 4 },
  ];
}

export function pedestrian(color = '#c25b4a'): Shape[] {
  return [
    { pts: ellipse([0.1, -0.1], 0.3, 0.22, 10), color: 'rgba(0,0,0,0.3)', rank: 1 },
    { pts: ellipse([0, 0], 0.18, 0.3, 12), color, rank: 2 },
    { pts: ellipse([0, 0], 0.12, 0.12, 10), color: '#5b4030', rank: 3 },
  ];
}
