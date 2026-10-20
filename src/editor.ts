import type { Map as MapLibre, MapLayerMouseEvent, MapMouseEvent, PointLike } from 'maplibre-gl';
import type { Feature } from 'geojson';
import { EMPTY, SURFACE_LAYERS, setData, setStripHighlight } from './map';
import type { JunctionInfo } from './junction';
import type { TransitionInfo } from './render';
import { defaultJunction, ensureSection, insertPoint, presetProfile, removePoint, uid, type LngLat, type Road, type Strip } from './model';
import { nodeKey } from './render';
import type { Store } from './store';
import { connectRoad } from './topology';

export type Mode = 'select' | 'draw' | 'split';

const SNAP_PX = 12;
const DRAFT_ID = '__draft';

type Member = { road: Road; index: number };

export class Editor {
  mode: Mode = 'select';
  selectedId: string | null = null;
  /** ausgewählter Streifen (Querschnitt) */
  selectedStrip: string | null = null;
  /** ausgewählter Abschnitt der Straße (0 = erster) */
  selectedSection = 0;
  /** ausgewählter Knotenpunkt (Kreuzung) */
  selectedNode: string | null = null;
  /** Spurverbindungen des gewählten Knotens bearbeiten (wie im Traffic Manager) */
  laneEdit = false;
  /** gewählte Zufahrtsspur im Spurverbindungs-Modus */
  selectedLane: string | null = null;
  /** Verziehung, deren Streifen gerade in der Karte verbunden werden (Grenz-Schlüssel) */
  transitionEdit: string | null = null;
  /** Verziehungsdaten aus dem letzten Rendern */
  getTransition: (key: string) => TransitionInfo | undefined = () => undefined;
  /** Kreuzungsdaten aus dem letzten Rendern */
  getInfo: (key: string) => JunctionInfo | undefined = () => undefined;
  /** Querschnitt für neu gezeichnete Straßen */
  drawProfile: Strip[] = presetProfile(0);
  /** Selektion oder Modus geändert */
  onChange = () => {};
  /** Klick auf etwas in der Karte (Eigenschaften des getroffenen Elements, oder null) */
  onPick: (props: Record<string, unknown> | null, at: [number, number]) => void = () => {};
  /** Ziehen beginnt (betroffene Straßen) bzw. endet — für schnelles Neuzeichnen */
  onDragStart = (_roadIds: Set<string>) => {};
  onDragEnd = () => {};
  /** Moduswechsel (z. B. um das Kartenfenster zu schließen) */
  onModeChange = (_mode: Mode) => {};
  /** Entwurfsstraße beim Zeichnen geändert */
  onDraft = () => {};

  private draft: LngLat[] = [];
  private hover: LngLat | null = null;
  private hoverSnapped = false;
  private drag: { key: string; members: Member[] } | null = null;
  private suppressClickUntil = 0;

  constructor(private map: MapLibre, private store: Store) {
    map.on('mousedown', 'edit-vertices', (e) => this.startVertexDrag(e));
    map.on('mousedown', 'edit-midpoints', (e) => this.startMidpointDrag(e));
    map.on('contextmenu', 'edit-vertices', (e) => this.deleteVertex(e));
    map.on('mousemove', (e) => this.onMove(e));
    map.on('mouseup', () => this.endDrag());
    map.on('click', (e) => this.onClick(e));
    map.on('dblclick', (e) => {
      if (this.mode !== 'draw') return;
      e.preventDefault();
      this.finishDraft();
    });
    this.enableMiddleButtonPan();
  }

