import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { Editor } from './editor';
import { EMPTY, createMap, setChunked, setData, watchBasemapErrors, type Basemap } from './map';
import { MapEditor } from './mapedit';
import { OsmImporter } from './osmimport';
import { SectionBrush } from './brush';
import { RoundaboutTool } from './roundabout';
import { Panel } from './panel';
import { SimView } from './simview';
import { Toolbar } from './toolbar';
import { RoadRenderer, nodeKey, type Built } from './render';
import type { Road } from './model';
import type { FeatureCollection } from 'geojson';
import { Store } from './store';

const store = await Store.load();
const map = createMap(document.getElementById('map')!, store.project.view, (store.project.basemap as Basemap) ?? 'sat');
const roads = new RoadRenderer();
const draft = new RoadRenderer();
let built: Built = { surfaces: EMPTY, markings: EMPTY, decor: EMPTY };

// Kachelfehler kommen teils schon vor 'load' — daher sofort mitzählen, Anzeige folgt mit dem Panel
const basemapFailed = new Set<string>();
let basemapNotice = () => {};
watchBasemapErrors(map, (id) => {
  basemapFailed.add(id);
  basemapNotice();
});

if (import.meta.env.DEV) (window as any).__streetlab = { map, store };

map.on('load', () => {
  const editor = new Editor(map, store);
  editor.getInfo = (key) => built.junctions?.get(key);
  editor.getTransition = (key) => built.transitions?.get(key);
  // Bearbeiten direkt in der Karte
  const mapEditor = new MapEditor(document.getElementById('dock')!, store, editor, () => built);
  editor.onPick = (props, at) => {
    if (props?.transition) mapEditor.open({ kind: 'transition', key: props.transition as string, at });
    else if (props?.node) mapEditor.open({ kind: 'node', key: props.node as string, at });
    else if (props?.stripId) mapEditor.open({ kind: 'strip', roadId: props.roadId as string, stripId: props.stripId as string, at });
    else mapEditor.close();
  };
  // Bestand aus OpenStreetMap übernehmen
  const importer = new OsmImporter(map, store, editor);
  importer.dock = mapEditor;
  if (import.meta.env.DEV) (window as any).__streetlab.importer = importer;
  // Abschnitt entlang einer Straße ziehen
  const brush = new SectionBrush(map, store, editor);
  // Kreisverkehr auf eine Kreuzung aufziehen
  const roundabout = new RoundaboutTool(map, store, editor);
  editor.onModeChange = (mode) => {
    if (mode !== 'select') mapEditor.close();
    if (mode !== 'import') importer.reset();
    if (mode !== 'section') brush.reset();
    if (mode !== 'roundabout') roundabout.reset();
  };
  if (import.meta.env.DEV) (window as any).__streetlab.editor = editor;
  const panel = new Panel(document.getElementById('panel')!, map, store, editor, () => built);
  const toolbar = new Toolbar(document.getElementById('toolbar')!, map, store, editor);
  panel.onRender = () => toolbar.render();
  brush.profile = () => toolbar.currentPreset();
  panel.basemapFailed = basemapFailed;
  basemapNotice = () => panel.render();
  panel.dock = toolbar.dock = mapEditor;
  // Verkehrssimulation
  const simView = new SimView(map, store, () => built);
  panel.sim = toolbar.sim = simView;
  simView.onChange = () => panel.render();
  simView.onStats = (s) => panel.showStats(s);
  if (import.meta.env.DEV) (window as any).__streetlab.sim = simView;
  panel.render(); // zeigt Simulationsbereich und Start-Knopf

  // höchstens einmal pro Frame neu berechnen — beim Ziehen kommen viele Events
  let pending = false;
  /** Straßen, die gerade gezogen werden, samt Nachbarn (null = keine Bearbeitung) */
  let active: { show: Set<string>; build: Set<string>; nodes: Set<string> } | null = null;
  const activeRenderer = new RoadRenderer();
  const opts = () => ({ style: store.project.markingStyle ?? 'de', traffic: !!store.project.traffic, links: store.project.stripLinks });
  const pick = (fc: FeatureCollection, keep: (p: any) => boolean): FeatureCollection => ({
    type: 'FeatureCollection',
    features: fc.features.filter((f) => keep(f.properties)),
  });

  /** Nachbarschaft: Straßen, die mit den gezogenen einen Punkt teilen (zwei Ringe weit) */
  const neighbourhood = (ids: Set<string>) => {
    const roadsAll = store.project.roads;
    const keysOf = (r: Road) => new Set(r.points.map(nodeKey));
    const ring = (set: Set<string>) => {
      const keys = new Set<string>();
      for (const r of roadsAll) if (set.has(r.id)) for (const k of keysOf(r)) keys.add(k);
      const out = new Set(set);
      for (const r of roadsAll) if (r.points.some((p) => keys.has(nodeKey(p)))) out.add(r.id);
      return { roads: out, keys };
    };
    // neu berechnet wird die Umgebung (zwei Ringe, damit Kreuzungen alle Arme kennen),
    // angezeigt werden nur die gezogenen Straßen und ihre Knoten
    const first = ring(ids);
    const second = ring(first.roads);
    // Straßen-IDs statt Objekten: die Straßen werden bei jeder Änderung neu abgeleitet
    return { show: ids, build: second.roads, nodes: first.keys };
  };

  const renderRoads = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const t0 = performance.now();
      if (active) {
        // nur die Umgebung der gezogenen Straße neu berechnen und zeigen
        const part = activeRenderer.build(store.project.roads.filter((r) => active!.build.has(r.id)), store.project.junctions, true, opts());
        // Knotenschlüssel hängen an der aktuellen Position — daher je Bild neu bestimmen
        const nodesNow = new Set(store.project.roads.filter((r) => active!.show.has(r.id)).flatMap((r) => r.points.map(nodeKey)));
        const showRoad = (p: any) => (p.roadId && active!.show.has(p.roadId)) || (p.node && nodesNow.has(p.node));
        setData(map, 'surfaces-active', pick(part.surfaces, showRoad));
        setData(map, 'markings-active', pick(part.markings, showRoad));
        setData(map, 'decor-active', pick(part.decor, showRoad));
      } else {
        built = roads.build(store.project.roads, store.project.junctions, true, opts());
        setChunked(map, 'surfaces', built.surfaces);
        setChunked(map, 'markings', built.markings);
        setChunked(map, 'decor', built.decor);
        // Netz geändert: laufende Simulation übernimmt den neuen Stand
        if (simView.sim) simView.rebuild();
        for (const s of ['surfaces-active', 'markings-active', 'decor-active']) setData(map, s, EMPTY);
      }
      if (import.meta.env.DEV) (window as any).__streetlab.lastBuildMs = performance.now() - t0;
      editor.refreshOverlays();
      mapEditor.refresh();
    });
  };

  editor.onDragStart = (ids) => {
    active = neighbourhood(ids);
    // statische Ebene ohne die bearbeitete Umgebung, damit nichts doppelt erscheint
    const hide = (p: any) => !((p.roadId && active!.show.has(p.roadId)) || (p.node && active!.nodes.has(p.node)));
    const shown = (p: any) => !hide(p);
    setChunked(map, 'surfaces', built.surfaces, shown);
    setChunked(map, 'markings', built.markings, shown);
    setChunked(map, 'decor', built.decor, shown);
  };
  editor.onDragEnd = () => {
    active = null;
    renderRoads();
  };

  editor.onDraft = () => {
    const road = editor.draftRoad();
    const fc = road ? draft.build([road], {}, false) : { surfaces: EMPTY, markings: EMPTY };
    setData(map, 'draft-surfaces', fc.surfaces);
    setData(map, 'draft-markings', fc.markings);
  };

  store.on((reason) => {
    if (reason === 'load' && !store.road(editor.selectedId)) editor.select(null);
    renderRoads();
  });
  renderRoads();

  map.on('moveend', () => {
    const c = map.getCenter();
    store.project.view = { center: [c.lng, c.lat], zoom: map.getZoom() };
    store.scheduleSave();
  });

  window.addEventListener('keydown', (e) => {
    // Esc beendet immer — auch wenn gerade ein Eingabefeld den Fokus hat
    if (e.key === 'Escape') {
      (document.activeElement as HTMLElement | null)?.blur();
      mapEditor.close();
      editor.cancel();
      return;
    }
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      e.shiftKey ? store.redo() : store.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) {
      e.preventDefault();
      store.redo();
    } else if (typing) {
      return;
    } else if (e.key === 'Enter' && editor.mode === 'draw') {
      editor.finishDraft();
    } else if (e.key === 'Escape') {
      editor.cancel();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && editor.selectedId) {
      const road = store.road(editor.selectedId);
      if (road) panel.deleteRoad(road);
    } else if (e.key.toLowerCase() === 'd') {
      editor.setMode(editor.mode === 'draw' ? 'select' : 'draw');
    } else if (e.key === ' ') {
      e.preventDefault();
      if (simView.running) simView.pause();
      else simView.start();
    } else if (e.key.toLowerCase() === 'v') {
      editor.setMode('select');
    } else if (e.key === 'Enter' && editor.mode === 'curve') {
      editor.setMode('select');
    } else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) {
      editor.setMode(editor.mode === 'roundabout' ? 'select' : 'roundabout');
    } else if (e.key.toLowerCase() === 'g') {
      toolbar.toggleSnapping();
    } else if (e.key.toLowerCase() === 'k') {
      editor.setMode(editor.mode === 'curve' ? 'select' : 'curve');
    } else if (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey) {
      editor.setMode(editor.mode === 'section' ? 'select' : 'section');
    } else if (e.key.toLowerCase() === 'b') {
      editor.setMode(editor.mode === 'import' ? 'select' : 'import');
    } else if (e.key.toLowerCase() === 's' && editor.selectedId) {
      editor.setMode(editor.mode === 'split' ? 'select' : 'split');
    }
  });
});
