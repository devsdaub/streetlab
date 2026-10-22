/**
 * „Abschnitt ziehen“: auf einer Straße entlangziehen — der überstrichene Bereich bekommt den
 * gewählten Querschnitt, davor und danach bleibt die Straße, wie sie war (Verziehungen entstehen
 * automatisch). Gedacht vor allem für übernommene Bestandsstraßen.
 */
import type { Map as MapLibre, MapMouseEvent } from 'maplibre-gl';
import type { Feature, Polygon } from 'geojson';
import type { Editor } from './editor';
import { band, localProjection, slicePolyline, smoothWithIndex, type Vec } from './geometry';
import { EMPTY, setData } from './map';
import { insertPoint, leftEdge, profileAt, sameProfile, sectionAt, uid, type LngLat, type Road, type Strip } from './model';
import type { Store } from './store';

/** Mittellinie wie gezeichnet (geglättet) mit Bogenlängen — Grundlage für Lage und Einfügen */
export function roadLine(road: Road) {
  const proj = localProjection(road.points[0]);
  const local = road.points.map(proj.fwd);
  const { pts, idx } = road.smooth ? smoothWithIndex(local) : { pts: local, idx: local.map((_, i) => i) };
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  /** nächste Stelle der Mittellinie zu q: Bogenlänge und Abstand (m) */
  const locate = (q: Vec) => {
    let best = { s: 0, d: Infinity };
    for (let k = 1; k < pts.length; k++) {
      const [a, b] = [pts[k - 1], pts[k]];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      if (l2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2));
      const d = Math.hypot(a[0] + t * dx - q[0], a[1] + t * dy - q[1]);
      if (d < best.d) best = { s: cum[k - 1] + t * Math.sqrt(l2), d };
    }
    return best;
  };
  return { proj, local, pts, idx, cum, length: cum[cum.length - 1], locate };
}

/** Umriss einer Straße (größte Breite aller Abschnitte) — für die blaue Hervorhebung */
export function roadOutline(road: Road): LngLat[] {
  const line = roadLine(road);
  const profiles = [road.profile, ...(road.sections ?? []).map((x) => x.profile)];
  const left = Math.max(...profiles.map(leftEdge)) + 0.4;
  const right = Math.max(...profiles.map((p) => p.reduce((w, x) => w + x.width, 0) - leftEdge(p))) + 0.4;
  return band(line.pts, left, -right).map(line.proj.inv);
}

/**
 * Stützpunkt bei Bogenlänge s sicherstellen (auf der geglätteten Linie, damit Kurven nicht
 * knicken). Liegt dort schon einer (±1 m), wird dieser genommen. Gibt seinen Index zurück.
 */
function vertexAt(road: Road, s: number): number {
  const L = roadLine(road);
  if (s <= 0.5) return 0;
  if (s >= L.length - 0.5) return road.points.length - 1;
  let k = 1;
  while (k < L.cum.length - 1 && L.cum[k] < s) k++;
  const [a, b] = [L.pts[k - 1], L.pts[k]];
  const t = (s - L.cum[k - 1]) / (L.cum[k] - L.cum[k - 1] || 1);
  const p: Vec = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  // Stützpunkt-Abschnitt i, in dem die geglättete Stelle k liegt
  let i = 0;
  while (i < L.idx.length - 2 && L.idx[i + 1] < k) i++;
  for (const j of [i, i + 1]) if (Math.hypot(L.local[j][0] - p[0], L.local[j][1] - p[1]) < 1) return j;
  insertPoint(road, i + 1, L.proj.inv(p));
  return i + 1;
}

/** Querschnitt `profile` zwischen den Bogenlängen a < b setzen; vorher und nachher bleibt alles */
export function applySection(road: Road, a: number, b: number, profile: Strip[]): number {
  let ib = vertexAt(road, b);
  const before = road.points.length;
  const ia = vertexAt(road, a);
  if (road.points.length > before && ia <= ib) ib++;
  const last = road.points.length - 1;
  // Querschnitt nach dem Bereich unverändert übernehmen (gleiche Streifen-IDs für Verknüpfungen)
  const after = profileAt(road, ib);
  const fresh = profile.map((s) => ({ ...structuredClone(s), id: uid() }));
  const list = (road.sections ?? []).filter((x) => x.index <= ia || x.index > ib);
  if (ia === 0) road.profile = fresh;
  else {
    const at = list.find((x) => x.index === ia);
    if (at) at.profile = fresh;
    else list.push({ index: ia, profile: fresh });
  }
  if (ib < last && !list.some((x) => x.index === ib)) list.push({ index: ib, profile: after });
  list.sort((x, y) => x.index - y.index);
  // Grenzen ohne jeden Wechsel entfallen
  const cleaned = [];
  let prev = road.profile;
  for (const x of list) {
    if (identical(prev, x.profile)) continue;
    cleaned.push(x);
    prev = x.profile;
  }
  if (cleaned.length) road.sections = cleaned;
  else delete road.sections;
  return ia;
}

