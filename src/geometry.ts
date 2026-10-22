import type { LngLat } from './model';

export type Vec = [number, number];

const M_PER_DEG = 111320;

/** Lokale ebene Projektion in Metern um einen Ursprung — genau genug auf Stadtteil-Ebene. */
export function localProjection(origin: LngLat) {
  const k = Math.cos((origin[1] * Math.PI) / 180);
  return {
    fwd: ([lng, lat]: LngLat): Vec => [(lng - origin[0]) * M_PER_DEG * k, (lat - origin[1]) * M_PER_DEG],
    inv: ([x, y]: Vec): LngLat => [origin[0] + x / (M_PER_DEG * k), origin[1] + y / M_PER_DEG],
  };
}

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1];
const len = (a: Vec) => Math.hypot(a[0], a[1]);
const dist = (a: Vec, b: Vec) => len(sub(a, b));

export function dedupe(pts: Vec[], eps = 0.05): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > eps) out.push(p);
  return out;
}

/** Zentripetale Catmull-Rom-Spline durch alle Punkte, abgetastet etwa alle `step` Meter. */
export function smoothPolyline(pts: Vec[], step = 1.5): Vec[] {
  return smoothWithIndex(pts, step).pts;
}

/** Wie smoothPolyline; `idx[i]` ist die Position von Eingabepunkt i in der Ausgabe. */
export function smoothWithIndex(pts: Vec[], step = 1.5): { pts: Vec[]; idx: number[] } {
  if (pts.length < 3) return { pts, idx: pts.map((_, i) => i) };
  const ext: Vec[] = [sub(mul(pts[0], 2), pts[1]), ...pts, sub(mul(pts[pts.length - 1], 2), pts[pts.length - 2])];
  const out: Vec[] = [pts[0]];
  const idx = [0];
  for (let i = 1; i < ext.length - 2; i++) {
    const [p0, p1, p2, p3] = [ext[i - 1], ext[i], ext[i + 1], ext[i + 2]];
    const n = Math.max(1, Math.ceil(dist(p1, p2) / step));
    for (let s = 1; s <= n; s++) out.push(catmullRom(p0, p1, p2, p3, s / n));
    idx.push(out.length - 1);
  }
  return { pts: out, idx };
}

/** Polylinie gleichmäßig etwa alle `step` Meter abtasten (Eckpunkte bleiben erhalten). */
export function resample(pts: Vec[], step = 1): Vec[] {
  const out: Vec[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push(add(a, mul(sub(b, a), k / n)));
  }
  return out;
}

/** Bogenlänge vom Anfang bis zu jedem Punkt */
export function cumulativeLength(pts: Vec[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + dist(pts[i - 1], pts[i]));
  return out;
}

function catmullRom(p0: Vec, p1: Vec, p2: Vec, p3: Vec, u: number): Vec {
  const tj = (t: number, a: Vec, b: Vec) => t + Math.max(Math.sqrt(dist(a, b)), 1e-4);
  const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
  const t = t1 + (t2 - t1) * u;
  const lerp = (a: Vec, b: Vec, ta: number, tb: number): Vec =>
    add(mul(a, (tb - t) / (tb - ta)), mul(b, (t - ta) / (tb - ta)));
  const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

/** Parallelverschiebung einer Polylinie; d > 0 = nach links (in Laufrichtung). */
export function offsetPolyline(pts: Vec[], d: number): Vec[] {
  const n = pts.length;
  if (n < 2 || d === 0) return pts.slice();
  const normals: Vec[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dir = sub(pts[i + 1], pts[i]);
    const l = len(dir) || 1;
    normals.push([-dir[1] / l, dir[0] / l]);
  }
  const out: Vec[] = [add(pts[0], mul(normals[0], d))];
  for (let i = 1; i < n - 1; i++) {
    const n1 = normals[i - 1], n2 = normals[i];
    const m = add(n1, n2);
    const ml = len(m);
    const miter = ml > 1e-6 ? d / dot(mul(m, 1 / ml), n1) : Infinity;
    if (Math.abs(miter) > Math.abs(d) * 3) {
      // zu spitzer Winkel → abgeschrägte Ecke statt riesiger Gehrung
      out.push(add(pts[i], mul(n1, d)), add(pts[i], mul(n2, d)));
    } else {
      out.push(add(pts[i], mul(m, miter / ml)));
    }
  }
  out.push(add(pts[n - 1], mul(normals[n - 2], d)));
  return Math.abs(d) > 0.3 ? removeLoops(out) : out;
}

/** Schnittpunkt zweier Strecken a–b und c–d (oder null) */
function segmentHit(a: Vec, b: Vec, c: Vec, d: Vec): Vec | null {
  const r = sub(b, a), q = sub(d, c);
  const den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-12) return null;
  const w = sub(c, a);
  const t = (w[0] * q[1] - w[1] * q[0]) / den;
  const u = (w[0] * r[1] - w[1] * r[0]) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9 ? add(a, mul(r, t)) : null;
}

/**
 * Entfernt Schleifen, die beim Parallelverschieben am Innenrand enger Kurven entstehen:
 * schneidet sich die Linie selbst, wird das Stück dazwischen durch den Schnittpunkt ersetzt.
 */
