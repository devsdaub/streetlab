import maplibregl, { type GeoJSONSource, type LayerSpecification, type LineLayerSpecification, type StyleSpecification } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { Project } from './model';

export const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

const wms = (url: string, layer: string) =>
  `${url}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layer}&STYLES=&CRS=EPSG:3857` +
  '&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/jpeg';

/** Hintergründe — die Landes-Orthofotos (DOP) sind deutlich schärfer als das weltweite Luftbild. */
export const BASEMAPS = {
  sat: {
    label: 'Luftbild weltweit',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 19,
    attribution: 'Luftbild © Esri, Maxar, Earthstar Geographics',
  },
  'dop-bw': {
    label: 'Orthofoto BW · 20 cm',
    tiles: [wms('https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C', 'IMAGES_DOP_20_RGB')],
    maxzoom: 20,
    attribution: '© LGL Baden-Württemberg, dl-de/by-2-0',
  },
  'dop-nw': {
    label: 'Orthofoto NRW · 10 cm',
    tiles: [wms('https://www.wms.nrw.de/geobasis/wms_nw_dop', 'nw_dop_rgb')],
    maxzoom: 21,
    attribution: '© Geobasis NRW, dl-de/zero-2-0',
  },
  'dop-by': {
    label: 'Orthofoto Bayern · 40 cm',
    tiles: [wms('https://geoservices.bayern.de/od/wms/dop/v1/dop40', 'by_dop40c')],
    maxzoom: 19,
    attribution: '© Bayerische Vermessungsverwaltung, CC BY 4.0',
  },
  osm: {
    label: 'Stadtplan (OSM)',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxzoom: 19,
    attribution: '© OpenStreetMap-Mitwirkende',
  },
} as const;

export type Basemap = keyof typeof BASEMAPS | 'none';
const BASEMAP_IDS = Object.keys(BASEMAPS) as (keyof typeof BASEMAPS)[];

/**
 * Der Entwurf liegt auf mehrere Pakete verteilt (je Straße bzw. Knoten fest zugeordnet).
 * Nach einer Änderung werden nur Pakete neu übergeben, deren Inhalt sich geändert hat —
 * so bleibt auch ein ganzer Stadtteil flüssig bearbeitbar.
 */
export const CHUNKS = 12;
const CHUNK_IDS = [...Array.from({ length: CHUNKS }, (_, i) => String(i)), 'active'];
/** alle Flächen-Ebenen (für Klicks und Hervorhebung) */
export const SURFACE_LAYERS = CHUNK_IDS.map((c) => `surfaces-${c}`);
const DESIGN_LAYERS = CHUNK_IDS.flatMap((c) => [`surfaces-${c}`, `markings-${c}`, `decor-${c}`]);
const SHADOW_LAYERS = CHUNK_IDS.map((c) => `shadow-${c}`);
const SHADOW_OPACITY = 1;

const shadowPaint: LineLayerSpecification['paint'] = {
  'line-color': 'rgba(0,0,0,0.55)',
  'line-width': ['interpolate', ['exponential', 2], ['zoom'], 14, 1, 18, 8, 22, 60],
  'line-blur': ['interpolate', ['exponential', 2], ['zoom'], 14, 1, 18, 8, 22, 60],
  'line-translate': [2, 3],
};

/** Ebenen eines Pakets: Schatten, Flächen, Markierungen, Dekor */
function designLayers(): LayerSpecification[] {
  const fill = (id: string, sorted: boolean): LayerSpecification => ({
    id,
    type: 'fill',
    source: id,
    ...(sorted ? { layout: { 'fill-sort-key': ['get', 'rank'] } } : {}),
    paint: { 'fill-color': ['get', 'color'] },
  });
  return [
    // weicher Schlagschatten unter dem Entwurf (nur die Außenkanten bleiben sichtbar)
    ...CHUNK_IDS.map((c) => ({ id: `shadow-${c}`, type: 'line', source: `surfaces-${c}`, paint: shadowPaint }) as LayerSpecification),
    ...CHUNK_IDS.map((c) => fill(`surfaces-${c}`, true)),
    ...CHUNK_IDS.map((c) => fill(`markings-${c}`, false)),
    ...CHUNK_IDS.map((c) => fill(`decor-${c}`, true)),
    // gewählter Streifen: Umriss in Akzentfarbe
    ...CHUNK_IDS.map(
      (c) =>
        ({
          id: `strip-select-${c}`,
          type: 'line',
          source: `surfaces-${c}`,
          filter: ['==', ['get', 'stripId'], '__none__'],
          paint: { 'line-color': '#5b8def', 'line-width': 2.5 },
        }) as LayerSpecification,
    ),
  ];
}