/** gleicher Querschnitt einschließlich Bepflanzung, Parkwinkel, Pfeilen und Linien */
const identical = (a: Strip[], b: Strip[]) =>
  sameProfile(a, b) && a.every((s, i) => s.planting === b[i].planting && s.parkAngle === b[i].parkAngle && s.turn === b[i].turn && s.lineRight === b[i].lineRight);

export class SectionBrush {
  /** Querschnitt, der aufgetragen wird, und sein Name (gesetzt von der Werkzeugleiste) */
  profile: () => { strips: Strip[]; name: string } = () => ({ strips: [], name: '' });
  private drag: { road: Road; from: number; to: number; line: ReturnType<typeof roadLine> } | null = null;
  private label: HTMLDivElement;

  constructor(
    private map: MapLibre,
    private store: Store,
    private editor: Editor,
  ) {
    this.label = document.createElement('div');
    this.label.className = 'snap-label';
    this.label.dataset.guide = 'on';
    map.getContainer().append(this.label);
    map.on('mousedown', (e) => this.down(e));
    // am ganzen Fenster verfolgen: über Werkzeugleiste oder Panel bekommt die Karte keine Ereignisse
    window.addEventListener('mousemove', (e) => this.move(e));
    window.addEventListener('mouseup', () => this.up());
  }

  reset() {
    this.drag = null;
    this.map.dragPan.enable();
    this.label.style.display = 'none';
    setData(this.map, 'brush', EMPTY);
  }

  private toLocal(line: ReturnType<typeof roadLine>, e: { x: number; y: number }): Vec {
    return line.proj.fwd(this.map.unproject([e.x, e.y]).toArray() as LngLat);
  }

  private down(e: MapMouseEvent) {
    if (this.editor.mode !== 'section' || e.originalEvent.button !== 0) return;
    // Straße unter dem Cursor: Mittellinie innerhalb der halben Breite
    let best: { road: Road; s: number; d: number; line: ReturnType<typeof roadLine> } | null = null;
    for (const road of this.store.project.roads) {
      if (road.points.length < 2) continue;
      const line = roadLine(road);
      const { s, d } = line.locate(this.toLocal(line, e.point));
      const half = Math.max(...[road.profile, ...(road.sections ?? []).map((x) => x.profile)].map((p) => p.reduce((w, x) => w + x.width, 0))) / 2;
      if (d < half && (!best || d < best.d)) best = { road, s, d, line };
    }
    if (!best) return;
    e.preventDefault();
    this.map.dragPan.disable();
    this.drag = { road: best.road, from: best.s, to: best.s, line: best.line };
    this.draw(e.point);
  }

  private move(e: MouseEvent) {
    if (!this.drag) return;
    const r = this.map.getCanvas().getBoundingClientRect();
    const q = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.drag.to = this.drag.line.locate(this.toLocal(this.drag.line, q)).s;
    this.draw(q);
  }

  private draw(at: { x: number; y: number }) {
    const { road, from, to, line } = this.drag!;
    const [a, b] = [Math.min(from, to), Math.max(from, to)];
    const len = b - a;
    const { name, strips } = this.profile();
    if (len >= 0.5) {
      const center = slicePolyline(line.pts, a, b);
      const prof = [strips, profileAt(road, 0)];
      const left = Math.max(...prof.map(leftEdge)) + 0.4;
      const right = Math.max(...prof.map((p) => p.reduce((w, x) => w + x.width, 0) - leftEdge(p))) + 0.4;
      const ring = band(center, left, -right).map(line.proj.inv);
      const f: Feature<Polygon> = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
      setData(this.map, 'brush', { type: 'FeatureCollection', features: [f] });
    }
    this.label.textContent = `${Math.round(len)} m · ${name} · weiter ziehen nimmt mehr`;
    this.label.style.display = 'block';
    this.label.style.transform = `translate(${Math.round(at.x + 16)}px, ${Math.round(at.y + 14)}px)`;
  }

  private up() {
    if (!this.drag) return;
    const { road, from, to } = this.drag;
    this.reset();
    const [a, b] = [Math.min(from, to), Math.max(from, to)];
    if (b - a < 3) return; // nur geklickt
    this.store.checkpoint();
    const ia = applySection(road, a, b, this.profile().strips);
    this.store.changed('structure');
    this.editor.select(road.id, sectionAt(road, ia));
  }
}