export function removeLoops(pts: Vec[], window = 80): Vec[] {
  const out = pts.slice();
  for (let i = 0; i < out.length - 3; i++) {
    for (let j = Math.min(out.length - 2, i + window); j >= i + 2; j--) {
      const x = segmentHit(out[i], out[i + 1], out[j], out[j + 1]);
      if (x) {
        out.splice(i + 1, j - i, x);
        break;
      }
    }
  }
  return out;
}

export function polylineLength(pts: Vec[]) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

/** Teilstück einer Polylinie zwischen zwei Bogenlängen. */
export function slicePolyline(pts: Vec[], from: number, to: number): Vec[] {
  const out: Vec[] = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = dist(a, b);
    const s0 = acc, s1 = acc + l;
    acc = s1;
    if (s1 < from || l === 0) continue;
    if (s0 > to) break;
    const at = (s: number) => add(a, mul(sub(b, a), (s - s0) / l));
    if (!out.length) out.push(at(Math.max(from, s0)));
    out.push(at(Math.min(to, s1)));
  }
  return out;
}

/** Punkt und Laufrichtung (Einheitsvektor) bei Bogenlänge s. */
export function pointAt(pts: Vec[], s: number): { p: Vec; t: Vec } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = dist(a, b);
    if (l === 0) continue;
    const t = mul(sub(b, a), 1 / l);
    if (acc + l >= s || i === pts.length - 1) return { p: add(a, mul(t, Math.min(s - acc, l))), t };
    acc += l;
  }
  return { p: pts[0], t: [1, 0] };
}

/** Schnitt zweier Geraden p1 + s·d1 = p2 + t·d2 → [s, t] */
export function intersectLines(p1: Vec, d1: Vec, p2: Vec, d2: Vec): [number, number] | null {
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(cross) < 1e-9) return null;
  const w = sub(p2, p1);
  return [(w[0] * d2[1] - w[1] * d2[0]) / cross, (w[0] * d1[1] - w[1] * d1[0]) / cross];
}

export const leftNormal = (d: Vec): Vec => [-d[1], d[0]];

/**
 * Kreisbogen, der in s mit der Richtung t (Einheitsvektor) beginnt und in e endet — für das
 * Kurven-Werkzeug. Punkte etwa alle 8°; radius = Infinity bei einer Geraden. null, wenn e hinter
 * dem Anfang liegt (Bogen über 180°).
 */
export function tangentArc(s: Vec, t: Vec, e: Vec): { pts: Vec[]; radius: number; length: number; endDir: Vec } | null {
  const v = sub(e, s);
  const chord = len(v);
  if (chord < 0.01) return null;
  const n = leftNormal(t);
  // Sehnenwinkel zur Anfangsrichtung; der Bogen überstreicht das Doppelte
  const phi = Math.atan2(dot(v, n), dot(v, t));
  if (Math.abs(phi) > Math.PI / 2 - 0.02) return null;
  if (Math.abs(phi) < 1e-4) return { pts: [s, e], radius: Infinity, length: chord, endDir: mul(v, 1 / chord) };
  const R = chord / (2 * Math.sin(phi)); // Vorzeichen: > 0 links herum
  const steps = Math.max(2, Math.ceil(Math.abs(2 * phi) / ((8 * Math.PI) / 180)));
  const pts: Vec[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = (2 * phi * k) / steps;
    pts.push(add(s, add(mul(t, R * Math.sin(a)), mul(n, R * (1 - Math.cos(a))))));
  }
  pts[pts.length - 1] = e;
  const c = Math.cos(2 * phi), si = Math.sin(2 * phi);
  return { pts, radius: Math.abs(R), length: Math.abs(R * 2 * phi), endDir: [t[0] * c - t[1] * si, t[0] * si + t[1] * c] };
}
export { add, mul, sub };

/** Fläche (geschlossener Ring) zwischen zwei Abständen zur Mittellinie. */
export function band(center: Vec[], left: number, right: number): Vec[] {
  const l = offsetPolyline(center, left);
  const r = offsetPolyline(center, right).reverse();
  return [...l, ...r, l[0]];
}

/**
 * Strich- oder Vollinie als Polygone mit echter Breite in Metern.
 * `phase` = Bogenlänge, bei der `line` im Gesamtzug beginnt — so läuft das Strichmuster
 * über Teilstücke hinweg weiter. `keepOut` hält Striche von den Enden fern (z. B. vor Haltlinien).
 */
export function linePolygons(
  line: Vec[],
  width: number,
  dash?: [number, number],
  phase = 0,
  keepOut: [number, number] = [0, 0],
): Vec[][] {
  const pieces: Vec[][] = [];
  if (!dash) pieces.push(line);
  else {
    const total = polylineLength(line);
    const period = dash[0] + dash[1];
    const first = ((((dash[1] / 2 - phase) % period) + period) % period) - period;
    for (let s = first; s < total; s += period) {
      const from = Math.max(s, keepOut[0]), to = Math.min(s + dash[0], total - keepOut[1]);
      if (to - from < 0.05) continue;
      const piece = slicePolyline(line, from, to);
      if (piece.length >= 2) pieces.push(piece);
    }
  }
  return pieces.map((p) => band(p, width / 2, -width / 2));
}
