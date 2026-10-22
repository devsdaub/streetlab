/** Inspektor (rechte Seitenleiste): zeigt je nach Auswahl Projekt, Straße oder Kreuzung. */
import type { Map as MapLibre } from 'maplibre-gl';
import { LngLatBounds } from 'maplibre-gl';
import { stripColor } from './decor';
import type { Editor } from './editor';
import { exportSvg } from './export';
import { addTurnLane, approachesAt } from './lanes';
import { BASEMAPS, exportPng, exportSize, setBasemap, setDesignOpacity, type Basemap } from './map';
import {
  CONTROL_LABELS,
  CROSSING_LABELS,
  KIND_LABELS,
  ROLE_LABELS,
  STRIP_TYPES,
  controlOf,
  defaultJunction,
  makeStrip,
  presetProfile,
  reverseProfile,
  sectionProfile,
  setSectionProfile,
  type ArmRole,
  type Control,
  type Crossing,
  type JunctionKind,
  type JunctionSettings,
  type MarkingStyle,
  type Project,
  type Road,
  type StripType,
} from './model';
import { buildNetwork } from './network';
import { presetPicker } from './presets';
import type { SimStats } from './sim';
import type { SimView } from './simview';
import { downloadSumo, sumoFiles } from './sumo';
import type { Built } from './render';
import type { Store } from './store';
import { TYPE_OPTIONS, profileBar, stripDetails } from './stripeditor';
import { button, chip, field, fmtM, foldGroup, group, h, icon, segmented, select, slider, toggle, val } from './ui';

const totalWidth = (r: Road) => r.profile.reduce((s, x) => s + x.width, 0);

export class Panel {
  private basemap: Basemap;
  private exportScale = 2;
  private updateExportInfo = () => {};
  private opacity = 1;
  /** Hintergründe, deren Server keine Kacheln liefert (gesetzt von main) */
  basemapFailed = new Set<string>();
  /** Feld, das zuletzt einen Undo-Punkt gesetzt hat — Tippen in dasselbe Feld = ein Schritt */
  private lastEditKey = '';
  /** Verkehrssimulation (gesetzt von main) */
  sim: SimView | null = null;
  /** Andock-Bereich oben links (gesetzt von main) */
  dock: { show: (el: HTMLElement) => void; close: () => void } = { show: () => {}, close: () => {} };
  /** wird nach jedem Neuaufbau aufgerufen (z. B. für die Werkzeugleiste) */
  onRender = () => {};

  constructor(
    private root: HTMLElement,
    private map: MapLibre,
    private store: Store,
    private editor: Editor,
    private getBuilt: () => Built,
  ) {
    this.basemap = (store.project.basemap as Basemap) ?? 'sat';
    map.on('moveend', () => this.updateExportInfo());
    store.on((reason, source) => {
      if (source === this) return;
      this.lastEditKey = '';
      if (reason !== 'geometry') this.render();
    });
    editor.onChange = () => {
      this.lastEditKey = '';
      this.render();
    };
    this.render();
  }

  private edit(key: string, fn: () => void, reason: 'props' | 'structure' = 'props') {
    if (key !== this.lastEditKey || reason === 'structure') this.store.checkpoint();
    this.lastEditKey = key;
    fn();
    if (reason === 'structure') {
      this.lastEditKey = '';
      this.store.changed(reason);
    } else this.store.changed(reason, this);
  }
  private change = (fn: () => void) => this.edit('change', fn, 'structure');

  render() {
    const road = this.store.road(this.editor.selectedId);
    const node = this.editor.selectedNode;
    const scroll = this.root.scrollTop;
    const parts: (Node | null)[] = road ? this.roadView(road) : node ? this.nodeView(node) : this.projectView();
    this.root.replaceChildren(...parts.filter((x): x is Node => !!x));
    this.root.scrollTop = scroll;
    this.onRender();
  }

