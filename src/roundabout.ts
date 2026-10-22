/**
 * „Kreisverkehr aufziehen“: auf eine Kreuzung drücken und den Radius nach außen ziehen. Die
 * Vorschau zeigt Kreisfahrbahn und Mittelinsel; beim Loslassen wird der Knoten zum Kreisverkehr
 * (unter 10 m zum Mini-Kreisel). Auch bestehende Kreisverkehre lassen sich so neu bemessen.
 */
import type { Map as MapLibre, MapMouseEvent } from 'maplibre-gl';
import type { Feature, Polygon } from 'geojson';
import type { Editor } from './editor';
import { localProjection, type Vec } from './geometry';
import { EMPTY, setData } from './map';
import { defaultJunction, type LngLat } from './model';
import { nodeKey } from './render';
import type { Store } from './store';

/** gleiche Grenzen wie im Inspektor (panel.ts) */
const MIN_R = 6, MAX_R = 40;
/** ab diesem Außenradius ein richtiger Kreisverkehr, darunter ein Mini-Kreisel */
const MINI_BELOW = 10;

/** Knoten mit mindestens drei Armen (Kreuzungen und Einmündungen) samt Armzahl */
export function junctionNodes(roads: { points: LngLat[] }[]): Map<string, { p: LngLat; arms: number }> {
  const seen = new Map<string, { p: LngLat; arms: number; roads: number }>();
  for (const r of roads) {
    const keys = new Set<string>();
    r.points.forEach((p, i) => {
      const k = nodeKey(p);
      const e = seen.get(k) ?? { p, arms: 0, roads: 0 };
      e.arms += i === 0 || i === r.points.length - 1 ? 1 : 2;
      if (!keys.has(k)) (e.roads++, keys.add(k));
      seen.set(k, e);
    });
  }
  return new Map([...seen].filter(([, e]) => e.roads >= 2 && e.arms >= 3).map(([k, e]) => [k, { p: e.p, arms: e.arms }]));
}

export class RoundaboutTool {
  private drag: { key: string; center: LngLat; arms: number; r: number; moved: boolean; start: { x: number; y: number } } | null = null;
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
    window.addEventListener('mousemove', (e) => this.move(e));
    window.addEventListener('mouseup', () => this.up());
  }

  reset() {
    this.drag = null;
    this.map.dragPan.enable();
    this.label.style.display = 'none';
    setData(this.map, 'rb-preview', EMPTY);
  }

  private down(e: MapMouseEvent) {
    if (this.editor.mode !== 'roundabout' || e.originalEvent.button !== 0) return;
    // nächste Kreuzung innerhalb von 30 px
    let best: { key: string; p: LngLat; arms: number; d: number } | null = null;
    for (const [key, n] of junctionNodes(this.store.project.roads)) {
      const q = this.map.project(n.p);
      const d = Math.hypot(q.x - e.point.x, q.y - e.point.y);
      if (d < 30 && (!best || d < best.d)) best = { key, p: n.p, arms: n.arms, d };
    }
    if (!best) return;
    e.preventDefault();
    this.map.dragPan.disable();
    const st = this.store.project.junctions?.[best.key];
    const r = st && st.kind !== 'cross' ? st.rbRadius : defaultJunction().rbRadius;
    this.drag = { key: best.key, center: best.p, arms: best.arms, r, moved: false, start: { x: e.point.x, y: e.point.y } };
    this.draw(e.point);
  }

  private move(e: MouseEvent) {
    if (!this.drag) return;
    const rect = this.map.getCanvas().getBoundingClientRect();
    const q = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (!this.drag.moved && Math.hypot(q.x - this.drag.start.x, q.y - this.drag.start.y) < 4) return;
    this.drag.moved = true;
    const proj = localProjection(this.drag.center);
    const v = proj.fwd(this.map.unproject([q.x, q.y]).toArray() as LngLat);
    // auf halbe Meter, damit die Maße glatt bleiben
    this.drag.r = Math.min(MAX_R, Math.max(MIN_R, Math.round(Math.hypot(v[0], v[1]) * 2) / 2));
    this.draw(q);
  }

  /** Breite der Kreisfahrbahn: Mini-Kreisel 6 m, sonst die bisherige (bzw. Vorgabe) */
  private laneFor(r: number) {
    const st = this.store.project.junctions?.[this.drag!.key];
    if (r < MINI_BELOW) return 6;
    return st && st.kind === 'roundabout' ? st.rbLane : defaultJunction().rbLane;
  }

  private draw(at: { x: number; y: number }) {
    const { center, r, arms } = this.drag!;
    const proj = localProjection(center);
    const circle = (rad: number) => Array.from({ length: 65 }, (_, k) => proj.inv([rad * Math.cos((k / 64) * 2 * Math.PI), rad * Math.sin((k / 64) * 2 * Math.PI)] as Vec));
    const mini = r < MINI_BELOW;
    const lane = Math.min(this.laneFor(r), r - 1);
    const ring: Feature<Polygon> = { type: 'Feature', properties: { part: 'ring' }, geometry: { type: 'Polygon', coordinates: [circle(r), circle(r - lane).reverse()] } };
    const island: Feature<Polygon> = { type: 'Feature', properties: { part: 'island' }, geometry: { type: 'Polygon', coordinates: [circle(r - lane)] } };
    setData(this.map, 'rb-preview', { type: 'FeatureCollection', features: [ring, island] });
    this.label.textContent = `r ${String(r).replace('.', ',')} m · ${arms} Arme · ${mini ? 'Mini-Kreisel' : 'Kreisverkehr'}`;
    this.label.style.display = 'block';
    this.label.style.transform = `translate(${Math.round(at.x + 16)}px, ${Math.round(at.y + 14)}px)`;
  }

  private up() {
    if (!this.drag) return;
    const { key, r } = this.drag;
    const rbLane = this.laneFor(r);
    this.reset();
    this.store.checkpoint();
    const junctions = (this.store.project.junctions ??= {});
    const st = { ...defaultJunction(), ...junctions[key] };
    // Kreisverkehr regelt die Vorfahrt selbst; Spurverbindungen der Kreuzung passen nicht mehr
    junctions[key] = { ...st, kind: r < MINI_BELOW ? 'mini' : 'roundabout', rbRadius: r, rbLane, control: 'none' };
    delete junctions[key].connections;
    this.store.changed('structure');
    this.editor.selectNode(key);
  }
}
