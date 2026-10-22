import type { Feature, Polygon } from 'geojson';
import { circle, rand, tree } from './decor';
import {
  add,
  band,
  dedupe,
  intersectLines,
  leftNormal,
  linePolygons,
  localProjection,
  mul,
  offsetPolyline,
  pointAt,
  slicePolyline,
  type Vec,
} from './geometry';
import { fitToLane, mainSign, roundaboutArrow, sharkTeeth, stopSign, trafficLight, turnArrow, yieldSign, zebraSign, type Shape } from './glyphs';
import {
  STRIP_TYPES,
  controlOf,
  leftEdge,
  type ArmRole,
  type JunctionSettings,
  type LngLat,
  type MarkingStyle,
  type Strip,
  type StripType,
  type Turn,
} from './model';

const ARM_LOOKAHEAD = 80;
const DEG = Math.PI / 180;
const WHITE = '#f4f4f0';
const YELLOW = '#f2c230';
const CURB = '#ece4d8';
/** Länge einer Fußgängerquerung in Fahrtrichtung (m) */
const CROSSING_LEN = 4;

/** Ein Straßenarm, vom Knoten weg gesehen. Offsets: + = links. */
export interface ArmInput {
  segId: string;
  roadId: string;
  /** stabile Arm-ID: Straße + Richtung, in die sie den Knoten verlässt (f = Zeichenrichtung) */
  armId: string;
  /** Mittellinie vom Knoten weg, in Längen/Breitengraden */
  pts: LngLat[];
  /** Querschnitt in Zeichenrichtung des Segments */
  profile: Strip[];
  /** true = Segment beginnt am Knoten (Zeichenrichtung = vom Knoten weg) */
  atStart: boolean;
  /** größter zulässiger Rückschnitt (kurze Arme zwischen zwei Knoten) */
  maxTrim?: number;
  /** Arm endet auch am anderen Ende an einem Knoten */
  both?: boolean;
  /** Gesamtlänge des Arms bis zum nächsten Knoten/Ende */
  length?: number;
  /** Länge ab Knoten mit gleichbleibendem Querschnitt (Pfeile nur dort) */
  uniform?: number;
  /** Fingerabdruck des Arms (Geometrie + Querschnitt) für den Zwischenspeicher */
  sig?: string;
}

interface ArmStrip {
  id: string;
  turn?: Turn;
  type: StripType;
  l: number;
  r: number;
  /** 1 = vom Knoten weg, -1 = zum Knoten hin */
  dir: 1 | -1;
}

interface Arm extends ArmInput {
  local: Vec[];
  len: number;
  d: Vec;
  n: Vec;
  ang: number;
  strips: ArmStrip[];
  hasCw: boolean;
  /** Fahrbahnkanten */
  cL: number;
  cR: number;
  /** Seitenstreifen von der Fahrbahnkante nach außen */
  left: ArmStrip[];
  right: ArmStrip[];
  trim: number;
}

interface Boundary {
  offA: number;
  offB: number;
  mid: Vec[];
}

interface Corner {
  a: Arm;
  b: Arm;
  bounds: Boundary[];
  types: StripType[];
  /** Breite je Streifen am Arm a bzw. b (0 = gibt es dort nicht) */
  wa: number[];
  wb: number[];
}

export type Move = 'left' | 'straight' | 'right';

/** Daten für den Kreuzungseditor (Spurverbindungen wie im Traffic Manager) */
export interface JunctionInfo {
  arms: { armId: string; roadId: string; ang: number }[];
  /** Fahrstreifen-Enden am Kreuzungsrand (bike = Radstreifen) */
  lanes: { id: string; armId: string; kind: 'in' | 'out'; bike: boolean; pos: LngLat; stop?: LngLat }[];
  links: { from: string; to: string; move: Move; bike: boolean; pts: LngLat[] }[];
}

export interface JunctionResult {
  info: JunctionInfo;
  surfaces: Feature<Polygon>[];
  markings: Feature<Polygon>[];
  decor: Feature<Polygon>[];
  /** Rückschnitt und markierungsfreie Länge je Zug-Ende */
  trims: { segId: string; atStart: boolean; trim: number; keepOut: number; median: number }[];
}

function makeArm(input: ArmInput, toLocal: (p: LngLat) => Vec): Arm | null {
  const local = dedupe(input.pts.map(toLocal));
  if (local.length < 2) return null;
  let len = 0;
  for (let i = 1; i < local.length; i++) len += Math.hypot(local[i][0] - local[i - 1][0], local[i][1] - local[i - 1][1]);
  // Richtung als Sehne über die ersten 12 m — passt auch bei gekrümmten Armen zur Ecke
  const probe = pointAt(local, Math.min(12, len)).p;
  const pl = Math.hypot(probe[0] - local[0][0], probe[1] - local[0][1]) || 1;
  const d: Vec = [(probe[0] - local[0][0]) / pl, (probe[1] - local[0][1]) / pl];

  let left = leftEdge(input.profile);
  let strips: ArmStrip[] = input.profile.map((s) => {
    const st: ArmStrip = { id: s.id, turn: s.turn, type: s.type, l: left, r: left - s.width, dir: s.dir };
    left -= s.width;
    return st;
  });
  if (!input.atStart) {
    strips = strips.reverse().map((s) => ({ ...s, l: -s.r, r: -s.l, dir: -s.dir as 1 | -1 }));
  }
  // Fahrbahn = Fahrstreifen samt direkt anliegender Rad- und Parkstreifen. Ein Radweg hinter
  // Gehweg oder Grün (Hochbordradweg) ist Seitenraum und läuft mit um die Ecke.
  const core = strips.map((s, i) => (s.type === 'drive' || s.type === 'bus' || s.type === 'tram' ? i : -1)).filter((i) => i >= 0);
  const cwIdx = core.length ? core : strips.map((s, i) => (STRIP_TYPES[s.type].carriageway ? i : -1)).filter((i) => i >= 0);
  const hasCw = cwIdx.length > 0;
  let first = hasCw ? cwIdx[0] : 0;
  let last = hasCw ? cwIdx[cwIdx.length - 1] : strips.length - 1;
  if (core.length) {
    while (first > 0 && STRIP_TYPES[strips[first - 1].type].carriageway) first--;
    while (last < strips.length - 1 && STRIP_TYPES[strips[last + 1].type].carriageway) last++;
  }

  return {
    ...input,
    local,
    len,
    d,
    n: leftNormal(d),
    ang: Math.atan2(d[1], d[0]),
    strips,
    hasCw,
    cL: strips[first].l,
    cR: strips[last].r,
    left: hasCw ? strips.slice(0, first).reverse() : [],
    right: hasCw ? strips.slice(last + 1) : [],
    trim: 0.5,
  };
}

