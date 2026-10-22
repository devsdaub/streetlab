import type { Map as MapLibre, MapLayerMouseEvent, MapMouseEvent, PointLike } from 'maplibre-gl';
import type { Feature } from 'geojson';
import { EMPTY, SURFACE_LAYERS, setData, setStripHighlight } from './map';
import type { JunctionInfo } from './junction';
import type { TransitionInfo } from './render';
import { cleanPoints, defaultJunction, ensureSection, insertPoint, leftEdge, presetProfile, removePoint, sectionProfile, uid, type LngLat, type Road, type Strip } from './model';
import { localProjection, tangentArc, type Vec } from './geometry';
import { nodeKey } from './render';
import { roadOutline } from './brush';
import type { Store } from './store';
import { connectRoad } from './topology';

/**
 * import: Bereich für „Bestand übernehmen“ umfahren (osmimport.ts), section: Abschnitt entlang einer
 * Straße ziehen (brush.ts) — in beiden gehört die Maus dem jeweiligen Werkzeug. curve: Kreisbogen
 * mit festem Radius, tangential aus einem Straßenende oder einer gewählten Richtung.
 */
export type Mode = 'select' | 'draw' | 'split' | 'import' | 'section' | 'curve' | 'roundabout';
/** Modi, in denen die Maus einem eigenen Werkzeug gehört (osmimport.ts, brush.ts, roundabout.ts) */
const EXTERNAL: Mode[] = ['import', 'section', 'roundabout'];

const SNAP_PX = 12;

/** Querversatz der Kante rechts von Streifen k (k = −1: linke Außenkante), + = links */
const edgeOffset = (profile: Strip[], k: number) => leftEdge(profile) - profile.slice(0, k + 1).reduce((s, x) => s + x.width, 0);
const DRAFT_ID = '__draft';

