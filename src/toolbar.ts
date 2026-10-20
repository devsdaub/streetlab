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
    this.render();
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
        'Querschnitt für neue Straße',
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
    const rows: (HTMLElement | null)[] = [
      h(
        'div',
        { class: 'bar' },
        h('div', { class: 'brand' }, 'Streetlab'),
        h('div', { class: 'tools' }, tool('select', 'select', 'Auswählen (V)'), tool('draw', 'draw', 'Straße zeichnen (D)'), tool('split', 'split', 'Straße teilen (S) – erst eine Straße auswählen', !canSplit)),
        h(
          'div',
          { class: 'tools' },
          h('button', { class: 'tool', title: 'Rückgängig (Strg+Z)', onclick: () => this.store.undo() }, icon('undo', 18)),
          h('button', { class: 'tool', title: 'Wiederholen (Strg+Y)', onclick: () => this.store.redo() }, icon('redo', 18)),
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
            h('span', { class: 'muted' }, 'Klicken setzt Punkte · Doppelklick oder Enter beendet · Alt: nicht fangen'),
          )
        : mode === 'split'
          ? h('div', { class: 'bar sub' }, h('span', { class: 'muted' }, 'Auf die Straße klicken, wo ein neuer Abschnitt beginnen soll · Esc bricht ab'))
          : null,
    ];
    this.root.replaceChildren(...rows.filter((x): x is HTMLElement => !!x));
  }
}