const hashStr = (k: string) => {
  let h = 2166136261;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
  return h >>> 0;
};
/** feste Paket-Zuordnung je Straße bzw. Knoten */
export const chunkOf = (p: any) => hashStr(String(p?.roadId || p?.node || '')) % CHUNKS;

const lastLists = new Map<string, unknown[]>();
/**
 * Entwurf auf die Pakete verteilen; nur geänderte Pakete werden an die Karte übergeben.
 * Unveränderte Teile kommen aus dem Renderer-Zwischenspeicher als dieselben Objekte zurück.
 */
export function setChunked(map: maplibregl.Map, kind: 'surfaces' | 'markings' | 'decor', fc: FeatureCollection, exclude?: (p: any) => boolean) {
  const parts: FeatureCollection['features'][] = Array.from({ length: CHUNKS }, () => []);
  for (const f of fc.features) {
    if (exclude?.(f.properties)) continue;
    parts[chunkOf(f.properties)].push(f);
  }
  parts.forEach((list, i) => {
    const id = `${kind}-${i}`;
    const prev = lastLists.get(id);
    if (prev && prev.length === list.length && prev.every((x, j) => x === list[j])) return;
    lastLists.set(id, list);
    setData(map, id, { type: 'FeatureCollection', features: list });
  });
}

/** Hervorhebung des gewählten Streifens in allen Paketen */
export function setStripHighlight(map: maplibregl.Map, stripId: string | null) {
  for (const c of CHUNK_IDS) map.setFilter(`strip-select-${c}`, ['==', ['get', 'stripId'], stripId ?? '__none__']);
}

export function createMap(container: HTMLElement, view: Project['view'], basemap: Basemap) {
  const geo = () => ({ type: 'geojson' as const, data: EMPTY });
  const rasterSources = Object.fromEntries(
    BASEMAP_IDS.map((id) => {
      const b = BASEMAPS[id];
      return [id, { type: 'raster' as const, tiles: [...b.tiles], tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution }];
    }),
  );
  const rasterLayers: LayerSpecification[] = BASEMAP_IDS.map((id) => ({
    id,
    type: 'raster',
    source: id,
    layout: { visibility: id === basemap ? 'visible' : 'none' },
  }));

  const style: StyleSpecification = {
    version: 8,
    sources: {
      ...rasterSources,
...Object.fromEntries(CHUNK_IDS.flatMap((c) => [`surfaces-${c}`, `markings-${c}`, `decor-${c}`].map((id) => [id, geo()]))),
            'draft-surfaces': geo(),
      'draft-markings': geo(),
      'edit-line': geo(),
      'edit-vertices': geo(),
      'edit-midpoints': geo(),
      draft: geo(),
      'lane-links': geo(),
      'lane-ends': geo(),
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#26282b' } },
      ...rasterLayers,
      ...designLayers(),
      {
        id: 'draft-surfaces',
        type: 'fill',
        source: 'draft-surfaces',
        layout: { 'fill-sort-key': ['get', 'rank'] },
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.75 },
      },
      { id: 'draft-markings', type: 'fill', source: 'draft-markings', paint: { 'fill-color': ['get', 'color'] } },
      {
        id: 'edit-line',
        type: 'line',
        source: 'edit-line',
        paint: { 'line-color': '#38bdf8', 'line-width': 2, 'line-dasharray': [2, 1.5] },
      },
      {
        id: 'draft-line',
        type: 'line',
        source: 'draft',
        filter: ['==', '$type', 'LineString'],
        paint: { 'line-color': '#facc15', 'line-width': 2, 'line-dasharray': [2, 1.5] },
      },
      {
        id: 'draft-points',
        type: 'circle',
        source: 'draft',
        filter: ['==', '$type', 'Point'],
        paint: {
          'circle-radius': ['case', ['==', ['get', 'snap'], true], 9, 4],
          'circle-color': ['case', ['==', ['get', 'snap'], true], 'rgba(56,189,248,0.25)', '#facc15'],
          'circle-stroke-color': ['case', ['==', ['get', 'snap'], true], '#38bdf8', '#000'],
          'circle-stroke-width': ['case', ['==', ['get', 'snap'], true], 2.5, 1],
        },
      },
      {
        id: 'edit-midpoints',
        type: 'circle',
        source: 'edit-midpoints',
        paint: {
          'circle-radius': 4,
          'circle-color': '#ffffff',
          'circle-opacity': 0.7,
          'circle-stroke-color': '#38bdf8',
          'circle-stroke-width': 1.5,
        },
      },
      {
        id: 'lane-links',
        type: 'line',
        source: 'lane-links',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': ['match', ['get', 'move'], 'left', '#f59e0b', 'right', '#c084fc', 'bike', '#22c55e', '#38bdf8'],
          'line-width': ['case', ['==', ['get', 'active'], true], 5, 2.5],
          'line-opacity': ['case', ['==', ['get', 'dim'], true], 0.25, 0.95],
        },
      },
      {
        id: 'lane-ends',
        type: 'circle',
        source: 'lane-ends',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'selected'], true], 9, ['==', ['get', 'bike'], true], 5, 7],
          'circle-color': ['case', ['==', ['get', 'kind'], 'in'], '#22c55e', '#ef4444'],
          'circle-stroke-color': ['case', ['==', ['get', 'selected'], true], '#ffffff', '#111111'],
          'circle-stroke-width': ['case', ['==', ['get', 'selected'], true], 3, 1.5],
        },
      },
      {
        id: 'edit-vertices',
        type: 'circle',
        source: 'edit-vertices',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'section'], true], 8, 6],
          'circle-color': ['case', ['==', ['get', 'section'], true], '#f59e0b', '#38bdf8'],
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      },
    ],
  };

  const map = new maplibregl.Map({
    container,
    style,
    center: view?.center ?? [9.177, 48.7758],
    zoom: view?.zoom ?? 16,
    maxZoom: 22,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 160 }), 'bottom-right');
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  return map;
}

