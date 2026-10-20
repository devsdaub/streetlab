/**
 * Schnellbearbeitung: Klick auf einen Streifen, eine Verziehung oder eine Kreuzung öffnet ein
 * schlankes Bedienfeld fest oben links unter der Werkzeugleiste (verdeckt nichts an der Klickstelle).
 * Details stehen zusätzlich im Inspektor.
 */
import type { LngLatLike } from 'maplibre-gl';
import type { Editor } from './editor';
import { CONTROL_LABELS, KIND_LABELS, controlOf, defaultJunction, type Control, type JunctionKind, type JunctionSettings, type Road, type Strip } from './model';
import type { Built } from './render';
import type { Store } from './store';
import { stripDetails, stripLabel } from './stripeditor';
import { button, field, h, icon, segmented, select, slider } from './ui';

type Target =
  | { kind: 'strip'; roadId: string; stripId: string; at: LngLatLike }
  | { kind: 'transition'; key: string; at: LngLatLike }
  | { kind: 'node'; key: string; at: LngLatLike };

/** Streifen per ID in einer Straße finden (alle Abschnitte) */
function findStrip(road: Road, id: string): { profile: Strip[]; index: number } | null {
  for (const profile of [road.profile, ...(road.sections ?? []).map((s) => s.profile)]) {
    const index = profile.findIndex((s) => s.id === id);
    if (index >= 0) return { profile, index };
  }
  return null;
}

export class MapEditor {
  private target: Target | null = null;

  constructor(
    private dock: HTMLElement,
    private store: Store,
    private editor: Editor,
    private getBuilt: () => Built,
  ) {}

  open(target: Target) {
    this.target = target;
    this.render();
  }

  /** beliebigen Inhalt oben links andocken (z. B. die Vorlagen-Galerie) */
  show(el: HTMLElement) {
    this.target = null;
    this.dock.replaceChildren(h('div', { class: 'dock-card' }, el));
  }

  /** nach dem Neuberechnen: offenes Feld mit aktuellen Daten neu aufbauen */
  refresh() {
    if (this.target) this.render();
  }

  close() {
    if (this.editor.transitionEdit) {
      this.editor.transitionEdit = null;
      this.editor.selectedLane = null;
      this.editor.refreshOverlays();
    }
    this.target = null;
    this.dock.replaceChildren();
  }

  private change = (fn: () => void) => {
    this.store.checkpoint();
    fn();
    this.store.changed('structure');
  };