  private back() {
    return h('button', { class: 'back', title: 'Zur Projektübersicht', onclick: () => this.editor.select(null) }, icon('left', 14), 'Projekt');
  }

  // ---- Projekt (nichts ausgewählt) -------------------------------------------

  private projectView(): (Node | null)[] {
    const p = this.store.project;
    const style = p.markingStyle ?? 'de';
    return [
      h(
        'header',
        { class: 'inspector-head' },
        h('div', { class: 'kicker' }, 'Projekt'),
        h('input', { class: 'title-input', value: p.name, oninput: (e) => this.edit('project-name', () => (p.name = val(e))) }),
      ),
      group(
        `Straßen · ${p.roads.length}`,
        p.roads.length
          ? h(
              'ul',
              { class: 'list' },
              ...p.roads.map((r) =>
                h(
                  'li',
                  {
                    onclick: () => {
                      this.editor.select(r.id);
                      this.zoomTo(r);
                    },
                  },
                  h('span', {}, r.name),
                  h('span', { class: 'muted' }, fmtM(totalWidth(r))),
                ),
              ),
            )
          : h('p', { class: 'muted small' }, 'Noch keine Straßen. Mit dem Stift oben links zeichnen.'),
      ),
      group(
        'Darstellung',
        field(
          'Hintergrund',
          select(
            [...Object.entries(BASEMAPS).map(([value, b]) => ({ value, label: b.label })), { value: 'none', label: 'Kein Hintergrund' }],
            this.basemap as string,
            (v) => {
              this.basemap = v as Basemap;
              setBasemap(this.map, this.basemap);
              p.basemap = this.basemap;
              this.store.scheduleSave();
            },
            'basemap',
          ),
        ),
        this.basemapFailed.has(this.basemap)
          ? h(
              'p',
              { class: 'muted small', 'data-notice': 'basemap' },
              `${BASEMAPS[this.basemap as keyof typeof BASEMAPS].label}: Der Server liefert gerade keine Bilder. Darunter wird das weltweite Luftbild gezeigt.`,
            )
          : null,
        field(
          'Markierung',
          segmented(
            [
              { value: 'de', label: 'Deutschland' },
              { value: 'us', label: 'USA' },
            ],
            style,
            (v) => this.edit('style', () => (p.markingStyle = v as MarkingStyle), 'structure'),
          ),
        ),
        field(
          'Vorher / Nachher',
          slider(
            this.opacity,
            0,
            1,
            0.05,
            (v) => {
              this.opacity = v;
              setDesignOpacity(this.map, v);
            },
            (v) => `${Math.round(v * 100)} %`,
          ),
        ),
        toggle('Verkehr zeigen', !!p.traffic, (v) => this.edit('traffic', () => (p.traffic = v), 'structure'), 'traffic'),
      ),
      this.simGroup(),
      this.exportGroup(),
      this.fileGroup(),
      foldGroup(
        'keys',
        'Tastenkürzel',
        false,
        h(
          'dl',
          { class: 'keys' },
          ...[
            ['V', 'Auswählen'],
            ['D', 'Straße zeichnen'],
            ['S', 'Ausgewählte Straße teilen'],
            ['K', 'Kurve mit festem Radius'],
            ['R', 'Kreisverkehr auf eine Kreuzung aufziehen'],
            ['A', 'Abschnitt entlang einer Straße ziehen'],
            ['B', 'Bestand aus OpenStreetMap übernehmen'],
            ['Mittlere Maustaste', 'Karte verschieben'],
            ['G', 'Fang an/aus'],
            ['Alt', 'Fang für einen Punkt umkehren'],
            ['Rechtsklick', 'Punkt löschen'],
            ['Entf', 'Straße löschen'],
            ['Strg+Z / Strg+Y', 'Rückgängig / Wiederholen'],
          ].flatMap(([k, v]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)]),
        ),
      ),
    ];
  }

  private simGroup() {
    const sim = this.sim;
    if (!sim) return null;
    const stats = h('div', { class: 'sim-stats', id: 'sim-stats' }, sim.sim ? '' : 'Noch nicht gestartet.');
    return foldGroup(
      'sim',
      'Simulation',
      true,
      h(
        'div',
        { class: 'row' },
        button(sim.running ? 'Pause' : sim.sim ? 'Weiter' : 'Starten', () => (sim.running ? sim.pause() : sim.start()), {
          icon: sim.running ? 'pause' : 'play',
          kind: sim.running ? undefined : 'primary',
          action: 'sim-toggle',
        }),
        button('Beenden', () => sim.stop(), { icon: 'stop', kind: 'ghost', disabled: !sim.sim, action: 'sim-stop' }),
      ),
      field(
        'Zeitraffer',
        segmented(
          [1, 4, 10, 30].map((v) => ({ value: v, label: `${v}×` })),
          sim.speed,
          (v) => {
            sim.speed = v;
            this.render();
          },
          'sim-speed',
        ),
      ),
      field(
        'Verkehrsmenge',
        slider(sim.flow, 100, 1500, 50, (v) => sim.setFlow(v), (v) => `${v} Kfz/h`),
      ),
      stats,
      h('p', { class: 'muted small' }, 'Fahrzeuge starten an offenen Straßenenden, folgen den Spurverbindungen und beachten Ampeln, Vorfahrt und freie Plätze hinter der Kreuzung.'),
    );
  }

  /** Kennzahlen aktualisieren, ohne die Seitenleiste neu aufzubauen */
  showStats(s: SimStats) {
    const el = this.root.querySelector('#sim-stats');
    if (!el) return;
    const mm = Math.floor(s.time / 60), ss = Math.floor(s.time % 60);
    el.replaceChildren(
      ...[
        ['Simulierte Zeit', `${mm}:${String(ss).padStart(2, '0')}`],
        ['Fahrzeuge im Netz', String(s.vehicles)],
        ['⌀ Geschwindigkeit', `${(s.meanSpeed * 3.6).toFixed(0)} km/h`],
        ['Angekommen', String(s.arrived)],
        ['⌀ Reisezeit', s.arrived ? `${s.meanTravel.toFixed(0)} s` : '–'],
      ].map(([k, v]) => h('div', {}, h('span', { class: 'muted' }, k), h('b', {}, v))),
    );
  }

  private exportGroup() {
    const name = this.fileName();
    const info = h('p', { class: 'muted small' });
    const update = () => {
      const { width, height, effective } = exportSize(this.map, this.exportScale);
      const lat = (this.map.getCenter().lat * Math.PI) / 180;
      const mpp = (40075016.686 * Math.cos(lat)) / (512 * 2 ** this.map.getZoom()) / effective;
      info.textContent = `${width} × ${height} px · ${(mpp * 100).toFixed(1).replace('.', ',')} cm pro Pixel`;
    };
    update();
    this.updateExportInfo = update;
    const label = h('span', {}, 'Ausschnitt als PNG');
    const png = button(
      label,
      async () => {
        png.disabled = true;
        label.textContent = 'Wird gerendert …';
        try {
          await exportPng(this.map, `${name}.png`, this.exportScale, (p) => (label.textContent = `Wird gerendert … ${Math.round(p * 100)} %`), this.basemapFailed);
        } catch (err) {
          alert(`Export fehlgeschlagen: ${err}`);
        } finally {
          png.disabled = false;
          label.textContent = 'Ausschnitt als PNG';
        }
      },
      { icon: 'image', action: 'export-png' },
    );
    return foldGroup(
      'export',
      'Export',
      false,
      field(
        'Auflösung',
        segmented(
          [1, 2, 4, 8].map((s) => ({ value: s, label: `${s}×` })),
          this.exportScale,
          (v) => {
            this.exportScale = v;
            this.render();
          },
          'export-scale',
        ),
      ),
      info,
      h(
        'div',
        { class: 'row' },
        png,
        button(
          'Netz als SVG',
          () => {
            const b = this.getBuilt();
            if (!exportSvg(b.surfaces, b.markings, b.decor, `${name}.svg`)) alert('Noch keine Straßen vorhanden.');
          },
          { icon: 'layers', action: 'export-svg', title: 'Ganzes Netz als Vektorgrafik (1 Einheit = 1 m)' },
        ),
      ),
      button(
        'Für SUMO exportieren',
        () => {
          const net = buildNetwork(this.store.project, this.getBuilt().junctions);
          if (!net.edges.length) return alert('Noch keine befahrbaren Straßen vorhanden.');
          downloadSumo(sumoFiles(net, name), name);
        },
        { icon: 'file', action: 'export-sumo', title: 'Knoten, Kanten, Spurverbindungen und Konfiguration für netconvert (SUMO)' },
      ),
      h('p', { class: 'muted small' }, 'Netz erzeugen mit: netconvert -c ', h('code', {}, `${name}.netccfg`)),
    );
  }

  private fileGroup() {
    const fileInput = h('input', {
      type: 'file',
      accept: '.json',
      style: 'display:none',
      onchange: async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        try {
          const p = JSON.parse(await file.text()) as Project;
          if (!Array.isArray(p.roads)) throw new Error('Keine Straßen gefunden');
          this.editor.select(null);
          this.store.replace(p);
          if (p.view) this.map.jumpTo(p.view);
        } catch (err) {
          alert(`Import fehlgeschlagen: ${err}`);
        }
      },
    });
    return foldGroup(
      'file',
      'Datei',
      false,
      h('p', { class: 'muted small' }, 'Wird automatisch im Browser gespeichert.'),
      h('div', { class: 'row' }, button('Speichern', () => this.download(), { icon: 'file' }), button('Öffnen', () => fileInput.click(), { icon: 'folder' }), fileInput),
    );
  }

  // ---- Straße ----------------------------------------------------------------

  private roadView(road: Road): Node[] {
    const count = (road.sections?.length ?? 0) + 1;
    const sec = Math.min(this.editor.selectedSection, count - 1);
    const profile = sectionProfile(road, sec);
    const selected = profile.find((s) => s.id === this.editor.selectedStrip)?.id ?? null;
    const selectStrip = (id: string | null) => this.editor.selectStrip(id);

    return [
      h(
        'header',
        { class: 'inspector-head' },
        h('div', { class: 'kicker' }, this.back(), h('span', {}, 'Straße')),
        h('input', { class: 'title-input', value: road.name, oninput: (e) => this.edit(`name-${road.id}`, () => (road.name = val(e))) }),
        h(
          'div',
          { class: 'head-actions' },
          button('Zoomen', () => this.zoomTo(road), { icon: 'focus', kind: 'ghost' }),
          button('Richtung drehen', () => this.change(() => setSectionProfile(road, sec, reverseProfile(profile))), {
            icon: 'swap',
            title: 'Alle Fahrtrichtungen umkehren (spiegelt den Querschnitt)',
            kind: 'ghost',
            action: 'reverse',
          }),
          button(null, () => this.deleteRoad(road), { icon: 'trash', title: 'Straße löschen', kind: 'danger' }),
        ),
      ),
      group(
        'Abschnitte',
        h(
          'div',
          { class: 'row' },
          segmented(
            Array.from({ length: count }, (_, k) => ({ value: k, label: String(k + 1), title: `Abschnitt ${k + 1}` })),
            sec,
            (k) => this.editor.select(road.id, k),
            'sections',
          ),
          button('Teilen', () => this.editor.setMode(this.editor.mode === 'split' ? 'select' : 'split'), {
            icon: 'split',
            active: this.editor.mode === 'split',
            title: 'Danach auf die Straße klicken: dort beginnt ein neuer Abschnitt',
            action: 'split',
          }),
          sec > 0
            ? button(
                null,
                () =>
                  this.change(() => {
                    road.sections!.splice(sec - 1, 1);
                    if (!road.sections!.length) delete road.sections;
                    this.editor.selectedSection = sec - 1;
                  }),
                { icon: 'trash', title: 'Abschnitt entfernen', kind: 'ghost' },
              )
            : null,
        ),
      ),
      group(
        'Querschnitt',
        button(
          'Vorlage anwenden …',
          () =>
            this.dock.show(
              presetPicker(
                `Vorlage für ${road.name}${count > 1 ? `, Abschnitt ${sec + 1}` : ''}`,
                null,
                (i) => {
                  this.change(() => setSectionProfile(road, sec, presetProfile(i)));
                  this.dock.close();
                },
                () => this.dock.close(),
              ),
            ),
          { icon: 'layers', action: 'preset' },
        ),
        profileBar(profile, selected, (id) => selectStrip(id === selected ? null : id)),
        h(
          'ul',
          { class: 'strips' },
          ...profile.map((s, i) =>
            h(
              'li',
              { class: s.id === selected ? 'open' : '' },
              h(
                'button',
                { class: 'strip-head', onclick: () => selectStrip(s.id === selected ? null : s.id) },
                chip(stripColor(s)),
                h('span', { class: 'name' }, STRIP_TYPES[s.type].label),
                STRIP_TYPES[s.type].directional ? icon(s.dir === 1 ? 'up' : 'down', 13) : h('span', {}),
                h('span', { class: 'muted' }, fmtM(s.width)),
              ),
              s.id === selected ? stripDetails({ profile, index: i, change: this.change, selectStrip }) : null,
            ),
          ),
        ),
        select(
          [{ value: '', label: 'Streifen hinzufügen …' }, ...TYPE_OPTIONS] as { value: StripType | ''; label: string }[],
          '',
          (t) => {
            if (!t) return;
            const n = makeStrip(t);
            this.change(() => profile.splice(Math.floor(profile.length / 2), 0, n));
            selectStrip(n.id);
          },
          'add-strip',
        ),
        toggle('Kurven glätten', road.smooth, (v) => this.change(() => (road.smooth = v))),
        field(
          'Höchstgeschwindigkeit',
          select(
            [{ value: '', label: 'Ohne Schild' }, ...[10, 20, 30, 40, 50, 60, 70, 80, 100].map((v) => ({ value: String(v), label: `${v} km/h` }))],
            road.speed ? String(road.speed) : '',
            (v) => this.change(() => (road.speed = v ? +v : undefined)),
            'speed',
          ),
        ),
      ),
    ];
  }

  // ---- Kreuzung --------------------------------------------------------------

  private nodeView(key: string): (Node | null)[] {
    const j = (this.store.project.junctions ??= {});
    const st: JunctionSettings = { ...defaultJunction(), ...j[key] };
    const set = (patch: Partial<JunctionSettings>) => this.change(() => (j[key] = { ...st, ...patch }));
    const rb = st.kind !== 'cross';
    const control = controlOf(st);
    const arms = approachesAt(this.store.project.roads, key).map((x) => ({ ...x, armId: `${x.road.id}:${x.back ? 'b' : 'f'}` }));
    const laneEdit = this.editor.laneEdit;
    const crossingOptions = Object.entries(CROSSING_LABELS).map(([value, label]) => ({ value: value as Crossing, label }));

    return [
      h(
        'header',
        { class: 'inspector-head' },
        h('div', { class: 'kicker' }, this.back(), h('span', {}, 'Knotenpunkt')),
        h('div', { class: 'title' }, KIND_LABELS[st.kind]),
        h('div', { class: 'muted small' }, [...new Set(arms.map((a) => a.road.name))].join(' · ')),
      ),
      group(
        'Bauform',
        segmented(
          (Object.keys(KIND_LABELS) as JunctionKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] })),
          st.kind,
          (k) => set({ kind: k, ...(k === 'mini' ? { rbRadius: 9, rbLane: 6 } : k === 'roundabout' && st.kind === 'mini' ? { rbRadius: 15, rbLane: 6.5 } : {}) }),
          'kind',
        ),
        ...(rb
          ? [
              field('Außenradius', slider(st.rbRadius, st.kind === 'mini' ? 6 : 10, 40, 0.5, (v) => set({ rbRadius: v }))),
              field('Kreisfahrbahn', slider(st.rbLane, 4, 12, 0.25, (v) => set({ rbLane: v }))),
              field('Ein- und Ausfahrt', slider(st.radius, 3, 20, 0.5, (v) => set({ radius: v }))),
              st.kind === 'roundabout'
                ? field(
                    'Fahrstreifen im Kreis',
                    segmented(
                      [
                        { value: 1, label: 'Einer' },
                        { value: 2, label: 'Zwei' },
                      ],
                      st.rbLanes ?? 1,
                      (n) => set({ rbLanes: n as 1 | 2, ...(n === 2 && st.rbLane < 8 ? { rbLane: 9 } : {}) }),
                    ),
                  )
                : null,
            ]
          : [field('Eckradius', slider(st.radius, 1, 20, 0.5, (v) => set({ radius: v })))]),
      ),
      rb
        ? null
        : group(
            'Regelung',
            select(
              Object.entries(CONTROL_LABELS).map(([value, label]) => ({ value: value as Control, label })),
              control,
              (v) => set({ control: v, stopLines: v !== 'none' }),
              'control',
            ),
          ),
      group(
        'Zufahrten',
        field('Querung (alle)', select(crossingOptions, st.crossing, (v) => set({ crossing: v }), 'crossing')),
        h(
          'div',
          { class: 'arms' },
          ...arms.map((x, i) =>
            h(
              'div',
              { class: 'arm', 'data-arm': x.label },
              h('div', { class: 'arm-name' }, x.label),
              h(
                'div',
                { class: 'arm-controls' },
                !rb && control === 'priority'
                  ? select(
                      [{ value: '', label: 'Vorfahrt: automatisch' }, ...Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))],
                      st.roles?.[x.armId] ?? '',
                      (v) => {
                        const roles = { ...st.roles };
                        if (v) roles[x.armId] = v as ArmRole;
                        else delete roles[x.armId];
                        set({ roles });
                      },
                      'role',
                    )
                  : null,
                select(
                  [{ value: '', label: 'Querung wie alle' }, ...crossingOptions] as { value: Crossing | ''; label: string }[],
                  st.armCrossing?.[x.armId] ?? '',
                  (v) => {
                    const armCrossing = { ...st.armCrossing };
                    if (v) armCrossing[x.armId] = v;
                    else delete armCrossing[x.armId];
                    set({ armCrossing });
                  },
                  'arm-crossing',
                ),
              ),
              rb
                ? null
                : h(
                    'div',
                    { class: 'arm-controls' },
                    button('Linksabbieger', () => this.turnLane(key, i, 'left'), { icon: 'plus', kind: 'ghost', action: 'turn-left', title: 'Abbiegespur (50 m) mit Verziehung anlegen' }),
                    button('Rechtsabbieger', () => this.turnLane(key, i, 'right'), { icon: 'plus', kind: 'ghost', action: 'turn-right' }),
                  ),
            ),
          ),
        ),
        rb ? null : toggle('Radfurt über die Kreuzung', st.bikeCrossing, (v) => set({ bikeCrossing: v })),
        rb ? null : toggle('Abbiegeleitlinien zeichnen', !!st.guides, (v) => set({ guides: v })),
      ),
      rb
        ? null
        : group(
            'Spurverbindungen',
            h(
              'p',
              { class: 'muted small' },
              laneEdit
                ? 'Zufahrt (grün) anklicken, dann Ausfahrten (rot) an- oder abwählen. Orange: links · Blau: geradeaus · Violett: rechts.'
                : 'Werden automatisch aus Spuren und Pfeilen abgeleitet und lassen sich einzeln festlegen.',
            ),
            h(
              'div',
              { class: 'row' },
              button(
                laneEdit ? 'Fertig' : 'Bearbeiten',
                () => {
                  this.editor.laneEdit = !laneEdit;
                  this.editor.selectedLane = null;
                  this.editor.refreshOverlays();
                  this.render();
                },
                { icon: 'lanes', kind: laneEdit ? 'primary' : undefined, action: 'lane-edit' },
              ),
              button('Zurücksetzen', () => set({ connections: undefined }), {
                kind: 'ghost',
                disabled: !st.connections || !Object.keys(st.connections).length,
                title: 'Festgelegte Verbindungen löschen',
              }),
            ),
          ),
      group(
        null,
        h(
          'div',
          { class: 'row' },
          button('Knoten lösen', () => this.detachNode(key), {
            kind: 'ghost',
            title: 'Straßenenden voneinander trennen (Alt beim Ziehen eines Punkts löst nur eine Straße)',
            action: 'detach',
          }),
          button('Standard wiederherstellen', () => this.change(() => delete j[key]), { kind: 'ghost' }),
        ),
      ),
    ];
  }

  /** Straßenenden am Knoten um 1,5 m zurücksetzen — danach sind sie nicht mehr verbunden */
  private detachNode(key: string) {
    const roads = this.store.project.roads.filter((r) => r.points.some((p) => `${p[0].toFixed(8)},${p[1].toFixed(8)}` === key));
    let moved = 0;
    this.store.checkpoint();
    roads.slice(1).forEach((r) => {
      const n = r.points.length;
      const at = r.points.findIndex((p) => `${p[0].toFixed(8)},${p[1].toFixed(8)}` === key);
      if (at !== 0 && at !== n - 1) return; // durchlaufende Straße bleibt, die anderen lösen sich
      const p = r.points[at], q = r.points[at === 0 ? 1 : n - 2];
      const k = Math.cos((p[1] * Math.PI) / 180);
      const len = Math.hypot((q[0] - p[0]) * 111320 * k, (q[1] - p[1]) * 111320) || 1;
      const u = Math.min(0.45, 1.5 / len);
      r.points[at] = [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
      moved++;
    });
    if (!moved) {
      alert('Hier enden keine Straßen — durchgehende Straßen lassen sich nur durch Ziehen mit Alt lösen.');
      return;
    }
    this.editor.select(null);
    this.store.changed('structure');
  }

  private turnLane(key: string, i: number, turn: 'left' | 'right') {
    this.store.checkpoint();
    const a = approachesAt(this.store.project.roads, key)[i];
    if (a && addTurnLane(a, turn)) this.store.changed('structure');
    else alert('Hier lässt sich keine Abbiegespur anlegen: In dieser Zufahrt gibt es keinen Fahrstreifen.');
  }

  // ---- Aktionen --------------------------------------------------------------

  private fileName() {
    return this.store.project.name.replace(/[^\wäöüÄÖÜß -]/g, '').trim() || 'projekt';
  }

  private download() {
    const blob = new Blob([JSON.stringify(this.store.project, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${this.fileName()}.streetlab.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  deleteRoad(road: Road) {
    this.store.checkpoint();
    this.store.project.roads = this.store.project.roads.filter((r) => r.id !== road.id);
    this.editor.select(null);
    this.store.changed('structure');
  }

  private zoomTo(road: Road) {
    const b = new LngLatBounds();
    road.points.forEach((p) => b.extend(p));
    this.map.fitBounds(b, { padding: 120, maxZoom: 19 });
  }
}