type Member = { road: Road; index: number };
/** Hilfslinie des Richtungsfangs: vom letzten Punkt in Fangrichtung, mit Beschriftung */
type Guide = { from: LngLat; to: LngLat; label: string };

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
  /** Fang an/aus (Schalter in der Werkzeugleiste); Alt kehrt ihn jeweils um */
  snapping = true;
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
  private guide: Guide | null = null;
  /** Kurven-Werkzeug: Anfang und Anfangsrichtung (lokal in m, null = per zweitem Klick wählen) */
  private curve: { start: LngLat; dir: Vec | null } | null = null;
  /** Vorschau des Bogens bis zum Cursor */
  private arc: { pts: LngLat[]; label: string; endDir: Vec } | null = null;
  /** Länge und Fangart am Cursor beim Zeichnen */
  private label: HTMLDivElement;
  private drag: { key: string; members: Member[] } | null = null;
  /** ganze Straße verschieben: Ausgangspunkt und ursprüngliche Lage aller bewegten Punkte */
  private roadDrag: { origin: LngLat; start: { x: number; y: number }; moved: boolean; items: { road: Road; index: number; orig: LngLat; key: string }[] } | null = null;
  /** Streifenbreite an einer Kante ziehen */
  private widthDrag: {
    road: Road;
    profile: Strip[];
    k: number;
    origin: Vec;
    n: Vec;
    proj: ReturnType<typeof localProjection>;
    widths: number[];
    boundary: number;
  } | null = null;
  private suppressClickUntil = 0;

  constructor(private map: MapLibre, private store: Store) {
    this.label = document.createElement('div');
    this.label.className = 'snap-label';
    map.getContainer().append(this.label);
    map.on('mousedown', 'width-handles', (e) => this.startWidthDrag(e));
    map.on('mousedown', (e) => this.startRoadDrag(e));
    map.on('mousedown', 'edit-vertices', (e) => this.startVertexDrag(e));
    map.on('mousedown', 'edit-midpoints', (e) => this.startMidpointDrag(e));
    map.on('contextmenu', 'edit-vertices', (e) => this.deleteVertex(e));
    map.on('mousemove', (e) => this.onMove(e));
    map.on('mouseup', () => this.endDrag());
    map.on('click', (e) => this.onClick(e));
    map.on('dblclick', (e) => {
      if (this.mode !== 'draw' && this.mode !== 'curve') return;
      e.preventDefault();
      if (this.mode === 'draw') this.finishDraft();
      else this.setMode('select');
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
    this.guide = null;
    this.curve = null;
    this.arc = null;
    this.showLabel(null);
    if (mode === 'draw' || mode === 'curve') {
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
    if (this.mode === 'curve') {
      const pts = this.curveLine();
      return pts ? { id: DRAFT_ID, name: '', points: pts, profile: this.drawProfile, smooth: true } : null;
    }
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
      const h = this.mode === 'select' && !this.laneEdit ? this.widthHandleFrame(road) : null;
      if (h) {
        let off = leftEdge(h.profile);
        const at = (o: number) => h.proj.inv([h.p[0] + h.n[0] * o, h.p[1] + h.n[1] * o]);
        const handles = [point(at(off), { k: -1 })];
        h.profile.forEach((x, k) => {
          off -= x.width;
          handles.push(point(at(off), { k }));
        });
        setData(this.map, 'width-handles', { type: 'FeatureCollection', features: handles });
      } else setData(this.map, 'width-handles', EMPTY);
      setData(this.map, 'edit-midpoints', {
        type: 'FeatureCollection',
        features: road.points.slice(1).map((p, i) => {
          const a = road.points[i];
          return point([(a[0] + p[0]) / 2, (a[1] + p[1]) / 2], { index: i });
        }),
      });
    } else {
      for (const s of ['edit-line', 'edit-vertices', 'edit-midpoints', 'width-handles']) setData(this.map, s, EMPTY);
      if (node) setData(this.map, 'edit-vertices', { type: 'FeatureCollection', features: [point(node, { index: -1 })] });
    }

    this.refreshLaneOverlay();

    const curving = this.mode === 'curve';
    const draftPts = curving
      ? [this.curve?.start, this.hover].filter((p): p is LngLat => !!p)
      : this.hover
        ? [...this.draft, this.hover]
        : this.draft;
    const features: Feature[] = draftPts.map((p, i) =>
      point(p, { snap: this.hoverSnapped && i === draftPts.length - 1 && !!this.hover }),
    );
    const line = curving ? this.curveLine() : draftPts.length >= 2 ? draftPts : null;
    if (line) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
    // Straße, an die gerade angeschlossen würde, blau umranden
    const target = (this.mode === 'draw' || curving) && this.hover && this.hoverSnapped ? this.roadAt(this.hover)?.road : undefined;
    setData(this.map, 'affected', {
      type: 'FeatureCollection',
      features: target ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [roadOutline(target)] } }] : [],
    });
    if (this.guide && this.hover)
      features.push({ type: 'Feature', properties: { guide: true }, geometry: { type: 'LineString', coordinates: [this.guide.from, this.guide.to] } });
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
    // Alt: nur den Punkt der gewählten Straße bewegen — löst ihn vom Knoten
    if (e.originalEvent.altKey && road && index >= 0) this.startDrag(p, [{ road, index }]);
    else this.startDrag(p);
  }

  /** Ein Knotenpunkt gehört allen Straßen, die ihn teilen — sie werden gemeinsam verschoben. */
  private startDrag(p: LngLat, only?: Member[]) {
    const key = nodeKey(p);
    const members: Member[] = only ?? [];
    if (!only) {
      for (const r of this.store.project.roads) {
        r.points.forEach((q, i) => {
          if (nodeKey(q) === key) members.push({ road: r, index: i });
        });
      }
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

  /** Klick auf die Fläche der gewählten Straße und ziehen: ganze Straße verschieben */
  private startRoadDrag(e: MapMouseEvent) {
    if (this.mode !== 'select' || !this.selectedId || e.originalEvent.button !== 0 || this.laneEdit) return;
    const p = e.point;
    const handles = this.map.queryRenderedFeatures([p.x, p.y], { layers: ['edit-vertices', 'edit-midpoints', 'width-handles'] });
    if (handles.length) return;
    const box: [PointLike, PointLike] = [
      [p.x - 2, p.y - 2],
      [p.x + 2, p.y + 2],
    ];
    const road = this.store.road(this.selectedId);
    // auch die Kreuzungsflächen an den Knoten der gewählten Straße gehören zum Greifbereich
    const nodes = new Set(road?.points.map((q) => nodeKey(q)));
    const hit = this.map
      .queryRenderedFeatures(box, { layers: SURFACE_LAYERS })
      .find((f) => f.properties?.roadId === this.selectedId || (f.properties?.node && nodes.has(f.properties.node)));
    if (!hit || !road) return;
    e.preventDefault();
    const detach = e.originalEvent.altKey;
    const items: { road: Road; index: number; orig: LngLat; key: string }[] = [];
    road.points.forEach((q, index) => {
      const key = nodeKey(q);
      items.push({ road, index, orig: [q[0], q[1]], key });
      // angeschlossene Straßen bleiben verbunden (ihre Knotenpunkte wandern mit), außer mit Alt
      if (detach) return;
      for (const r of this.store.project.roads) {
        if (r === road) continue;
        r.points.forEach((x, i) => nodeKey(x) === key && items.push({ road: r, index: i, orig: [x[0], x[1]], key }));
      }
    });
    // erst ab 4 px Bewegung wird verschoben — ein einfacher Klick wählt weiter einen Streifen
    this.roadDrag = { origin: e.lngLat.toArray() as LngLat, start: { x: p.x, y: p.y }, moved: false, items };
  }

  /** Griff an einer Streifenkante: Breite ändern, die Kante folgt der Maus */
  private startWidthDrag(e: MapLayerMouseEvent) {
    const f = e.features?.[0];
    const road = this.store.road(this.selectedId);
    if (this.mode !== 'select' || !f || !road || e.originalEvent.button !== 0) return;
    e.preventDefault();
    const h = this.widthHandleFrame(road);
    if (!h) return;
    this.store.checkpoint();
    const k = f.properties!.k as number;
    const boundary = edgeOffset(h.profile, k);
    this.widthDrag = { road, profile: h.profile, k, origin: h.p, n: h.n, proj: h.proj, widths: h.profile.map((x) => x.width), boundary };
    this.onDragStart(new Set([road.id]));
  }

  /** Lage der Breiten-Griffe: Mitte des gewählten Abschnitts, quer zur Straße */
  private widthHandleFrame(road: Road) {
    const k = Math.min(this.selectedSection, road.sections?.length ?? 0);
    const from = k === 0 ? 0 : road.sections![k - 1].index;
    const to = road.sections?.[k]?.index ?? road.points.length - 1;
    const pts = road.points.slice(from, to + 1);
    if (pts.length < 2) return null;
    const proj = localProjection(pts[0]);
    const local = pts.map(proj.fwd);
    const total = local.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - local[i - 1][0], q[1] - local[i - 1][1]) : 0), 0);
    let acc = 0;
    for (let i = 1; i < local.length; i++) {
      const [a, b] = [local[i - 1], local[i]];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc + l >= total / 2 && l > 0) {
        const u = (total / 2 - acc) / l;
        const p: Vec = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
        const n: Vec = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
        return { p, n, proj, profile: sectionProfile(road, k) };
      }
      acc += l;
    }
    return null;
  }

  private onMove(e: MapMouseEvent) {
    if (EXTERNAL.includes(this.mode)) return;
    if (this.roadDrag) {
      if (!this.roadDrag.moved) {
        if (Math.hypot(e.point.x - this.roadDrag.start.x, e.point.y - this.roadDrag.start.y) < 4) return;
        this.roadDrag.moved = true;
        this.store.checkpoint();
        this.map.getCanvas().style.cursor = 'grabbing';
        this.onDragStart(new Set(this.roadDrag.items.map((x) => x.road.id)));
      }
      const [lng, lat] = e.lngLat.toArray();
      const [dx, dy] = [lng - this.roadDrag.origin[0], lat - this.roadDrag.origin[1]];
      const keys = new Map<string, string>();
      for (const it of this.roadDrag.items) {
        it.road.points[it.index] = [it.orig[0] + dx, it.orig[1] + dy];
        keys.set(it.key, nodeKey(it.road.points[it.index]));
      }
      // Kreuzungseinstellungen wandern mit
      for (const it of this.roadDrag.items) {
        const now = keys.get(it.key)!;
        if (now !== it.key) {
          this.rekey(it.key, now);
          it.key = now;
          it.orig = [it.road.points[it.index][0] - dx, it.road.points[it.index][1] - dy];
        }
      }
      this.store.changed('geometry');
      return;
    }
    if (this.widthDrag) {
      const w = this.widthDrag;
      const m = w.proj.fwd(e.lngLat.toArray() as LngLat);
      const o = (m[0] - w.origin[0]) * w.n[0] + (m[1] - w.origin[1]) * w.n[1];
      // Kante folgt der Maus. Wie stark sie sich mit der Breite bewegt, hängt davon ab, ob der
      // Streifen zur Fahrbahn gehört (deren Mitte bleibt auf der Linie) — daher ausrechnen
      const i = Math.max(0, w.k);
      const trial = (width: number) => edgeOffset(w.profile.map((x, j) => ({ ...x, width: j === i ? width : w.widths[j] })), w.k);
      const slope = trial(w.widths[i] + 1) - trial(w.widths[i]) || 1;
      const width = w.widths[i] + (o - w.boundary) / slope;
      w.profile[i].width = Math.max(0.3, Math.round(width * 20) / 20);
      this.store.changed('geometry');
      return;
    }
    const noSnap = this.noSnap(e);
    if (this.drag) {
      const { members } = this.drag;
      // freies Straßenende (nur eine Straße, erster/letzter Punkt): großzügig einrasten
      const free = members.length === 1 && (members[0].index === 0 || members[0].index === members[0].road.points.length - 1);
      const p = noSnap ? (e.lngLat.toArray() as LngLat) : this.snap(e.point, e.lngLat.toArray() as LngLat, members, free).p;
      for (const m of members) m.road.points[m.index] = [p[0], p[1]];
      const key = nodeKey(p);
      this.rekey(this.drag.key, key);
      if (this.selectedNode === this.drag.key) this.selectedNode = key;
      this.drag.key = key;
      this.store.changed('geometry');
      return;
    }
    if (this.mode === 'curve') {
      const s = noSnap ? { p: e.lngLat.toArray() as LngLat, snapped: false } : this.snap(e.point, e.lngLat.toArray() as LngLat);
      this.hover = s.p;
      this.hoverSnapped = s.snapped;
      this.arc = this.curveArc(s.p);
      this.showLabel(e.point);
      this.refreshOverlays();
      this.onDraft();
      return;
    }
    if (this.mode === 'draw') {
      const s = noSnap ? { p: e.lngLat.toArray() as LngLat, snapped: false, guide: null } : this.snapDraw(e.point, e.lngLat.toArray() as LngLat);
      this.hover = s.p;
      this.hoverSnapped = s.snapped;
      this.guide = s.guide;
      this.showLabel(e.point);
      this.refreshOverlays();
      this.onDraft();
      return;
    }
    const overVertex =
      this.selectedId || this.selectedNode
        ? this.map.queryRenderedFeatures(e.point, { layers: ['edit-vertices', 'edit-midpoints', 'width-handles'] }).length > 0
        : false;
    this.map.getCanvas().style.cursor = overVertex ? 'move' : '';
  }

  private endDrag() {
    if (this.roadDrag) {
      const { moved } = this.roadDrag;
      this.roadDrag = null;
      if (!moved) return; // nur geklickt: normale Auswahl per click-Ereignis
      this.map.getCanvas().style.cursor = '';
      this.onDragEnd();
      this.suppressClickUntil = performance.now() + 100;
      // Verschieben ändert die Verknüpfung nicht (hin und zurück ergibt wieder denselben Stand)
      this.store.changed('structure');
      return;
    }
    if (this.widthDrag) {
      this.widthDrag = null;
      this.onDragEnd();
      this.suppressClickUntil = performance.now() + 100;
      this.store.changed('structure');
      return;
    }
    if (!this.drag) return;
    const road = this.drag.members[0]?.road;
    this.drag = null;
    this.onDragEnd();
    this.suppressClickUntil = performance.now() + 100;
    // Punkt auf einen Nachbarpunkt gezogen: doppelte Punkte (Stücke ohne Länge) entfernen
    let cleaned = false;
    for (const r of this.store.project.roads) cleaned = cleanPoints(r) || cleaned;
    // nur einrasten lassen, keine neuen Kreuzungen durch das Ziehen
    if ((road && connectRoad(this.store.project.roads, road, false)) || cleaned) this.store.changed('structure');
    else this.onChange();
  }

  private onClick(e: MapMouseEvent) {
    if (performance.now() < this.suppressClickUntil || EXTERNAL.includes(this.mode)) return;
    if (this.mode === 'split') return this.splitAt(e);
    if (this.laneClick(e)) return;
    if (this.mode === 'curve') return this.curveClick(e);
    if (this.mode === 'draw') {
      const p = this.noSnap(e) ? (e.lngLat.toArray() as LngLat) : this.snapDraw(e.point, e.lngLat.toArray() as LngLat).p;
      this.draft.push(p);
      this.guide = null;
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
  /**
   * generous: großer Fangradius (ganze Fahrbahnbreite) — beim Zeichnen und für ein freies
   * Straßenende. Bestehende Knoten und Zwischenpunkte rasten nur knapp ein, sonst entstehen
   * beim Verschieben ungewollt neue Verbindungen.
   */
  private snap(px: { x: number; y: number }, fallback: LngLat, skip: Member[] = [], generous = true): { p: LngLat; snapped: boolean; kind?: 'point' | 'line' } {
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
        consider(p, isEnd && generous ? Math.max(SNAP_PX + 6, this.halfWidthPx(road, p) + 6) : SNAP_PX);
      });
    }
    this.draft.forEach((p) => consider(p, SNAP_PX));
    if (best) return { p: [best[0], best[1]], snapped: true, kind: 'point' };

    // 2. Mittellinien: nächster Punkt auf einer Strecke, interpoliert in Grad → liegt exakt darauf
    for (const road of roads) {
      const radius = generous ? Math.max(SNAP_PX, this.halfWidthPx(road, road.points[0]) * 0.8) : SNAP_PX;
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
    return best ? { p: best, snapped: true, kind: 'line' } : { p: fallback, snapped: false };
  }

  /**
   * Fang beim Zeichnen: zuerst Punkte (Straßenenden, Stützpunkte), dann Richtungen vom letzten
   * Punkt aus — geradeaus, 90° und 45° zum vorigen Stück bzw. zur Straße, an der begonnen wurde,
   * parallel oder rechtwinklig zu Straßen in der Nähe. Trifft die Richtung eine Straße, rastet der
   * Punkt genau auf dem Schnitt ein; sonst wird die Länge auf ganze Meter gerundet.
   */
  private snapDraw(px: { x: number; y: number }, fallback: LngLat): { p: LngLat; snapped: boolean; guide: Guide | null } {
    const base = this.snap(px, fallback);
    const anchor = this.draft[this.draft.length - 1];
    if (!anchor || base.kind === 'point') return { ...base, guide: null };
    const A = this.map.project(anchor);
    const unit = (x: number, y: number): Vec => {
      const l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    };
    const rot = (d: Vec, deg: number): Vec => {
      const r = (deg * Math.PI) / 180;
      return [d[0] * Math.cos(r) - d[1] * Math.sin(r), d[0] * Math.sin(r) + d[1] * Math.cos(r)];
    };
    const dirs: { d: Vec; label: string }[] = [];
    const family = (d: Vec, straight: string, square: string, diagonal: string) => {
      dirs.push({ d, label: straight });
      for (const s of [90, -90]) dirs.push({ d: rot(d, s), label: square });
      for (const s of [45, -45]) dirs.push({ d: rot(d, s), label: diagonal });
    };
    if (this.draft.length >= 2) {
      const P = this.map.project(this.draft[this.draft.length - 2]);
      family(unit(A.x - P.x, A.y - P.y), 'geradeaus', '90°', '45°');
    } else {
      // begonnen an einer Straße: Verlängerung am Ende, sonst rechtwinklig abzweigen
      const at = this.roadAt(anchor);
      if (at) {
        const { road, i, t } = at;
        const [a, b] = [this.map.project(road.points[i]), this.map.project(road.points[i + 1])];
        const d = unit(b.x - a.x, b.y - a.y);
        const atStart = i === 0 && t < 1e-6, atEnd = i === road.points.length - 2 && t > 1 - 1e-6;
        if (atStart || atEnd) family(atEnd ? d : ([-d[0], -d[1]] as Vec), 'Verlängerung', '90° zur Straße', '45° zur Straße');
        else for (const s of [90, -90, 45, -45, 135, -135]) dirs.push({ d: rot(d, s), label: Math.abs(s) === 90 ? 'rechtwinklig' : '45° zur Straße' });
      }
    }
    // Straßen in Cursornähe: parallel bzw. rechtwinklig dazu
    for (const road of this.store.project.roads) {
      for (let i = 0; i < road.points.length - 1; i++) {
        const [a, b] = [this.map.project(road.points[i]), this.map.project(road.points[i + 1])];
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        if (l2 < 100) continue;
        const t = Math.max(0, Math.min(1, ((px.x - a.x) * dx + (px.y - a.y) * dy) / l2));
        if (Math.hypot(a.x + t * dx - px.x, a.y + t * dy - px.y) > 60) continue;
        const d = unit(dx, dy);
        for (const s of [0, 180]) dirs.push({ d: rot(d, s), label: `parallel zu ${road.name}` });
        for (const s of [90, -90]) dirs.push({ d: rot(d, s), label: `rechtwinklig zu ${road.name}` });
      }
    }

    // passendste Richtung: Fangzone wächst mit dem Abstand (etwa 5°), mindestens 6, höchstens 14 px
    let hit: { d: Vec; label: string; along: number; perp: number } | null = null;
    for (const { d, label } of dirs) {
      const vx = px.x - A.x, vy = px.y - A.y;
      const along = vx * d[0] + vy * d[1];
      const perp = Math.abs(vx * d[1] - vy * d[0]);
      if (along < 12 || perp > Math.min(14, Math.max(6, along * 0.09))) continue;
      if (!hit || perp < hit.perp - 0.5) hit = { d, label, along, perp };
    }
    if (!hit) return { ...base, guide: null };

    const mpp = (40075016.686 * Math.cos((anchor[1] * Math.PI) / 180)) / (512 * 2 ** this.map.getZoom());
    const guide = (along: number, label: string): Guide => ({
      from: anchor,
      to: this.map.unproject([A.x + hit!.d[0] * (along + 80), A.y + hit!.d[1] * (along + 80)]).toArray() as LngLat,
      label,
    });
    // Schnitt des Strahls mit einer Straße nahe dem Cursor → exakt auf deren Mittellinie
    let cross: { p: LngLat; dist: number; along: number } | null = null;
    for (const road of this.store.project.roads) {
      for (let i = 0; i < road.points.length - 1; i++) {
        const [a, b] = [this.map.project(road.points[i]), this.map.project(road.points[i + 1])];
        const ex = b.x - a.x, ey = b.y - a.y;
        const den = hit.d[0] * ey - hit.d[1] * ex;
        if (Math.abs(den) < 1e-6) continue;
        const wx = a.x - A.x, wy = a.y - A.y;
        const s = (wx * ey - wy * ex) / den; // entlang des Strahls (px)
        const t = (wx * hit.d[1] - wy * hit.d[0]) / den; // auf der Straße (0…1)
        if (s < 12 || t < 0 || t > 1) continue;
        const dist = Math.hypot(A.x + hit.d[0] * s - px.x, A.y + hit.d[1] * s - px.y);
        if (dist > 16 || (cross && dist >= cross.dist)) continue;
        const [p, q] = [road.points[i], road.points[i + 1]];
        cross = { p: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], dist, along: s };
      }
    }
    if (cross) return { p: cross.p, snapped: true, guide: guide(cross.along, `${hit.label} · Anschluss`) };

    // sonst Länge auf ganze Meter
    const metres = Math.max(1, Math.round(hit.along * mpp));
    const along = metres / mpp;
    const p = this.map.unproject([A.x + hit.d[0] * along, A.y + hit.d[1] * along]).toArray() as LngLat;
    return { p, snapped: true, guide: guide(along, hit.label) };
  }

  // ---- Kurven-Werkzeug -----------------------------------------------------

  /** Vorschau-Linie: Bogen, oder gerade Linie, solange die Richtung noch gewählt wird */
  private curveLine(): LngLat[] | null {
    if (this.arc) return this.arc.pts;
    return this.curve && this.hover ? [this.curve.start, this.hover] : null;
  }

  /** Bogen vom Anfang bis `end` mit Beschriftung: Länge · Radius · Winkel zur Zielstraße */
  private curveArc(end: LngLat): { pts: LngLat[]; label: string; endDir: Vec } | null {
    if (!this.curve?.dir) return null;
    const proj = localProjection(this.curve.start);
    const r = tangentArc([0, 0], this.curve.dir, proj.fwd(end));
    if (!r || r.length < 1) return null;
    const parts = [`${Math.round(r.length)} m`, Number.isFinite(r.radius) && r.radius < 5000 ? `r ${Math.round(r.radius)} m` : 'gerade'];
    // endet auf einer Straße: Winkel zwischen Bogenende und Straße (flach = sanftes Einfädeln)
    const at = this.roadAt(end);
    if (at) {
      const [a, b] = [proj.fwd(at.road.points[at.i]), proj.fwd(at.road.points[at.i + 1])];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const cos = Math.abs((r.endDir[0] * (b[0] - a[0]) + r.endDir[1] * (b[1] - a[1])) / l);
      parts.push(`∠ ${Math.round((Math.acos(Math.min(1, cos)) * 180) / Math.PI)}°`);
    }
    const pts = r.pts.map(proj.inv);
    pts[0] = this.curve.start;
    pts[pts.length - 1] = end;
    return { pts, label: parts.join(' · '), endDir: r.endDir };
  }

  /** Richtung aus einem Straßenende heraus (nur wenn genau eine Straße dort endet) */
  private endDirAt(p: LngLat): Vec | null {
    const key = nodeKey(p);
    const ends: [LngLat, LngLat][] = [];
    for (const r of this.store.project.roads) {
      const n = r.points.length;
      if (n < 2) continue;
      if (nodeKey(r.points[0]) === key) ends.push([r.points[1], r.points[0]]);
      else if (nodeKey(r.points[n - 1]) === key) ends.push([r.points[n - 2], r.points[n - 1]]);
    }
    if (ends.length !== 1) return null;
    const proj = localProjection(p);
    const [a, b] = ends[0].map(proj.fwd);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return l > 0.01 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : null;
  }

  /** 1. Klick Anfang, (2. Klick Richtung,) dann je Klick ein Bogen — weiter tangential bis Esc */
  private curveClick(e: MapMouseEvent) {
    const p = this.noSnap(e) ? (e.lngLat.toArray() as LngLat) : this.snap(e.point, e.lngLat.toArray() as LngLat).p;
    if (!this.curve) {
      this.curve = { start: p, dir: this.endDirAt(p) };
    } else if (!this.curve.dir) {
      const v = localProjection(this.curve.start).fwd(p);
      const l = Math.hypot(v[0], v[1]);
      if (l < 1) return;
      this.curve.dir = [v[0] / l, v[1] / l];
    } else {
      const arc = this.curveArc(p);
      if (!arc) return;
      this.store.checkpoint();
      const road: Road = {
        id: uid(),
        name: `Straße ${this.store.project.roads.length + 1}`,
        points: arc.pts,
        profile: structuredClone(this.drawProfile).map((s) => ({ ...s, id: uid() })),
        smooth: true,
      };
      this.store.project.roads.push(road);
      connectRoad(this.store.project.roads, road);
      this.store.changed('structure');
      // tangential weiterbauen
      this.curve = { start: p, dir: arc.endDir };
    }
    this.arc = null;
    this.hover = null;
    this.showLabel(null);
    this.refreshOverlays();
    this.onDraft();
  }

  /** Fang für dieses Mausereignis aus? (Schalter aus, oder Alt gedrückt — Alt kehrt den Schalter um) */
  private noSnap(e: MapMouseEvent) {
    return e.originalEvent.altKey === this.snapping;
  }

  /** Länge des Stücks vom letzten Punkt bis zum Cursor und die Fangart neben dem Cursor */
  private showLabel(at: { x: number; y: number } | null) {
    if (this.mode === 'curve') {
      const text = this.arc?.label ?? (this.curve && !this.curve.dir ? 'Klick legt die Anfangsrichtung fest' : '');
      if (!at || !text) {
        this.label.style.display = 'none';
        return;
      }
      this.label.textContent = text;
      this.label.dataset.guide = this.arc ? 'on' : '';
      this.label.style.display = 'block';
      this.label.style.transform = `translate(${Math.round(at.x + 16)}px, ${Math.round(at.y + 14)}px)`;
      return;
    }
    const anchor = this.draft[this.draft.length - 1];
    if (!at || !anchor || !this.hover || this.mode !== 'draw') {
      this.label.style.display = 'none';
      return;
    }
    const k = Math.cos((anchor[1] * Math.PI) / 180);
    const m = Math.hypot((this.hover[0] - anchor[0]) * 111320 * k, (this.hover[1] - anchor[1]) * 111320);
    this.label.textContent = `${m.toFixed(m < 10 ? 1 : 0).replace('.', ',')} m${this.guide ? ' · ' + this.guide.label : ''}`;
    this.label.dataset.guide = this.guide ? 'on' : '';
    this.label.style.display = 'block';
    this.label.style.transform = `translate(${Math.round(at.x + 16)}px, ${Math.round(at.y + 14)}px)`;
  }

  /** Straßenstück, auf dem ein Punkt liegt (Stützpunkt oder auf einer Strecke) */
  private roadAt(p: LngLat): { road: Road; i: number; t: number } | null {
    const key = nodeKey(p);
    for (const road of this.store.project.roads) {
      const n = road.points.length;
      for (let i = 0; i < n - 1; i++) {
        if (nodeKey(road.points[i]) === key) return { road, i, t: 0 };
        if (nodeKey(road.points[i + 1]) === key) return { road, i, t: 1 };
        const [a, b] = [road.points[i], road.points[i + 1]];
        const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        if (l2 < 1e-18) continue;
        const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
        if (t <= 0 || t >= 1) continue;
        if (Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) < 1e-7) return { road, i, t };
      }
    }
    return null;
  }
}

function point(coordinates: LngLat, properties: Record<string, unknown>): Feature {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates } };
}