  /** Mittlere Maustaste verschiebt die Karte — auch mitten beim Zeichnen. */
  private enableMiddleButtonPan() {
    const box = this.map.getCanvasContainer();
    box.addEventListener(
      'mousedown',
      (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        let last = { x: e.clientX, y: e.clientY };
        const move = (ev: MouseEvent) => {
          this.map.panBy([last.x - ev.clientX, last.y - ev.clientY], { duration: 0 });
          last = { x: ev.clientX, y: ev.clientY };
        };
        const up = (ev: MouseEvent) => {
          if (ev.button !== 1) return;
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          box.style.cursor = '';
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        box.style.cursor = 'grabbing';
      },
      true,
    );
    // kein Auto-Scroll / Einfügen per Mittelklick
    box.addEventListener('auxclick', (e) => e.button === 1 && e.preventDefault());
  }

  setMode(mode: Mode) {
    this.mode = mode;
    this.onModeChange(mode);
    this.draft = [];
    this.hover = null;
    if (mode === 'draw') {
      this.selectedId = null;
      this.selectedSection = 0;
      this.selectedNode = null;
      this.map.doubleClickZoom.disable();
    } else {
      this.map.doubleClickZoom.enable();
    }
    this.map.getCanvas().style.cursor = mode === 'select' ? '' : 'crosshair';
    this.refreshOverlays();
    this.onDraft();
    this.onChange();
  }

  select(id: string | null, section = 0, strip: string | null = null) {
    this.transitionEdit = null;
    this.selectedStrip = strip;
    this.laneEdit = false;
    this.selectedLane = null;
    this.selectedId = id;
    this.selectedSection = section;
    this.selectedNode = null;
    this.refreshOverlays();
    this.onChange();
  }

  selectNode(key: string | null) {
    this.transitionEdit = null;
    if (key !== this.selectedNode) {
      this.laneEdit = false;
      this.selectedLane = null;
    }
    this.selectedNode = key;
    this.selectedId = null;
    this.refreshOverlays();
    this.onChange();
  }

  /** Straße, die gerade gezeichnet wird — als Vorschau mit echtem Querschnitt */
  draftRoad(): Road | null {
    if (this.mode !== 'draw' || !this.draft.length) return null;
    const points = this.hover ? [...this.draft, this.hover] : this.draft;
    if (points.length < 2) return null;
    return { id: DRAFT_ID, name: '', points, profile: this.drawProfile, smooth: true };
  }

  finishDraft() {
    const pts = this.draft.filter(
      (p, i, a) => i === 0 || Math.abs(p[0] - a[i - 1][0]) + Math.abs(p[1] - a[i - 1][1]) > 1e-8,
    );
    this.draft = [];
    this.hover = null;
    if (pts.length >= 2) {
      this.store.checkpoint();
      const road: Road = {
        id: uid(),
        name: `Straße ${this.store.project.roads.length + 1}`,
        points: pts,
        profile: structuredClone(this.drawProfile).map((s) => ({ ...s, id: uid() })),
        smooth: true,
      };
      this.store.project.roads.push(road);
      connectRoad(this.store.project.roads, road);
      this.store.changed('structure');
      this.selectedId = road.id;
    }
    this.setMode('select');
  }

  /** Esc: erst Werkzeug beenden, dann Spurbearbeitung, dann Auswahl aufheben */
  cancel() {
    if (this.mode !== 'select') this.setMode('select');
    else if (this.laneEdit) {
      this.laneEdit = false;
      this.selectedLane = null;
      this.refreshOverlays();
      this.onChange();
    } else this.select(null);
  }

  /** Koordinate eines Knotens aus seinem Schlüssel */
  nodePoint(key: string): LngLat | null {
    for (const r of this.store.project.roads) for (const p of r.points) if (nodeKey(p) === key) return p;
    return null;
  }

  /** Streifen wählen (Inspektor und Karte bleiben synchron) */
  selectStrip(id: string | null) {
    this.selectedStrip = id;
    this.refreshOverlays();
    this.onChange();
  }

  refreshOverlays() {
    setStripHighlight(this.map, this.selectedStrip);
    const road = this.store.road(this.selectedId);
    const node = this.selectedNode ? this.nodePoint(this.selectedNode) : null;
    if (road) {
      setData(this.map, 'edit-line', {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: road.points } }],
      });
      const starts = new Set((road.sections ?? []).map((x) => x.index));
      setData(this.map, 'edit-vertices', {
        type: 'FeatureCollection',
        features: road.points.map((p, index) => point(p, { index, section: starts.has(index) })),
      });
      setData(this.map, 'edit-midpoints', {
        type: 'FeatureCollection',
        features: road.points.slice(1).map((p, i) => {
          const a = road.points[i];
          return point([(a[0] + p[0]) / 2, (a[1] + p[1]) / 2], { index: i });
        }),
      });
    } else {
      for (const s of ['edit-line', 'edit-vertices', 'edit-midpoints']) setData(this.map, s, EMPTY);
      if (node) setData(this.map, 'edit-vertices', { type: 'FeatureCollection', features: [point(node, { index: -1 })] });
    }

    this.refreshLaneOverlay();

    const draftPts = this.hover ? [...this.draft, this.hover] : this.draft;
    const features: Feature[] = draftPts.map((p, i) =>
      point(p, { snap: this.hoverSnapped && i === draftPts.length - 1 && !!this.hover }),
    );
    if (draftPts.length >= 2)
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: draftPts } });
    setData(this.map, 'draft', { type: 'FeatureCollection', features });
  }

  /** Spurenden und Verbindungskurven des gewählten Knotens bzw. der Verziehung zeigen */
  refreshLaneOverlay() {
    if (this.transitionEdit) return this.refreshTransitionOverlay();
    const info = this.laneEdit && this.selectedNode ? this.getInfo(this.selectedNode) : undefined;
    if (!info) {
      setData(this.map, 'lane-links', EMPTY);
      setData(this.map, 'lane-ends', EMPTY);
      return;
    }
    const sel = this.selectedLane;
    setData(this.map, 'lane-links', {
      type: 'FeatureCollection',
      features: info.links.map((l) => ({
        type: 'Feature',
        properties: { move: l.bike ? 'bike' : l.move, active: l.from === sel, dim: !!sel && l.from !== sel },
        geometry: { type: 'LineString', coordinates: l.pts },
      })),
    });
    setData(this.map, 'lane-ends', {
      type: 'FeatureCollection',
      features: info.lanes.map((l) => point(l.pos, { id: l.id, kind: l.kind, bike: l.bike, selected: l.id === sel })),
    });
  }

  private refreshTransitionOverlay() {
    const t = this.getTransition(this.transitionEdit!);
    if (!t) {
      setData(this.map, 'lane-links', EMPTY);
      setData(this.map, 'lane-ends', EMPTY);
      return;
    }
    const pos = new Map(t.ends.map((e) => [`${e.side}:${e.id}`, e.pos]));
    const sel = this.selectedLane;
    setData(this.map, 'lane-links', {
      type: 'FeatureCollection',
      features: t.pairs
        .filter((p) => p.a && p.b)
        .map((p) => ({
          type: 'Feature',
          properties: { move: 'straight', active: p.a === sel, dim: !!sel && p.a !== sel },
          geometry: { type: 'LineString', coordinates: [pos.get(`a:${p.a}`)!, pos.get(`b:${p.b}`)!] },
        })),
    });
    setData(this.map, 'lane-ends', {
      type: 'FeatureCollection',
      features: t.ends.map((e) => point(e.pos, { id: e.id, kind: e.side === 'a' ? 'in' : 'out', selected: e.id === sel && e.side === 'a' })),
    });
  }

  /** Klick in der Verziehung: Streifen davor wählen, dann Streifen danach verbinden */
  private transitionClick(id: string, kind: 'in' | 'out') {
    const key = this.transitionEdit!;
    const links = (this.store.project.stripLinks ??= {});
    const k = (x: string) => `${key}|${x}`;
    const unlink = (x: string) => {
      const other = links[k(x)];
      delete links[k(x)];
      if (other) delete links[k(other)];
    };
    if (kind === 'in') {
      this.selectedLane = this.selectedLane === id ? null : id;
      return this.refreshLaneOverlay();
    }
    this.store.checkpoint();
    const a = this.selectedLane;
    if (a) {
      const already = links[k(id)] === a;
      unlink(id);
      if (!already) {
        unlink(a);
        links[k(id)] = a;
        links[k(a)] = id;
      }
    } else {
      // ohne gewählten Streifen davor: „entsteht neu“ ein- und ausschalten
      const isNew = links[k(id)] === '';
      unlink(id);
      if (!isNew) links[k(id)] = '';
    }
    this.store.changed('structure');
  }

  /** Klick auf ein Spurende: Zufahrt wählen bzw. Verbindung zur Ausfahrt umschalten */
  private laneClick(e: MapMouseEvent): boolean {
    if (!this.transitionEdit && (!this.laneEdit || !this.selectedNode)) return false;
    const box: [PointLike, PointLike] = [
      [e.point.x - 6, e.point.y - 6],
      [e.point.x + 6, e.point.y + 6],
    ];
    const hit = this.map.queryRenderedFeatures(box, { layers: ['lane-ends'] })[0];
    if (!hit) return false;
    const { id, kind } = hit.properties as { id: string; kind: 'in' | 'out' };
    if (this.transitionEdit) {
      this.transitionClick(id, kind);
      return true;
    }
    if (kind === 'in') {
      this.selectedLane = this.selectedLane === id ? null : id;
      this.refreshLaneOverlay();
      return true;
    }
    if (!this.selectedLane || !this.selectedNode) return true;
    const key = this.selectedNode;
    const info = this.getInfo(key);
    this.store.checkpoint();
    const junctions = (this.store.project.junctions ??= {});
    const st = (junctions[key] ??= defaultJunction());
    const conns = (st.connections ??= {});
    const current = conns[this.selectedLane] ?? info?.links.filter((l) => l.from === this.selectedLane).map((l) => l.to) ?? [];
    conns[this.selectedLane] = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    this.store.changed('structure');
    return true;
  }

  // ---- Interaktion ------------------------------------------------------

  private startVertexDrag(e: MapLayerMouseEvent) {
    const f = e.features?.[0];
    if (this.mode !== 'select' || !f || e.originalEvent.button !== 0) return;
    const index = f.properties!.index as number;
    const road = this.store.road(this.selectedId);
    const p = index < 0 ? (this.selectedNode && this.nodePoint(this.selectedNode)) : road?.points[index];
    if (!p) return;
    e.preventDefault();
    this.store.checkpoint();
    this.startDrag(p);
  }

  /** Ein Knotenpunkt gehört allen Straßen, die ihn teilen — sie werden gemeinsam verschoben. */
  private startDrag(p: LngLat) {
    const key = nodeKey(p);
    const members: Member[] = [];
    for (const r of this.store.project.roads) {
      r.points.forEach((q, i) => {
        if (nodeKey(q) === key) members.push({ road: r, index: i });
      });
    }
    this.drag = { key, members };
    this.onDragStart(new Set(members.map((m) => m.road.id)));
  }

  private startMidpointDrag(e: MapLayerMouseEvent) {
    const f = e.features?.[0];
    const road = this.store.road(this.selectedId);
    if (this.mode !== 'select' || !f || !road || e.originalEvent.button !== 0) return;
    e.preventDefault();
    this.store.checkpoint();
    const index = f.properties!.index + 1;
    insertPoint(road, index, e.lngLat.toArray() as LngLat);
    this.startDrag(road.points[index]);
    this.store.changed('geometry');
  }

  private deleteVertex(e: MapLayerMouseEvent) {
    const road = this.store.road(this.selectedId);
    const f = e.features?.[0];
    if (!road || !f || road.points.length <= 2) return;
    e.preventDefault();
    this.store.checkpoint();
    removePoint(road, f.properties!.index);
    this.store.changed('geometry');
  }

  /** Kreuzungseinstellungen wandern mit, wenn ein Knoten verschoben wird */
  private rekey(from: string, to: string) {
    const j = this.store.project.junctions;
    if (from === to || !j?.[from]) return;
    j[to] = j[from];
    delete j[from];
  }

  private onMove(e: MapMouseEvent) {
    const noSnap = e.originalEvent.altKey;
    if (this.drag) {
      const { members } = this.drag;
      const p = noSnap ? (e.lngLat.toArray() as LngLat) : this.snap(e.point, e.lngLat.toArray() as LngLat, members).p;
      for (const m of members) m.road.points[m.index] = [p[0], p[1]];
      const key = nodeKey(p);
      this.rekey(this.drag.key, key);
      if (this.selectedNode === this.drag.key) this.selectedNode = key;
      this.drag.key = key;
      this.store.changed('geometry');
      return;
    }
    if (this.mode === 'draw') {
      const s = noSnap ? { p: e.lngLat.toArray() as LngLat, snapped: false } : this.snap(e.point, e.lngLat.toArray() as LngLat);
      this.hover = s.p;
      this.hoverSnapped = s.snapped;
      this.refreshOverlays();
      this.onDraft();
      return;
    }
    const overVertex =
      this.selectedId || this.selectedNode
        ? this.map.queryRenderedFeatures(e.point, { layers: ['edit-vertices', 'edit-midpoints'] }).length > 0
        : false;
    this.map.getCanvas().style.cursor = overVertex ? 'move' : '';
  }

  private endDrag() {
    if (!this.drag) return;
    const road = this.drag.members[0]?.road;
    this.drag = null;
    this.onDragEnd();
    this.suppressClickUntil = performance.now() + 100;
    if (road && connectRoad(this.store.project.roads, road)) this.store.changed('structure');
    else this.onChange();
  }

  private onClick(e: MapMouseEvent) {
    if (performance.now() < this.suppressClickUntil) return;
    if (this.mode === 'split') return this.splitAt(e);
    if (this.laneClick(e)) return;
    if (this.mode === 'draw') {
      const p = e.originalEvent.altKey ? (e.lngLat.toArray() as LngLat) : this.snap(e.point, e.lngLat.toArray() as LngLat).p;
      this.draft.push(p);
      this.refreshOverlays();
      this.onDraft();
      return;
    }
    const box: [PointLike, PointLike] = [
      [e.point.x - 3, e.point.y - 3],
      [e.point.x + 3, e.point.y + 3],
    ];
    const hit = this.map.queryRenderedFeatures(box, { layers: SURFACE_LAYERS })[0];
    if (hit?.properties?.node) this.selectNode(hit.properties.node as string);
    else this.select((hit?.properties?.roadId as string) ?? null, (hit?.properties?.section as number) ?? 0, (hit?.properties?.stripId as string) ?? null);
    this.onPick(hit?.properties ?? null, e.lngLat.toArray() as [number, number]);
  }

  /** Teilt die gewählte Straße an der angeklickten Stelle in einen neuen Abschnitt. */
  private splitAt(e: MapMouseEvent) {
    const road = this.store.road(this.selectedId);
    if (!road) return this.setMode('select');
    const px = e.point;
    let best = { d: 25, i: -1, t: 0 };
    for (let i = 0; i < road.points.length - 1; i++) {
      const pa = this.map.project(road.points[i]), pb = this.map.project(road.points[i + 1]);
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px.x - pa.x) * dx + (px.y - pa.y) * dy) / l2));
      const d = Math.hypot(pa.x + t * dx - px.x, pa.y + t * dy - px.y);
      if (d < best.d) best = { d, i, t };
    }
    if (best.i < 0) return;
    this.store.checkpoint();
    const [a, b] = [road.points[best.i], road.points[best.i + 1]];
    const near = (p: typeof a) => {
      const q = this.map.project(p);
      return Math.hypot(q.x - px.x, q.y - px.y) < 10;
    };
    let index: number;
    if (near(a)) index = best.i;
    else if (near(b)) index = best.i + 1;
    else {
      index = best.i + 1;
      insertPoint(road, index, [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t]);
    }
    if (index <= 0 || index >= road.points.length - 1) return this.setMode('select');
    this.selectedSection = ensureSection(road, index);
    this.mode = 'select';
    this.map.getCanvas().style.cursor = '';
    this.store.changed('structure');
    this.refreshOverlays();
    this.onChange();
  }

  /** Halbe Straßenbreite in Pixeln — so weit „zieht“ eine Straße an */
  private halfWidthPx(road: Road, at: LngLat) {
    const half = road.profile.reduce((s, x) => s + x.width, 0) / 2;
    const mpp = (40075016.686 * Math.cos((at[1] * Math.PI) / 180)) / (512 * 2 ** this.map.getZoom());
    return half / mpp;
  }

  /**
   * Fängt an Straßenenden (überall auf der Fahrbahn nahe dem Ende), an Stützpunkten und
   * auf Mittellinien — so entstehen gemeinsame Knoten, aus denen Kreuzungen und
   * nahtlose Übergänge berechnet werden.
   */
  private snap(px: { x: number; y: number }, fallback: LngLat, skip: Member[] = []): { p: LngLat; snapped: boolean } {
    const skipped = (r: Road, i: number) => skip.some((s) => s.road === r && s.index === i);
    const roads = this.store.project.roads;
    let best: LngLat | null = null;
    let bestD = Infinity;
    const consider = (p: LngLat, radius: number) => {
      const q = this.map.project(p);
      const d = Math.hypot(q.x - px.x, q.y - px.y);
      if (d < radius && d < bestD) {
        bestD = d;
        best = p;
      }
    };
    // 1. Straßenenden mit großem Fangradius, dann übrige Stützpunkte
    for (const road of roads) {
      const last = road.points.length - 1;
      road.points.forEach((p, i) => {
        if (skipped(road, i)) return;
        const isEnd = i === 0 || i === last;
        consider(p, isEnd ? Math.max(SNAP_PX + 6, this.halfWidthPx(road, p) + 6) : SNAP_PX);
      });
    }
    this.draft.forEach((p) => consider(p, SNAP_PX));
    if (best) return { p: [best[0], best[1]], snapped: true };

    // 2. Mittellinien: nächster Punkt auf einer Strecke, interpoliert in Grad → liegt exakt darauf
    for (const road of roads) {
      const radius = Math.max(SNAP_PX, this.halfWidthPx(road, road.points[0]) * 0.8);
      for (let i = 0; i < road.points.length - 1; i++) {
        if (skipped(road, i) || skipped(road, i + 1)) continue;
        const [a, b] = [road.points[i], road.points[i + 1]];
        const pa = this.map.project(a), pb = this.map.project(b);
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const l2 = dx * dx + dy * dy;
        if (l2 < 1) continue;
        const t = Math.max(0, Math.min(1, ((px.x - pa.x) * dx + (px.y - pa.y) * dy) / l2));
        const d = Math.hypot(pa.x + t * dx - px.x, pa.y + t * dy - px.y);
        if (d < radius && d < bestD) {
          bestD = d;
          best = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        }
      }
    }
    return best ? { p: best, snapped: true } : { p: fallback, snapped: false };
  }
}

function point(coordinates: LngLat, properties: Record<string, unknown>): Feature {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates } };
}
