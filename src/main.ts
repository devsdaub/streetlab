import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { Editor } from './editor';
import { EMPTY, createMap, setData, type Basemap } from './map';
import { MapEditor } from './mapedit';
import { Panel } from './panel';
import { Toolbar } from './toolbar';
import { RoadRenderer, type Built } from './render';
import { Store } from './store';

const store = new Store();
const map = createMap(document.getElementById('map')!, store.project.view, (store.project.basemap as Basemap) ?? 'sat');
const roads = new RoadRenderer();
const draft = new RoadRenderer();
let built: Built = { surfaces: EMPTY, markings: EMPTY, decor: EMPTY };

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
  editor.onModeChange = (mode) => mode !== 'select' && mapEditor.close();
  if (import.meta.env.DEV) (window as any).__streetlab.editor = editor;
  const panel = new Panel(document.getElementById('panel')!, map, store, editor, () => built);
  const toolbar = new Toolbar(document.getElementById('toolbar')!, map, store, editor);
  panel.onRender = () => toolbar.render();
  panel.dock = toolbar.dock = mapEditor;

  // höchstens einmal pro Frame neu berechnen — beim Ziehen kommen viele Events
  let pending = false;
  const renderRoads = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      built = roads.build(store.project.roads, store.project.junctions, true, {
        style: store.project.markingStyle ?? 'de',
        traffic: !!store.project.traffic,
        links: store.project.stripLinks,
      });
      setData(map, 'surfaces', built.surfaces);
      setData(map, 'markings', built.markings);
      setData(map, 'decor', built.decor);
      editor.refreshOverlays();
      mapEditor.refresh();
    });
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
    } else if (e.key.toLowerCase() === 'v') {
      editor.setMode('select');
    } else if (e.key.toLowerCase() === 's' && editor.selectedId) {
      editor.setMode(editor.mode === 'split' ? 'select' : 'split');
    }
  });
});
