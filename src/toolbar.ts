/** Schwebende Werkzeugleiste über der Karte: Werkzeuge, Rückgängig, Suche. */
import type { Map as MapLibre } from 'maplibre-gl';
import type { Editor, Mode } from './editor';
import { PRESETS, presetProfile } from './model';
import { presetPicker, profileSvg } from './presets';
import type { SimView } from './simview';
import type { Store } from './store';
import { h, icon } from './ui';

export class Toolbar {
  private drawPreset = 0;
  /** Verkehrssimulation (gesetzt von main) */
  sim: SimView | null = null;
  /** Andock-Bereich oben links (gesetzt von main) */
  dock: { show: (el: HTMLElement) => void; close: () => void } = { show: () => {}, close: () => {} };

  constructor(
    private root: HTMLElement,
    private map: MapLibre,
    private store: Store,
    private editor: Editor,
  ) {
    try {
      this.editor.snapping = localStorage.getItem('streetlab.snapping') !== '0';
    } catch {
      /* kein localStorage: Fang bleibt an */
    }
    this.render();
  }

  /** Fang an/aus — bleibt für diesen Browser gespeichert */
  toggleSnapping() {
    this.editor.snapping = !this.editor.snapping;
    try {
      localStorage.setItem('streetlab.snapping', this.editor.snapping ? '1' : '0');
    } catch {
      /* kein localStorage */
    }
    this.render();
  }

  /** gewählte Vorlage — fürs Zeichnen und fürs Abschnitt-Ziehen */
  currentPreset() {
    return { strips: presetProfile(this.drawPreset), name: PRESETS[this.drawPreset].name };
  }

  /** Knopf mit Vorschau der gewählten Vorlage — öffnet die Galerie */
  private presetButton() {
    const thumb = h('span', { class: 'mini-thumb' });
    thumb.innerHTML = profileSvg(presetProfile(this.drawPreset), 2);
    return h(
      'button',
      { class: 'preset-button', 'data-action': 'draw-preset', title: 'Querschnitt wählen', onclick: () => this.openPicker() },
      thumb,
      h('span', {}, PRESETS[this.drawPreset].name),
      icon('chevron', 14),
    );
  }

  /** Galerie öffnen; die Wahl gilt für die nächste gezeichnete Straße */
  openPicker() {
    this.dock.show(
      presetPicker(
        this.editor.mode === 'section' ? 'Querschnitt für den Abschnitt' : 'Querschnitt für neue Straße',
        this.drawPreset,
        (i) => {
          this.drawPreset = i;
          this.editor.drawProfile = presetProfile(i);
          this.editor.onDraft();
          this.dock.close();
          this.render();
        },
        () => this.dock.close(),
      ),
    );
  }

  render() {
    const mode = this.editor.mode;
    const canSplit = !!this.editor.selectedId;
    const tool = (m: Mode, ic: string, title: string, disabled = false) =>
      h(
        'button',
        {
          class: 'tool' + (mode === m ? ' on' : ''),
          title,
          disabled,
          'data-tool': m,
          onclick: () => this.editor.setMode(mode === m && m !== 'select' ? 'select' : m),
        },
        icon(ic, 18),
      );

    let searchInput: HTMLInputElement;
    const search = async (e: Event) => {
      e.preventDefault();
      const q = searchInput.value.trim();
      if (!q) return;
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
      const [hit] = await res.json();
      if (hit) this.map.flyTo({ center: [+hit.lon, +hit.lat], zoom: 18 });
      else searchInput.select();
    };

    const drawing = mode === 'draw';
    const curving = mode === 'curve';
    const circling = mode === 'roundabout';
    const painting = mode === 'section';
    const rows: (HTMLElement | null)[] = [
      h(
        'div',
        { class: 'bar' },
        h('div', { class: 'brand' }, 'Streetlab'),
        h('div', { class: 'tools' }, tool('select', 'select', 'Auswählen (V)'), tool('draw', 'draw', 'Straße zeichnen (D)'), tool('curve', 'curve', 'Kurve (K) – Bogen mit festem Radius, am Straßenende tangential'), tool('split', 'split', 'Straße teilen (S) – erst eine Straße auswählen', !canSplit), tool('roundabout', 'roundabout', 'Kreisverkehr (R) – auf eine Kreuzung drücken und Radius aufziehen'), tool('section', 'section', 'Abschnitt ziehen (A) – entlang einer Straße ziehen, dort gilt der gewählte Querschnitt'), tool('import', 'import', 'Bestand übernehmen (B) – Bereich umfahren, Straßen aus OpenStreetMap nachbauen')),
        h(
          'div',
          { class: 'tools' },
          h('button', { class: 'tool', title: 'Rückgängig (Strg+Z)', onclick: () => this.store.undo() }, icon('undo', 18)),
          h('button', { class: 'tool', title: 'Wiederholen (Strg+Y)', onclick: () => this.store.redo() }, icon('redo', 18)),
          h(
            'button',
            {
              class: 'tool' + (this.editor.snapping ? ' on' : ''),
              title: this.editor.snapping ? 'Fang ist an (G) – Alt zeichnet frei' : 'Fang ist aus (G) – Alt fängt',
              'data-action': 'snapping',
              onclick: () => this.toggleSnapping(),
            },
            icon('magnet', 18),
          ),
        ),
        this.sim
          ? h(
              'div',
              { class: 'tools' },
              h(
                'button',
                {
                  class: 'tool' + (this.sim.running ? ' on' : ''),
                  title: this.sim.running ? 'Simulation anhalten (Leertaste)' : 'Simulation starten (Leertaste)',
                  'data-action': 'sim-play',
                  onclick: () => (this.sim!.running ? this.sim!.pause() : this.sim!.start()),
                },
                icon(this.sim.running ? 'pause' : 'play', 18),
              ),
            )
          : null,
        h(
          'form',
          { class: 'search', onsubmit: search },
          icon('search', 15),
          (searchInput = h('input', { placeholder: 'Ort suchen', type: 'search' })),
        ),
      ),
      drawing
        ? h(
            'div',
            { class: 'bar sub' },
            this.presetButton(),
            h('span', { class: 'muted' }, 'Klicken setzt Punkte · Doppelklick oder Enter beendet · G: Fang an/aus · Alt: umkehren'),
          )
        : circling
          ? h('div', { class: 'bar sub' }, h('span', { class: 'muted' }, 'Auf eine Kreuzung drücken und nach außen ziehen: Radius des Kreisverkehrs · Klick: 15 m · unter 10 m Mini-Kreisel · Esc beendet'))
          : curving
          ? h('div', { class: 'bar sub' }, this.presetButton(), h('span', { class: 'muted' }, 'Am Straßenende beginnen: Bogen läuft tangential heraus · sonst legt der 2. Klick die Richtung fest · Esc beendet'))
          : painting
          ? h('div', { class: 'bar sub' }, this.presetButton(), h('span', { class: 'muted' }, 'Auf einer Straße entlangziehen: dort gilt dieser Querschnitt · Esc beendet'))
          : mode === 'split'
          ? h('div', { class: 'bar sub' }, h('span', { class: 'muted' }, 'Auf die Straße klicken, wo ein neuer Abschnitt beginnen soll · Esc bricht ab'))
          : mode === 'import'
            ? h('div', { class: 'bar sub' }, h('span', { class: 'muted' }, 'Mit gedrückter Maustaste den Bereich umfahren, dessen Straßen übernommen werden sollen · Esc bricht ab'))
            : null,
    ];
    this.root.replaceChildren(...rows.filter((x): x is HTMLElement => !!x));
  }
}