function arcPoints(c: Vec, r: number, a0: number, sweep: number, r1 = r): Vec[] {
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (4 * DEG)));
  const out: Vec[] = [];
  for (let k = 0; k <= steps; k++) {
    const w = a0 + (sweep * k) / steps;
    const rr = r + ((r1 - r) * k) / steps;
    out.push([c[0] + rr * Math.cos(w), c[1] + rr * Math.sin(w)]);
  }
  return out;
}

/** Bogenlänge des Fußpunkts von p auf der (gekrümmten) Armlinie */
function projS(x: { local: Vec[] }, p: Vec): number {
  let best = 0, bd = Infinity, acc = 0;
  for (let i = 1; i < x.local.length; i++) {
    const a = x.local[i - 1], b = x.local[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    const d = Math.hypot(a[0] + dx * u - p[0], a[1] + dy * u - p[1]);
    if (d < bd) [bd, best] = [d, acc + u * Math.sqrt(l2)];
    acc += Math.sqrt(l2);
  }
  return best;
}

/** Konvexe Hülle (Monotone Chain), gegen den Uhrzeigersinn */
function convexHull(pts: Vec[]): Vec[] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec, a: Vec, b: Vec) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Vec[]) => {
    const h: Vec[] = [];
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half(p.slice().reverse())];
}

const shortSweep = (a0: number, a1: number) => {
  let s = a1 - a0;
  while (s > Math.PI) s -= 2 * Math.PI;
  while (s <= -Math.PI) s += 2 * Math.PI;
  return s;
};
const angleOf = (v: Vec, c: Vec = [0, 0]) => Math.atan2(v[1] - c[1], v[0] - c[0]);

/** Kreisbogen (Radius r), der die linke Kante von a mit der rechten Kante von b verbindet. */
function fillet(a: Arm, offA: number, b: Arm, offB: number, r: number) {
  const hit = intersectLines(mul(a.n, offA + r), a.d, mul(b.n, offB - r), b.d);
  if (!hit || hit[0] < 0 || hit[1] < 0) return null;
  const [s, t] = hit;
  const c = add(mul(a.d, s), mul(a.n, offA + r));
  const ta = add(mul(a.d, s), mul(a.n, offA));
  const tb = add(mul(b.d, t), mul(b.n, offB));
  const a0 = angleOf(ta, c);
  return { s, t, arc: arcPoints(c, r, a0, shortSweep(a0, angleOf(tb, c))) };
}

/**
 * Ausrundung zwischen einer Armkante (Offset `off`, Seite sigma = +1 links / −1 rechts)
 * und dem Kreis mit Radius `R` um den Knoten. Liefert die Punkte von der Kante zum Kreis.
 */
function circleFillet(arm: Arm, off: number, sigma: 1 | -1, R: number, rf: number) {
  const oc = off + sigma * rf;
  const h = (R + rf) ** 2 - oc ** 2;
  if (h <= 0) return null;
  const s = Math.sqrt(h);
  const c = add(mul(arm.d, s), mul(arm.n, oc));
  const t1 = add(mul(arm.d, s), mul(arm.n, off));
  const t2 = mul(c, R / (R + rf));
  const a0 = angleOf(t1, c);
  return { s, pts: arcPoints(c, rf, a0, shortSweep(a0, angleOf(t2, c))), end: t2 };
}

/** Seitenstreifen beider Seiten passend zusammenführen. */
/**
 * Seitenstreifen beider Arme um die Ecke zusammenführen. Zugeordnet wird von außen nach innen
 * (gleiche Typen gehen ineinander über); was nur auf einer Seite existiert, läuft um die Ecke
 * auf null aus — z. B. ein Grünstreifen, der an der Querstraße endet.
 */
function sideLayout(A: ArmStrip[], B: ArmStrip[]) {
  const a = A.slice().reverse(), b = B.slice().reverse();
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i].type === b[j].type ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const w = (x: ArmStrip) => x.l - x.r;
  const rows: { type: StripType; wa: number; wb: number }[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i].type === b[j].type) rows.push({ type: a[i].type, wa: w(a[i++]), wb: w(b[j++]) });
    else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) rows.push({ type: a[i].type, wa: w(a[i++]), wb: 0 });
    else rows.push({ type: b[j].type, wa: 0, wb: w(b[j++]) });
  }
  rows.reverse();
  return { types: rows.map((r) => r.type), wa: rows.map((r) => r.wa), wb: rows.map((r) => r.wb) };
}

