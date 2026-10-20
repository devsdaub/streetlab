import { insertPoint, type LngLat, type Road } from './model';

const M = 111320;

/** Parameter t ∈ (0,1), wenn p (bis auf 2 cm) im Inneren der Strecke a–b liegt. */
function paramOnSegment(p: LngLat, a: LngLat, b: LngLat): number | null {
  const k = Math.cos((a[1] * Math.PI) / 180);
  const ab = [(b[0] - a[0]) * M * k, (b[1] - a[1]) * M];
  const ap = [(p[0] - a[0]) * M * k, (p[1] - a[1]) * M];
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  if (l2 < 1e-6) return null;
  const t = (ap[0] * ab[0] + ap[1] * ab[1]) / l2;
  const along = t * Math.sqrt(l2);
  const perp = Math.abs(ap[0] * ab[1] - ap[1] * ab[0]) / Math.sqrt(l2);
  return perp < 0.02 && along > 0.05 && along < Math.sqrt(l2) - 0.05 ? t : null;
}

/** Schnittpunkt zweier Strecken (Parameter sind affin-invariant, daher direkt in Grad). */
function crossSegments(a1: LngLat, a2: LngLat, b1: LngLat, b2: LngLat): [number, number] | null {
  const d1 = [a2[0] - a1[0], a2[1] - a1[1]];
  const d2 = [b2[0] - b1[0], b2[1] - b1[1]];
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(cross) < 1e-18) return null;
  const w = [b1[0] - a1[0], b1[1] - a1[1]];
  const s = (w[0] * d2[1] - w[1] * d2[0]) / cross;
  const t = (w[0] * d1[1] - w[1] * d1[0]) / cross;
  return s > 0 && s < 1 && t > 0 && t < 1 ? [s, t] : null;
}

const near = (p: LngLat, q: LngLat, m = 0.3) => {
  const k = Math.cos((p[1] * Math.PI) / 180);
  return Math.hypot((p[0] - q[0]) * M * k, (p[1] - q[1]) * M) < m;
};

/**
 * Verknüpft `road` mit dem übrigen Netz: Stützpunkte, die auf einer anderen Straße liegen,
 * und echte Kreuzungen werden als gemeinsame Punkte in beide Straßen eingefügt.
 * Gibt true zurück, wenn etwas eingefügt wurde.
 */
export function connectRoad(roads: Road[], road: Road): boolean {
  const inserts = new Map<Road, { i: number; t: number; p: LngLat }[]>();
  const add = (r: Road, i: number, t: number, p: LngLat) => inserts.set(r, [...(inserts.get(r) ?? []), { i, t, p }]);

  for (const other of roads) {
    if (other === road) continue;
    for (let i = 0; i < other.points.length - 1; i++) {
      const [a, b] = [other.points[i], other.points[i + 1]];
      for (const p of road.points) {
        const t = paramOnSegment(p, a, b);
        if (t !== null) add(other, i, t, p);
      }
    }
    for (let j = 0; j < road.points.length - 1; j++) {
      const [a, b] = [road.points[j], road.points[j + 1]];
      for (const p of other.points) {
        const t = paramOnSegment(p, a, b);
        if (t !== null) add(road, j, t, p);
      }
      for (let i = 0; i < other.points.length - 1; i++) {
        const [c, d] = [other.points[i], other.points[i + 1]];
        const hit = crossSegments(a, b, c, d);
        if (!hit) continue;
        const x: LngLat = [c[0] + (d[0] - c[0]) * hit[1], c[1] + (d[1] - c[1]) * hit[1]];
        // knapp neben einem vorhandenen Punkt: schon verbunden oder bewusst getrennt
        if ([a, b, c, d].some((q) => near(q, x))) continue;
        add(road, j, hit[0], x);
        add(other, i, hit[1], x);
      }
    }
  }

  for (const [r, list] of inserts) {
    list.sort((x, y) => y.i - x.i || y.t - x.t);
    for (const { i, p } of list) insertPoint(r, i + 1, [p[0], p[1]]);
  }
  return inserts.size > 0;
}