export function setData(map: maplibregl.Map, source: string, data: FeatureCollection) {
  (map.getSource(source) as GeoJSONSource | undefined)?.setData(data);
}

export function setBasemap(map: maplibregl.Map, which: Basemap) {
  for (const id of BASEMAP_IDS) map.setLayoutProperty(id, 'visibility', id === which ? 'visible' : 'none');
}

export function setDesignOpacity(map: maplibregl.Map, opacity: number) {
  for (const id of DESIGN_LAYERS) map.setPaintProperty(id, 'fill-opacity', opacity);
  for (const id of SHADOW_LAYERS) map.setPaintProperty(id, 'line-opacity', opacity * SHADOW_OPACITY);
}

/** Größte Bildfläche (Pixel) — darüber wird es für den Browser-Speicher eng. */
export const MAX_EXPORT_PIXELS = 100e6;
const TILE = 1024;

/** Bildgröße, die ein Export mit diesem Faktor ergibt (ggf. auf MAX_EXPORT_PIXELS begrenzt). */
export function exportSize(map: maplibregl.Map, scale: number) {
  const c = map.getContainer();
  const shrink = Math.min(1, Math.sqrt(MAX_EXPORT_PIXELS / (c.clientWidth * c.clientHeight * scale * scale)));
  const effective = scale * shrink;
  return { width: Math.floor(c.clientWidth * effective), height: Math.floor(c.clientHeight * effective), effective };
}

/**
 * Exportiert den aktuellen Ausschnitt mit `scale`-facher Auflösung. Eine unsichtbare Karte rendert
 * Kachel für Kachel (1024 px) mit entsprechend höherem Zoom — so lädt auch das Luftbild feinere
 * Kacheln, statt hochskaliert zu werden — und die Kacheln werden zu einem Bild zusammengesetzt.
 */
export async function exportPng(map: maplibregl.Map, filename: string, scale: number, onProgress?: (p: number) => void) {
  const { width: w, height: h, effective } = exportSize(map, scale);

  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-${TILE + 50}px;top:0;width:${TILE}px;height:${TILE}px;`;
  document.body.append(host);
  const style = map.getStyle();
  style.layers = style.layers.filter((l) => !l.id.startsWith('edit-') && !l.id.startsWith('draft'));

  const off = new maplibregl.Map({
    container: host,
    style,
    center: map.getCenter(),
    zoom: map.getZoom() + Math.log2(effective),
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    pixelRatio: 1,
    preserveDrawingBuffer: true,
    maxZoom: 24,
  });
  const idle = () =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Zeitüberschreitung beim Laden der Kacheln')), 120_000);
      off.once('idle', () => {
        clearTimeout(timer);
        resolve();
      });
      off.triggerRepaint();
    });

  try {
    await idle();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    // Großes Bild-Pixel (bx, by) liegt in der Hilfskarte bei (bx − w/2 + TILE/2, by − h/2 + TILE/2)
    const tiles: { x: number; y: number; center: maplibregl.LngLat }[] = [];
    for (let y = 0; y < h; y += TILE)
      for (let x = 0; x < w; x += TILE)
        tiles.push({ x, y, center: off.unproject([x - w / 2 + TILE, y - h / 2 + TILE]) });
    for (const [i, t] of tiles.entries()) {
      off.jumpTo({ center: t.center });
      await idle();
      ctx.drawImage(off.getCanvas(), t.x, t.y);
      onProgress?.((i + 1) / tiles.length);
    }
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('Bild konnte nicht erzeugt werden');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return { width: w, height: h };
  } finally {
    off.remove();
    host.remove();
  }
}