export function buildJunction(
  key: string,
  node: LngLat,
  inputs: ArmInput[],
  st: JunctionSettings,
  style: MarkingStyle = 'de',
): JunctionResult {
  const proj = localProjection(node);
  const arms = inputs
    .map((i) => makeArm(i, proj.fwd))
    .filter((a): a is Arm => !!a)
    .sort((x, y) => x.ang - y.ang);
  const res: JunctionResult = { info: { arms: [], lanes: [], links: [] }, surfaces: [], markings: [], decor: [], trims: [] };
  if (arms.length < 2) return res;
  const roundabout = st.kind !== 'cross' && arms.every((a) => a.hasCw);
  const mini = roundabout && st.kind === 'mini';
  const R = st.rbRadius;
  const crossingOf = (x: { armId: string }) => st.armCrossing?.[x.armId] ?? st.crossing;

  // 1. Ecken: Ausrundungen je Kante, daraus die Rückschnitte der Arme
  const corners: Corner[] = arms.map((a, i) => {
    const b = arms[(i + 1) % arms.length];
    let gap = b.ang - a.ang;
    if (gap <= 0) gap += 2 * Math.PI;
    const { types, wa, wb } = sideLayout(a.left, b.right);
    const radius = a.hasCw && b.hasCw ? st.radius : 1.5;
    const bounds: Boundary[] = [];
    let da = 0, db = 0;
    for (let k = 0; k <= types.length; k++) {
      const offA = a.cL + da, offB = b.cR - db;
      const r = Math.max(radius - (da + db) / 2, 0.75);
      let mid: Vec[] = [];
      if (roundabout) {
        const fa = circleFillet(a, offA, 1, R + da, r);
        const fb = circleFillet(b, offB, -1, R + db, r);
        if (fa && fb) {
          const a0 = angleOf(fa.end);
          let sweep = angleOf(fb.end) - a0;
          while (sweep < 0) sweep += 2 * Math.PI;
          // Ausrundungen überlappen (Arme zu dicht) → ohne Kreisstück verbinden
          const ring = sweep < Math.min(gap + 0.5, 2 * Math.PI - 0.05) ? arcPoints([0, 0], R + da, a0, sweep, R + db) : [];
          mid = [...fa.pts, ...ring, ...fb.pts.slice().reverse()];
          a.trim = Math.max(a.trim, fa.s + 0.5);
          b.trim = Math.max(b.trim, fb.s + 0.5);
        }
      } else if (gap < 175 * DEG) {
        let f = fillet(a, offA, b, offB, r);
        for (let rr = r * 0.7; f && (f.s > (a.maxTrim ?? Infinity) || f.t > (b.maxTrim ?? Infinity)) && rr >= 0.4; rr *= 0.7) {
          f = fillet(a, offA, b, offB, rr);
        }
        if (f) {
          mid = f.arc;
          a.trim = Math.max(a.trim, f.s);
          b.trim = Math.max(b.trim, f.t);
        }
      } else if (gap > 185 * DEG) {
        // Außenseite eines Knicks: Gehrung statt Ausrundung
        const hit = intersectLines(mul(a.n, offA), a.d, mul(b.n, offB), b.d);
        if (hit && Math.abs(hit[0]) < 30 && Math.abs(hit[1]) < 30) mid = [add(mul(a.d, hit[0]), mul(a.n, offA))];
      }
      bounds.push({ offA, offB, mid });
      da += wa[k] ?? 0;
      db += wb[k] ?? 0;
    }
    return { a, b, bounds, types, wa, wb };
  });

  for (const a of arms) {
    if (roundabout) a.trim = Math.max(a.trim, R + 1);
    a.trim = Math.min(a.trim, Math.max(0, a.len - 0.3), a.maxTrim ?? Infinity, ARM_LOOKAHEAD - 1);
  }
  /**
   * Bis wohin (Bogenlänge ab Knoten) dieser Knoten Elemente auf einen Arm setzen darf: Liegt am
   * anderen Ende ein weiterer Knoten, gehört jedem die Hälfte. Was nicht passt, wird verkürzt oder entfällt.
   */
  const reach = (x: Arm) => Math.min(x.len, x.both ? (x.length ?? x.len) / 2 : x.length ?? x.len);

  // 2. Flächen
  const ends = new Map(
    arms.map((a) => {
      const { p, t } = pointAt(a.local, a.trim);
      const n = leftNormal(t);
      return [a, (off: number) => add(p, mul(n, off))] as const;
    }),
  );
  const at = (a: Arm, off: number) => ends.get(a)!(off);
  /** Punkt auf dem Arm bei Bogenlänge s und Querversatz off */
  const atS = (a: Arm, s: number, off: number) => {
    const { p, t } = pointAt(a.local, s);
    return add(p, mul(leftNormal(t), off));
  };
  const ring = (pts: Vec[]) => {
    const r = dedupe(pts, 0.01).map(proj.inv);
    return [...r, r[0]];
  };
  /** kind: Art des Elements (für Prüfungen und Auswahl), z. B. zebra, stopline, arrow, sign, asphalt oder Streifentyp */
  const push = (to: Feature<Polygon>[], pts: Vec[], color: string, rank = 0, kind?: string) => {
    // Flächen ohne Inhalt (alle Punkte auf einer Linie) nicht ausgeben
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [p, q] = [pts[i], pts[(i + 1) % pts.length]];
      a += p[0] * q[1] - q[0] * p[1];
    }
    if (Math.abs(a) < 0.02) return;
    to.push({ type: 'Feature', properties: { node: key, color, rank, ...(kind ? { kind } : {}) }, geometry: { type: 'Polygon', coordinates: [ring(pts)] } });
  };
  const anyCw = arms.some((a) => a.hasCw);

  const asphalt: Vec[] = [];
  /** Ausrundung auf den tatsächlichen Rückschnitt begrenzen: Punkte jenseits davon würden die Ecke falten */
  const clip = (c: Corner, mid: Vec[]) => mid.filter((p) => projS(c.a, p) <= c.a.trim + 0.01 && projS(c.b, p) <= c.b.trim + 0.01);
  for (const c of corners) asphalt.push(at(c.a, c.a.cR), at(c.a, c.a.cL), ...clip(c, c.bounds[0].mid));
  // Nur Fußwege (Fußgängerzone, Platz): Hülle der Armenden — Ausrundungen zwischen schräg
  // einmündenden Wegen würden die Fläche sonst falten
  push(res.surfaces, anyCw ? asphalt : convexHull(asphalt), anyCw ? STRIP_TYPES.drive.color : STRIP_TYPES.sidewalk.color, 5, anyCw ? 'asphalt' : 'sidewalk');

  for (const c of corners) {
    const paths = c.bounds.map((bd) => [at(c.a, bd.offA), ...clip(c, bd.mid), at(c.b, bd.offB)]);
    /**
     * Streifen, den es nur auf einer Seite der Ecke gibt (Gehweg an der einen Straße, an der
     * anderen nicht): endet in der Mitte des Eckbogens. Liefe er bis zum Rückschnitt des anderen
     * Arms aus, entstünde bei spitzen Ecken ein langer Keil neben dessen Fahrbahn.
     */
    const half = (k: number, side: 'a' | 'b') => {
      const mid = clip(c, c.bounds[k].mid);
      const m = Math.ceil(mid.length / 2);
      return side === 'a' ? [at(c.a, c.bounds[k].offA), ...mid.slice(0, m)] : [...mid.slice(m - 1), at(c.b, c.bounds[k].offB)];
    };
    c.types.forEach((type, k) => {
      const color = type === 'median' ? STRIP_TYPES.sidewalk.color : STRIP_TYPES[type].color;
      // auch wenn eine der Ausrundungen fehlt (Bogenmitte läge hinter dem Knoten): dann endet der
      // Streifen an der Armkante, statt bis zum Rückschnitt des anderen Arms auszulaufen
      const oneSided = (c.wa[k] === 0 || c.wb[k] === 0) && (c.bounds[k].mid.length > 1 || c.bounds[k + 1].mid.length > 1);
      const side = c.wb[k] === 0 ? 'a' : 'b';
      const poly = oneSided ? [...half(k, side), ...half(k + 1, side).reverse()] : [...paths[k], ...paths[k + 1].slice().reverse()];
      push(res.surfaces, poly, color, STRIP_TYPES[type].rank, type === 'median' ? 'sidewalk' : type);
    });
    if (c.types.length && anyCw) {
      for (const poly of linePolygons(dedupe(paths[0], 0.01), 0.2)) push(res.markings, poly, CURB);
    }
  }

  /** Fahrbahnteiler je Arm (Querversatz): Markierungen werden dort unterbrochen, er dient als Querungsinsel */
  const splitOf = new Map<Arm, { lo: number; hi: number }>();
  /** Querintervall [lo, hi] ohne den Fahrbahnteiler des Arms */
  const outsideSplit = (x: Arm, lo: number, hi: number): [number, number][] => {
    const g = splitOf.get(x);
    if (!g || g.hi <= lo || g.lo >= hi) return [[lo, hi]];
    return ([[lo, g.lo], [g.hi, hi]] as [number, number][]).filter(([p, q]) => q - p > 0.3);
  };

  // 3. Kreisverkehr: überfahrbarer Innenring, bepflanzte Mittelinsel, Fahrbahnteiler
  if (roundabout) {
    const apron = R - st.rbLane;
    const island = mini ? 0 : apron - 1.8;
    const ringLine = style === 'us' ? YELLOW : CURB;
    if (mini) {
      // überfahrbare, aufgemalte Mittelinsel
      const r = Math.max(1.5, apron);
      push(res.surfaces, circle([0, 0], r, 48), '#e9e4d8', 6, 'island');
      for (const poly of linePolygons(circle([0, 0], r, 48), 0.2)) push(res.markings, poly, WHITE);
    } else if (apron > 1) {
      push(res.surfaces, circle([0, 0], apron, 64), STRIP_TYPES.sidewalk.color, 6, 'island');
      for (const poly of linePolygons(circle([0, 0], apron + 0.25, 64), 0.12)) push(res.markings, poly, ringLine);
    }
    if (island > 1) {
      push(res.surfaces, circle([0, 0], island, 64), STRIP_TYPES.green.color, 7, 'green');
      const rnd = rand(key);
      const pushDecor = (pts: Vec[], color: string, rank: number) => push(res.decor, pts, color, rank);
      const big = Math.min(3.5, island * 0.45);
      tree(pushDecor, [island * 0.12, island * 0.15], big, rnd);
      if (island > 5) {
        const n = 3 + Math.floor(rnd() * 2);
        for (let i = 0; i < n; i++) {
          const w = (i / n) * 2 * Math.PI + rnd();
          const d = island * 0.55;
          tree(pushDecor, [d * Math.cos(w), d * Math.sin(w)], Math.min(2.2, island * 0.25) * (0.8 + rnd() * 0.4), rnd);
        }
      }
    }
    if ((st.rbLanes ?? 1) === 2) {
      // zweistreifiger Kreis: Leitlinie zwischen den Fahrstreifen
      for (const poly of linePolygons(circle([0, 0], R - st.rbLane / 2, 96), 0.12, [3, 3])) push(res.markings, poly, WHITE);
    }
    // Fahrbahnteiler: sandfarbene Keile zwischen Zu- und Ausfahrt (nicht beim Mini-Kreisel)
    for (const a of mini ? [] : arms) {
      const lanes = a.strips.filter((s) => STRIP_TYPES[s.type].carriageway && STRIP_TYPES[s.type].directional);
      const split = lanes.findIndex((s, i) => i > 0 && s.dir !== lanes[i - 1].dir);
      if (split < 0) continue;
      const o = lanes[split].l;
      const s0 = a.trim - 1.5, s1 = Math.min(a.trim + (crossingOf(a) !== 'none' ? 13 : 9), reach(a) - 0.5);
      if (s0 < 0 || s1 - a.trim < 4) continue;
      const wedge: Vec[] = [];
      const steps = 8;
      for (let i = 0; i <= steps; i++) {
        const s = s0 + ((s1 - s0) * i) / steps;
        wedge.push(atS(a, s, o + 0.95 - (0.7 * i) / steps));
      }
      for (let i = steps; i >= 0; i--) {
        const s = s0 + ((s1 - s0) * i) / steps;
        wedge.push(atS(a, s, o - 0.95 + (0.7 * i) / steps));
      }
      push(res.surfaces, wedge, STRIP_TYPES.sidewalk.color, 8, 'island');
      splitOf.set(a, { lo: o - 1.1, hi: o + 1.1 });
      for (const poly of linePolygons([...wedge, wedge[0]], 0.12)) push(res.markings, poly, ringLine);
    }
  }

  /** Form in Zufahrtsrichtung an Position s / Querversatz off setzen (x zeigt zum Knoten) */
  const place = (x: Arm, s: number, off: number, shape: Shape[], to: Feature<Polygon>[], kind?: string) => {
    const { p, t } = pointAt(x.local, s);
    const n = leftNormal(t);
    const c = add(p, mul(n, off));
    for (const sh of shape) {
      push(to, sh.pts.map(([u, v]) => add(add(c, mul(t, -u)), mul(n, -v))), sh.color, sh.rank ?? 0, kind);
    }
  };

  /** Querversatz für Schilder und Ampeln: auf dem Gehweg bzw. Grünstreifen rechts der Zufahrt */
  const signOffset = (x: Arm) => {
    let edge = x.cL;
    for (const s of x.left) {
      if (s.type === 'sidewalk' || s.type === 'green' || s.type === 'median') return Math.min((s.l + s.r) / 2, s.r + 1);
      edge = s.l;
    }
    return edge + 0.8;
  };

  // 4. Querungen je Arm
  const lineAtOf = new Map<Arm, number>();
  const keepOutOf = new Map<Arm, number>();
  /** zusammenhängende Gruppen befahrener Streifen (Mittelinseln unterbrechen die Querung) */
  const drivenGroups = (x: Arm) => {
    const out: { hi: number; lo: number }[] = [];
    let cur: { hi: number; lo: number } | null = null;
    for (const s of x.strips) {
      if (s.type === 'drive' || s.type === 'bus' || s.type === 'tram') {
        if (cur) cur.lo = s.r;
        else cur = { hi: s.l, lo: s.r };
      } else if (cur && STRIP_TYPES[s.type].carriageway && s.type !== 'parking') {
        cur.lo = s.r; // Radstreifen auf der Fahrbahn gehören zur Querung (abgesetzte Radwege sind Seitenraum)
      } else if (cur) {
        out.push(cur);
        cur = null;
      }
    }
    if (cur) out.push(cur);
    return out;
  };
  /** Verbindungsstück zwischen zwei nahen Knoten — wird wie Kreuzungsinneres behandelt */
  const inner = (x: Arm) => !!x.both && (x.length ?? Infinity) < 30;
  for (const a of arms) {
    let keepOut = 1.3;
    let lineAt = a.trim + 0.3;
    // Fußgängerquerung nur über die Fahrstreifen — Radwege bekommen ihre eigene Furt
    const driven = a.strips.filter((s) => s.type === 'drive' || s.type === 'bus' || s.type === 'tram');
    // Querung nur, wenn sie samt Haltlinie in den eigenen Teil des Arms passt
    const fits = a.trim + (roundabout ? 4 : 1) + CROSSING_LEN + 1.5 <= reach(a);
    const crossing = inner(a) || !fits ? 'none' : crossingOf(a);
    if (crossing !== 'none' && driven.length) {
      const [hi, lo] = [driven[0].l, driven[driven.length - 1].r];
      const s0 = a.trim + (roundabout ? 4 : 1);
      if (crossing === 'zebra') {
        // Balken als Rechtecke in einem geraden Rahmen — auch auf gekrümmten Armen parallel
        const { p, t } = pointAt(a.local, s0 + CROSSING_LEN / 2);
        const n = leftNormal(t);
        const at2 = (u: number, o: number) => add(add(p, mul(t, u)), mul(n, o));
        const half = CROSSING_LEN / 2;
        for (const g of drivenGroups(a)) {
          for (const [glo, ghi] of outsideSplit(a, g.lo, g.hi))
            for (let o = glo + 0.3; o + 0.5 <= ghi - 0.2; o += 1) {
              push(res.markings, [at2(-half, o), at2(half, o), at2(half, o + 0.5), at2(-half, o + 0.5)], WHITE, 0, 'zebra');
            }
        }
      } else {
        for (const s of [s0, s0 + CROSSING_LEN])
          for (const [p, q] of outsideSplit(a, lo, hi))
            for (const poly of linePolygons([atS(a, s, p), atS(a, s, q)], 0.25, [0.5, 0.3])) push(res.markings, poly, WHITE, 0, 'crossing');
      }
      // Grünstreifen und Mittelinseln im Querungsbereich gepflastert, damit der Weg nicht im Beet endet
      {
        const { p, t } = pointAt(a.local, s0 + CROSSING_LEN / 2);
        const n = leftNormal(t);
        const at2 = (u: number, o: number) => add(add(p, mul(t, u)), mul(n, o));
        const half = CROSSING_LEN / 2 + 0.3;
        const pave = (s: ArmStrip) => {
          push(res.surfaces, [at2(-half, s.r), at2(half, s.r), at2(half, s.l), at2(-half, s.l)], STRIP_TYPES.sidewalk.color, 8, 'sidewalk');
          for (const u of [-half, half]) for (const poly of linePolygons([at2(u, s.r), at2(u, s.l)], 0.15)) push(res.markings, poly, CURB);
        };
        const planted = (s: ArmStrip) => s.type === 'green' || s.type === 'median';
        for (const side of [a.left, a.right])
          for (const s of side) {
            if (s.type === 'sidewalk') break;
            if (planted(s)) pave(s);
          }
        for (const s of a.strips) if (planted(s) && s.r >= a.cR - 0.01 && s.l <= a.cL + 0.01) pave(s);
      }
      // Haltlinie hinter der Querung; im Kreisverkehr bleibt die Wartelinie am Ring
      if (!roundabout) lineAt = s0 + CROSSING_LEN + 1;
      keepOut = s0 + CROSSING_LEN + 2 - a.trim;
    }
    lineAtOf.set(a, lineAt);
    // Abbiegepfeile brauchen Platz vor der Haltlinie: Leitlinien dort aussparen
    if (!roundabout && arms.length >= 3) keepOut = Math.max(keepOut, lineAt - a.trim + 9);
    keepOut = Math.min(keepOut, Math.max(0.5, reach(a) - a.trim));
    keepOutOf.set(a, keepOut);
    // Mittelinsel zwischen den Fahrtrichtungen läuft bei einer Querung als Fußgänger-Insel bis an den Knoten
    const hasMedian = a.strips.some((x, i) => x.type === 'median' && i > 0 && i < a.strips.length - 1);
    const median = crossing !== 'none' && hasMedian && !roundabout ? 0.5 : keepOut;
    res.trims.push({ segId: a.segId, atStart: a.atStart, trim: a.trim, keepOut, median });
    // Zeichen 350 vor Zebrastreifen, rechts in Zufahrtsrichtung
    if (crossing === 'zebra' && driven.length) {
      const sSign = a.trim + (roundabout ? 4 : 1) + CROSSING_LEN + 5.5;
      if (sSign < reach(a) - 1) place(a, sSign, signOffset(a), zebraSign(), res.decor, 'sign');
    }
  }

  // 5. Spurverbindungen (automatisch aus Pfeilen und Geometrie, oder im Editor festgelegt)
  const isLane = (x: ArmStrip) => x.type === 'drive' || x.type === 'bus';
  const isBike = (x: ArmStrip) => x.type === 'bike';
  /** Zufahrtsstreifen aus Fahrersicht von links nach rechts (Kfz bzw. Rad) */
  const inLanes = (x: Arm, bike = false) =>
    x.strips.filter((l) => (bike ? isBike(l) : isLane(l)) && l.dir === -1).sort((p, q) => p.l + p.r - (q.l + q.r));
  /** Ausfahrtsstreifen aus Fahrersicht von links nach rechts */
  const outLanes = (x: Arm, bike = false) =>
    x.strips.filter((l) => (bike ? isBike(l) : isLane(l)) && l.dir === 1).sort((p, q) => q.l + q.r - (p.l + p.r));
  const moveOf = (from: Arm, to: Arm): Move | null => {
    if (from === to) return null;
    const t = shortSweep(from.ang + Math.PI, to.ang);
    if (Math.abs(t) > 160 * DEG) return null;
    return Math.abs(t) < 40 * DEG ? 'straight' : t > 0 ? 'left' : 'right';
  };
  const allowed = (l: ArmStrip, i: number, n: number): Set<Move> => {
    // Radverkehr: geradeaus und rechts; links wird indirekt abgebogen
    if (l.type === 'bike') return new Set<Move>(['straight', 'right']);
    const t = l.turn;
    if (t) return new Set<Move>([...(t.includes('left') || t === 'all' ? ['left' as const] : []), ...(t.includes('straight') || t === 'all' ? ['straight' as const] : []), ...(t.includes('right') || t === 'all' ? ['right' as const] : [])]);
    if (n === 1) return new Set<Move>(['left', 'straight', 'right']);
    if (i === 0) return new Set<Move>(['left', 'straight']);
    if (i === n - 1) return new Set<Move>(['right', 'straight']);
    return new Set<Move>(['straight']);
  };
  const laneEnd = (x: Arm, l: ArmStrip) => {
    const { p, t } = pointAt(x.local, x.trim);
    return { p: add(p, mul(leftNormal(t), (l.l + l.r) / 2)), t };
  };
  const outOwner = new Map<string, { arm: Arm; lane: ArmStrip }>();
  for (const x of arms) for (const l of [...outLanes(x), ...outLanes(x, true)]) outOwner.set(l.id, { arm: x, lane: l });
  const links: { from: Arm; inL: ArmStrip; to: Arm; outL: ArmStrip; move: Move }[] = [];
  if (!roundabout && arms.length >= 3) {
    for (const bike of [false, true])
    for (const x of arms) {
      const L = inLanes(x, bike);
      for (const [i, l] of L.entries()) {
        const explicit = st.connections?.[l.id];
        if (explicit) {
          for (const id of explicit) {
            const o = outOwner.get(id);
            const m = o && moveOf(x, o.arm);
            // Kfz nur zu Kfz-Spuren, Rad nur zu Radspuren
            if (o && m && isBike(o.lane) === bike) links.push({ from: x, inL: l, to: o.arm, outL: o.lane, move: m });
          }
          continue;
        }
        for (const m of ['left', 'straight', 'right'] as Move[]) {
          if (!allowed(l, i, L.length).has(m)) continue;
          const Lm = L.filter((q, k) => !st.connections?.[q.id] && allowed(q, k, L.length).has(m));
          const idx = Lm.indexOf(l);
          for (const y of arms.filter((y) => moveOf(x, y) === m)) {
            const O = outLanes(y, bike);
            if (!O.length) continue;
            const j =
              m === 'left'
                ? Math.min(idx, O.length - 1)
                : m === 'right'
                  ? Math.max(0, O.length - Lm.length + idx)
                  : Math.min(O.length - 1, Math.round((idx * (O.length - 1)) / Math.max(1, Lm.length - 1)));
            links.push({ from: x, inL: l, to: y, outL: O[j], move: m });
          }
        }
      }
    }
  }
  const curve = (k: (typeof links)[number]) => {
    const A = laneEnd(k.from, k.inL), B = laneEnd(k.to, k.outL);
    const d = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]) * 0.42;
    // Griffe nicht über den Schnittpunkt der Fahrlinien hinaus: sonst schwingt ein langer Weg
    // (spitzer Winkel, weit zurückgeschnittener Arm) als S-Kurve über die Gegenspur
    let [d1, d2] = [d, d];
    const bendSin = Math.abs(-A.t[0] * B.t[1] + A.t[1] * B.t[0]);
    const hit = bendSin > Math.sin(20 * DEG) ? intersectLines(A.p, mul(A.t, -1), B.p, B.t) : null;
    if (hit) {
      const [u, w] = hit;
      if (u > 0) d1 = Math.min(d1, Math.max(1, u));
      d2 = w < 0 ? Math.min(d2, Math.max(1, -w)) : Math.min(d2, 1);
    }
    const p1 = add(A.p, mul(A.t, -d1)), p2 = add(B.p, mul(B.t, -d2));
    return Array.from({ length: 17 }, (_, i) => {
      const u = i / 16, v = 1 - u;
      return [
        v * v * v * A.p[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u * u * u * B.p[0],
        v * v * v * A.p[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u * u * u * B.p[1],
      ] as Vec;
    });
  };
  res.info.arms = arms.map((x) => ({ armId: x.armId, roadId: x.roadId, ang: x.ang }));
  if (!roundabout && arms.length >= 3) {
    for (const x of arms) {
      for (const bike of [false, true]) {
        // Haltlinie (vor der Querung) — dort warten Fahrzeuge in der Simulation
        const stopS = bike ? x.trim + 0.5 : lineAtOf.get(x)!;
        for (const l of inLanes(x, bike))
          res.info.lanes.push({ id: l.id, armId: x.armId, kind: 'in', bike, pos: proj.inv(laneEnd(x, l).p), stop: proj.inv(atS(x, stopS, (l.l + l.r) / 2)) });
        for (const l of outLanes(x, bike)) res.info.lanes.push({ id: l.id, armId: x.armId, kind: 'out', bike, pos: proj.inv(laneEnd(x, l).p) });
      }
    }
  }
  /**
   * Radfurt je Zufahrt nur für die geradeste Geradeaus-Verbindung: Rechtsabbieger folgen dem
   * Bordstein, Linksabbieger biegen indirekt ab — malte man alle, fächerten die Furten auf.
   */
  const furtOf = new Map<string, (typeof links)[number]>();
  const bend = (k: (typeof links)[number]) => Math.abs(shortSweep(k.from.ang + Math.PI, k.to.ang));
  for (const k of links) {
    if (!isBike(k.inL) || k.move !== 'straight') continue;
    const cur = furtOf.get(k.inL.id);
    if (!cur || bend(k) < bend(cur)) furtOf.set(k.inL.id, k);
  }
  for (const k of links) {
    const pts = curve(k);
    const bike = isBike(k.inL);
    res.info.links.push({ from: k.inL.id, to: k.outL.id, move: k.move, bike, pts: pts.map(proj.inv) });
    if (bike) {
      // Radfurt entlang der Verbindung: grünes Band mit unterbrochenen Rändern
      if (!st.bikeCrossing || furtOf.get(k.inL.id) !== k) continue;
      const w = Math.min(k.inL.l - k.inL.r, k.outL.l - k.outL.r);
      push(res.surfaces, band(pts, w / 2, -w / 2), STRIP_TYPES.bike.color, 6, 'furt');
      for (const side of [w / 2, -w / 2]) {
        for (const poly of linePolygons(offsetPolyline(pts, side), 0.25, [0.5, 0.5])) push(res.markings, poly, WHITE);
      }
      continue;
    }
    // Abbiegeleitlinien für Linksabbieger (gestrichelt, wie in größeren Knoten üblich)
    if (st.guides && k.move === 'left') {
      for (const poly of linePolygons(pts, 0.12, [1, 1])) push(res.markings, poly, WHITE);
    }
  }


  // Gleise durch den Knoten: jede ankommende Schiene zum am besten passenden Gegenarm
  if (!roundabout) {
    const trams = (x: Arm, dir: 1 | -1) => x.strips.filter((s) => s.type === 'tram' && s.dir === dir);
    for (const x of arms) {
      for (const tin of trams(x, -1)) {
        let best: { arm: Arm; lane: ArmStrip; score: number } | null = null;
        for (const y of arms) {
          if (y === x) continue;
          for (const tout of trams(y, 1)) {
            const straight = Math.cos(shortSweep(x.ang + Math.PI, y.ang));
            const lateral = Math.abs((tout.l + tout.r) / 2 + (tin.l + tin.r) / 2);
            const score = straight * 10 - lateral;
            if (!best || score > best.score) best = { arm: y, lane: tout, score };
          }
        }
        if (!best) continue;
        const A = laneEnd(x, tin), B = laneEnd(best.arm, best.lane);
        const d = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]) * 0.42;
        const p1 = add(A.p, mul(A.t, -d)), p2 = add(B.p, mul(B.t, -d));
        const pts = Array.from({ length: 17 }, (_, i) => {
          const u = i / 16, v = 1 - u;
          return [
            v * v * v * A.p[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u * u * u * B.p[0],
            v * v * v * A.p[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u * u * u * B.p[1],
          ] as Vec;
        });
        push(res.surfaces, band(pts, 1.3, -1.3), STRIP_TYPES.tram.color, 6, 'tram');
        for (const o of [-0.7175, 0.7175]) {
          for (const poly of linePolygons(offsetPolyline(pts, o), 0.14)) push(res.markings, poly, '#696967');
        }
      }
    }
  }

  // 6. Regelung: Halt-/Wartelinien, Pfeile, Schilder und Ampeln
  const control = controlOf(st);
  const mainPair = (() => {
    let best: [Arm, Arm] | null = null, score = -1;
    arms.forEach((x, i) =>
      arms.slice(i + 1).forEach((y) => {
        const straightness = Math.cos(shortSweep(x.ang, y.ang) - Math.PI) + 1;
        const sc = straightness * (x.cL - x.cR + y.cL - y.cR);
        if (sc > score) [score, best] = [sc, [x, y]];
      }),
    );
    return best as [Arm, Arm] | null;
  })();
  const roleOf = (x: Arm): ArmRole | null => {
    if (control === 'allstop') return 'stop';
    if (control !== 'priority') return null;
    return st.roles?.[x.armId] ?? (mainPair?.includes(x) ? 'main' : 'yield');
  };
  for (const x of arms) {
    const lineAt = lineAtOf.get(x)!;
    const groups: ArmStrip[][] = [];
    let group: ArmStrip[] = [];
    for (const l of x.strips) {
      const info = STRIP_TYPES[l.type];
      if (info.carriageway && info.directional && l.dir === -1 && l.type !== 'tram') group.push(l);
      else if (group.length) groups.push(group), (group = []);
    }
    if (group.length) groups.push(group);
    if (!groups.length || inner(x)) continue;

    if (roundabout) {
      for (const g of groups) {
        for (const [r, l] of outsideSplit(x, g[g.length - 1].r, g[0].l)) {
          if (style === 'us') place(x, lineAt, 0, sharkTeeth(r, l), res.markings, 'stopline');
          else for (const poly of linePolygons([atS(x, lineAt, r), atS(x, lineAt, l)], 0.3, [0.5, 0.25])) push(res.markings, poly, WHITE, 0, 'stopline');
        }
        // Kreisverkehrspfeil hinter Querung und Fahrbahnteiler
        const sArrow = x.trim + Math.max(keepOutOf.get(x)!, mini ? 2 : 11) + 7;
        for (const lane of g.filter(isLane)) if (sArrow < reach(x) - 3) place(x, sArrow, (lane.l + lane.r) / 2, fitToLane(roundaboutArrow(), lane.l - lane.r), res.markings, 'arrow');
      }
      continue;
    }
    if (arms.length < 3) continue;
    const role = roleOf(x);
    const line = slicePolyline(x.local, lineAt, lineAt + 0.5);
    for (const g of groups) {
      const [l, r] = [g[0].l, g[g.length - 1].r];
      if (role === 'yield') {
        if (style === 'us') place(x, lineAt, 0, sharkTeeth(r, l), res.markings, 'stopline');
        else for (const poly of linePolygons([atS(x, lineAt + 0.25, r), atS(x, lineAt + 0.25, l)], 0.5, [0.5, 0.25])) push(res.markings, poly, WHITE, 0, 'stopline');
      } else if ((control === 'stoplines' || control === 'signals' || role === 'stop') && line.length >= 2) {
        push(res.markings, band(line, l, r), WHITE, 0, 'stopline');
      }
    }
    // Abbiegepfeile aus den Spurverbindungen
    const approach = inLanes(x);
    for (const lane of approach) {
      const moves = new Set(links.filter((k) => k.inL === lane).map((k) => k.move));
      // nur eine Spur ohne Vorgabe: es gibt nichts zu wählen → keine Pfeile
      if (!moves.size || (approach.length === 1 && !lane.turn && !st.connections?.[lane.id])) continue;
      const L = moves.has('left'), S = moves.has('straight'), Rt = moves.has('right');
      const turn: Turn = L && S && Rt ? 'all' : L && S ? 'left-straight' : S && Rt ? 'right-straight' : L && Rt ? 'left-right' : L ? 'left' : Rt ? 'right' : 'straight';
      for (const back of [5.5, 26]) {
        const sPos = lineAt + back;
        // nur dort, wo die Spur ihre volle Breite hat (nicht in einer Verziehung)
        // der erste Pfeil passt immer: Verziehungen werden hinter den Kreuzungsbereich geschoben
        if (sPos < Math.min(reach(x) - 4, back < 10 ? Infinity : (x.uniform ?? Infinity) - 3)) place(x, sPos, (lane.l + lane.r) / 2, fitToLane(turnArrow(turn), lane.l - lane.r), res.markings, 'arrow');
      }
    }
    // Schilder bzw. Ampel am rechten Fahrbahnrand der Zufahrt
    const signs = control === 'signals' ? trafficLight() : role === 'main' ? mainSign() : role === 'yield' ? yieldSign() : role === 'stop' ? stopSign() : null;
    if (signs) place(x, lineAt + 0.6, signOffset(x), signs, res.decor, 'sign');
  }

  return res;
}
