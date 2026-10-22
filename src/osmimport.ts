/**
 * „Bestand übernehmen“: Bereich mit dem Lasso frei umfahren, die Straßen darin aus OpenStreetMap
 * laden und als bearbeitbare Straßen ins Projekt übernehmen (Umrechnung in osm.ts).
 */
import type { Map as MapLibre, MapMouseEvent } from 'maplibre-gl';
import type { Feature, LineString, Polygon } from 'geojson';
import type { Editor } from './editor';
import { EMPTY, setData } from './map';
import type { LngLat } from './model';
import { bboxOf, fetchOsm, osmToRoads } from './osm';
import type { Store } from './store';
import { button, h } from './ui';

/** größere Bereiche dauern lange und werden im Browser zäh */
const MAX_KM2 = 1.5;
/** Overpass liefert grob 1 MB je km² Innenstadt — Schätzung für den Fortschritt */
const BYTES_PER_KM2 = 1.1e6;

type Step = { label: string; value: number };

export class OsmImporter {
  dock: { show: (el: HTMLElement) => void; close: () => void } = { show: () => {}, close: () => {} };
  /** Lasso während des Ziehens (Bildschirmpunkte) */
  private trace: { x: number; y: number }[] | null = null;
  /** fertiges Lasso in Längen-/Breitengrad */
  private ring: LngLat[] | null = null;
  private busy: AbortController | null = null;
  private progress: { bar: HTMLElement; text: HTMLElement } | null = null;

  constructor(
    private map: MapLibre,
    private store: Store,
    private editor: Editor,
  ) {
    map.on('mousedown', (e) => this.down(e));
    // am ganzen Fenster verfolgen: über Werkzeugleiste oder Panel bekommt die Karte keine Ereignisse
    window.addEventListener('mousemove', (e) => this.move(e));
    window.addEventListener('mouseup', () => this.up());
  }