  private render() {
    const t = this.target;
    if (!t) return;
    // Fokus in einem Eingabefeld des Felds nicht durch Neuaufbau verlieren
    if (this.dock.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
    const content = t.kind === 'strip' ? this.stripView(t) : t.kind === 'transition' ? this.transitionView(t.key) : this.nodeView(t.key);
    if (!content) return this.close();
    content.prepend(h('button', { class: 'dock-close', title: 'Schließen (Esc)', onclick: () => this.close() }, icon('close', 14)));
    this.dock.replaceChildren(h('div', { class: 'dock-card' }, content));
  }

  private stripView(t: Extract<Target, { kind: 'strip' }>) {
    const road = this.store.road(t.roadId);
    const found = road && findStrip(road, t.stripId);
    if (!road || !found) return null;
    return h(
      'div',
      { class: 'me' },
      h('div', { class: 'me-head' }, h('span', { class: 'kicker' }, road.name), h('span', {}, stripLabel(found.profile[found.index]))),
      stripDetails({
        profile: found.profile,
        index: found.index,
        change: this.change,
        compact: true,
        selectStrip: (id) => {
          if (!id) return this.close();
          this.target = { ...t, stripId: id };
          this.editor.selectStrip(id);
        },
      }),
    );
  }

  private transitionView(key: string) {
    const t = this.getBuilt().transitions?.get(key);
    if (!t) return null;
    const links = (this.store.project.stripLinks ??= {});
    const k = (id: string) => `${key}|${id}`;
    const unlink = (id: string) => {
      const other = links[k(id)];
      delete links[k(id)];
      if (other) delete links[k(other)];
    };
    const setLink = (bId: string, value: string) =>
      this.change(() => {
        unlink(bId);
        if (value === 'auto') return;
        if (value === 'new') links[k(bId)] = '';
        else {
          unlink(value);
          links[k(bId)] = value;
          links[k(value)] = bId;
        }
      });
    const setLength = (v: number | undefined) =>
      this.change(() => {
        if (key.startsWith('sec:')) {
          const [, roadId, idx] = key.split(':');
          const sec = this.store.road(roadId)?.sections?.find((x) => x.index === +idx);
          if (sec) sec.transition = v;
        } else {
          const j = (this.store.project.junctions ??= {});
          j[key] = { ...defaultJunction(), ...j[key], transition: v };
        }
      });
    const partnerOf = (bId: string) => t.pairs.find((p) => p.b === bId)?.a;
    const ending = t.A.filter((a) => !t.pairs.some((p) => p.a === a.id && p.b));
    return h(
      'div',
      { class: 'me' },
      h('div', { class: 'me-head' }, h('span', { class: 'kicker' }, 'Verziehung'), h('span', {}, `${t.A.length} → ${t.B.length} Streifen`)),
      field('Länge', slider(Math.round(t.length), 4, 60, 1, (v) => setLength(v))),
      t.auto ? null : button('Länge automatisch', () => setLength(undefined), { kind: 'ghost' }),
      button(
        this.editor.transitionEdit === key ? 'Verbinden beenden' : 'In der Karte verbinden',
        () => {
          this.editor.transitionEdit = this.editor.transitionEdit === key ? null : key;
          this.editor.selectedLane = null;
          this.editor.refreshOverlays();
          this.render();
        },
        { icon: 'lanes', kind: this.editor.transitionEdit === key ? 'primary' : undefined, action: 'transition-edit' },
      ),
      this.editor.transitionEdit === key
        ? h('div', { class: 'me-sub' }, 'Grünen Punkt (davor) wählen, dann roten Punkt (danach) anklicken. Roter Punkt allein: Streifen entsteht neu.')
        : null,
      h('div', { class: 'me-sub' }, 'Jeder Streifen danach geht hervor aus:'),
      h(
        'div',
        { class: 'me-map' },
        ...t.B.map((b) => {
          const explicit = links[k(b.id)];
          const current = explicit === undefined ? 'auto' : explicit === '' ? 'new' : explicit;
          const auto = partnerOf(b.id);
          const autoA = auto ? t.A.find((a) => a.id === auto) : undefined;
          return h(
            'div',
            { class: 'me-map-row' },
            h('span', { class: 'me-b', title: stripLabel(b) }, stripLabel(b)),
            select(
              [
                { value: 'auto', label: autoA ? `Automatisch: ${stripLabel(autoA)}` : 'Automatisch: neu' },
                { value: 'new', label: 'Neu, wächst heraus' },
                ...t.A.map((a, i) => ({ value: a.id, label: `${i + 1}. ${stripLabel(a)}` })),
              ],
              current,
              (v) => setLink(b.id, v),
            ),
          );
        }),
      ),
      ending.length ? h('div', { class: 'me-sub' }, `Läuft aus: ${ending.map(stripLabel).join(', ')}`) : null,
    );
  }

  private nodeView(key: string) {
    const j = (this.store.project.junctions ??= {});
    const st: JunctionSettings = { ...defaultJunction(), ...j[key] };
    const set = (patch: Partial<JunctionSettings>) => this.change(() => (j[key] = { ...st, ...patch }));
    return h(
      'div',
      { class: 'me' },
      h('div', { class: 'me-head' }, h('span', { class: 'kicker' }, 'Knotenpunkt'), h('span', {}, 'Details im Inspektor')),
      segmented(
        (Object.keys(KIND_LABELS) as JunctionKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] })),
        st.kind,
        (k) => set({ kind: k, ...(k === 'mini' ? { rbRadius: 9, rbLane: 6 } : {}) }),
      ),
      st.kind === 'cross'
        ? select(
            Object.entries(CONTROL_LABELS).map(([value, label]) => ({ value: value as Control, label })),
            controlOf(st),
            (v) => set({ control: v, stopLines: v !== 'none' }),
          )
        : null,
      st.kind === 'cross'
        ? button(
            this.editor.laneEdit ? 'Spurverbindungen fertig' : 'Spurverbindungen bearbeiten',
            () => {
              this.editor.laneEdit = !this.editor.laneEdit;
              this.editor.selectedLane = null;
              this.editor.refreshOverlays();
              this.editor.onChange();
              this.render();
            },
            { icon: 'lanes', kind: this.editor.laneEdit ? 'primary' : undefined },
          )
        : null,
    );
  }
}