  /** Fensterkoordinaten → Punkt in der Karte */
  private point(e: MouseEvent) {
    const r = this.map.getCanvas().getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Werkzeug verlassen: Lasso weg, laufende Abfrage abbrechen */
  reset() {
    this.busy?.abort();
    this.busy = null;
    this.trace = null;
    this.ring = null;
    this.map.dragPan.enable();
    setData(this.map, 'import-box', EMPTY);
  }

  private down(e: MapMouseEvent) {
    if (this.editor.mode !== 'import' || e.originalEvent.button !== 0 || this.busy) return;
    e.preventDefault();
    this.map.dragPan.disable();
    this.trace = [{ x: e.point.x, y: e.point.y }];
    this.ring = null;
    this.dock.close();
  }

  private move(e: MouseEvent) {
    if (!this.trace) return;
    const q = this.point(e);
    const last = this.trace[this.trace.length - 1];
    if (Math.hypot(q.x - last.x, q.y - last.y) < 4) return;
    this.trace.push(q);
    this.draw(this.trace.map((p) => this.map.unproject([p.x, p.y]).toArray() as LngLat), false);
  }

  private up() {
    if (!this.trace) return;
    const pts = simplify(this.trace, 2);
    this.trace = null;
    this.map.dragPan.enable();
    const ring = pts.map((p) => this.map.unproject([p.x, p.y]).toArray() as LngLat);
    if (ring.length < 3 || areaM2(ring) < 400) return this.reset();
    this.ring = ring;
    this.draw(ring, true);
    this.showDialog();
  }

  /** offener Linienzug beim Ziehen, geschlossene Fläche danach */
  private draw(ring: LngLat[], closed: boolean) {
    const f: Feature<Polygon | LineString> = closed
      ? { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } }
      : { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } };
    setData(this.map, 'import-box', { type: 'FeatureCollection', features: [f] });
  }

  private showDialog(extra: HTMLElement | null = null) {
    const km2 = areaM2(this.ring!) / 1e6;
    const tooBig = km2 > MAX_KM2;
    const size = km2 >= 0.1 ? `${km2.toFixed(2).replace('.', ',')} km²` : `${Math.round(km2 * 1e6).toLocaleString('de-DE')} m²`;
    this.progress = null;
    this.dock.show(
      h(
        'div',
        { class: 'me', 'data-dialog': 'osm-import' },
        h('div', { class: 'me-head' }, h('span', { class: 'kicker' }, 'Bestand übernehmen'), h('span', {}, size)),
        h(
          'div',
          { class: 'me-sub' },
          tooBig
            ? `Der Bereich ist zu groß. Bitte höchstens ${MAX_KM2.toString().replace('.', ',')} km² umfahren.`
            : 'Straßen aus OpenStreetMap mit Fahrstreifen, Abbiegepfeilen, Parken, Radwegen, Gehwegen und Straßenbäumen nachbauen. Ampeln, Kreisverkehre und Vorfahrt werden übernommen.',
        ),
        extra,
        h(
          'div',
          { class: 'row' },
          button('Übernehmen', () => this.run(), { kind: 'primary', disabled: tooBig, action: 'osm-run' }),
          button('Abbrechen', () => this.editor.setMode('select'), { kind: 'ghost' }),
        ),
        h('div', { class: 'me-sub' }, 'Daten © OpenStreetMap-Mitwirkende, ODbL'),
      ),
    );
  }

  /** Dialog mit Fortschrittsbalken; Abbrechen stoppt die Abfrage */
  private showProgress() {
    const bar = h('div', { class: 'progress-fill' });
    const text = h('div', { class: 'me-sub', 'data-status': 'loading' });
    this.progress = { bar, text };
    this.dock.show(
      h(
        'div',
        { class: 'me', 'data-dialog': 'osm-progress' },
        h('div', { class: 'me-head' }, h('span', { class: 'kicker' }, 'Bestand übernehmen'), h('span', {}, 'Bitte warten …')),
        h('div', { class: 'progress', role: 'progressbar' }, bar),
        text,
        h('div', { class: 'row' }, button('Abbrechen', () => this.editor.setMode('select'), { kind: 'ghost', action: 'osm-cancel' })),
      ),
    );
  }

  private step({ label, value }: Step, waiting = false) {
    if (!this.progress) return;
    this.progress.bar.style.width = `${Math.round(value * 100)}%`;
    this.progress.bar.classList.toggle('waiting', waiting);
    this.progress.text.textContent = label;
  }

  private async run() {
    if (!this.ring || this.busy) return;
    const ring = this.ring;
    const controller = (this.busy = new AbortController());
    const expected = Math.max(150e3, (areaM2(ring) / 1e6) * BYTES_PER_KM2);
    this.showProgress();
    this.step({ label: 'Anfrage an OpenStreetMap gesendet …', value: 0.05 }, true);
    try {
      const data = await fetchOsm(bboxOf(ring), controller.signal, (n) => {
        // Gesamtgröße unbekannt: nähert sich 80 %, ohne sie vor dem Ende zu erreichen
        const kb = Math.round(n / 1024).toLocaleString('de-DE');
        this.step({ label: `Daten werden empfangen … ${kb} KB`, value: 0.1 + 0.7 * (1 - Math.exp(-n / expected)) });
      });
      this.step({ label: 'Straßen werden nachgebaut …', value: 0.85 });
      // einen Frame Zeit lassen, damit der Balken vor der Rechenarbeit sichtbar wird
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      if (controller.signal.aborted) return;
      const res = osmToRoads(data, ring);
      this.busy = null;
      if (!res.roads.length) return this.showDialog(h('div', { class: 'me-sub', 'data-status': 'empty' }, 'In diesem Bereich gibt es keine Straßen.'));
      this.step({ label: 'Darstellung wird aufgebaut …', value: 0.95 });
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      this.store.checkpoint();
      const p = this.store.project;
      p.roads.push(...res.roads);
      p.junctions = { ...(p.junctions ?? {}), ...res.junctions };
      this.store.changed('structure');
      this.editor.setMode('select');
      const s = res.stats;
      this.dock.show(
        h(
          'div',
          { class: 'me', 'data-dialog': 'osm-done' },
          h('div', { class: 'me-head' }, h('span', { class: 'kicker' }, 'Bestand übernommen'), h('span', {}, `${s.roads} Straßen`)),
          h('div', { class: 'me-sub' }, `${s.signals} Ampelkreuzungen · ${s.roundabouts} Kreisverkehre. Rückgängig mit Strg+Z.`),
          h('div', { class: 'me-sub' }, 'Daten © OpenStreetMap-Mitwirkende, ODbL'),
        ),
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      this.busy = null;
      console.error(err);
      this.showDialog(h('div', { class: 'me-sub', 'data-status': 'error' }, `Laden fehlgeschlagen: ${(err as Error).message}. Später erneut versuchen.`));
    }
  }
}

/** Fläche eines Vielecks in m² (Gaußsche Trapezformel, lokal eben) */
function areaM2(ring: LngLat[]): number {
  const k = Math.cos((ring[0][1] * Math.PI) / 180) * 111320;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * k * (ring[j][1] + ring[i][1]) * 111320;
  return Math.abs(a / 2);
}

/** Linienzug vereinfachen (Douglas-Peucker, Toleranz in Pixeln) */
function simplify(pts: { x: number; y: number }[], tol: number): { x: number; y: number }[] {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const dp = (i: number, j: number) => {
    const [a, b] = [pts[i], pts[j]];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    let worst = -1, at = -1;
    for (let k = i + 1; k < j; k++) {
      // geschlossenes Lasso (Ende am Anfang): Abstand zum Punkt statt zur Geraden
      const d = l < 1 ? Math.hypot(pts[k].x - a.x, pts[k].y - a.y) : Math.abs((b.x - a.x) * (pts[k].y - a.y) - (b.y - a.y) * (pts[k].x - a.x)) / l;
      if (d > worst) (worst = d), (at = k);
    }
    if (worst > tol) {
      keep[at] = true;
      dp(i, at);
      dp(at, j);
    }
  };
  dp(0, pts.length - 1);
  return pts.filter((_, i) => keep[i]);
}
