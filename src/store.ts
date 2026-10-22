import { idbGet, idbSet } from './idb';
import { emptyProject, type Project, type Road } from './model';
import { absorbRoads, deriveNodes, deriveRoad, fractionNear, fromProject, removeCorridor, type CrossEvent, type DerivedRoad, type Net, type PointRef } from './core/net';

const STORAGE_KEY = 'streetlab.project.v1';

/** geometry = nur Punkte bewegt, props = Eigenschaften, structure = Straßen hinzu/weg, load = alles neu */
export type Reason = 'geometry' | 'props' | 'structure' | 'load';
type Listener = (reason: Reason, source?: unknown) => void;

const keyOf = (p: [number, number]) => `${p[0].toFixed(8)},${p[1].toFixed(8)}`;

/**
 * Projekt mit dem Straßennetz (`project.net`) als Wahrheit. Straßen, Knoteneinstellungen und
 * Streifen-Zuordnungen im bisherigen Format (`roads`, `junctions`, `stripLinks`) werden daraus
 * abgeleitet — Darstellung, Spurnetz und Simulation lesen nur diese.
 *
 * Zwei Wege, etwas zu ändern:
 * - `netChanged()` nach Operationen am Netz (Geometrie, Topologie): nur neu ableiten.
 * - `changed()` nach Bearbeitung der abgeleiteten Straßen (Name, Querschnitte, Abschnitte,
 *   Knoteneinstellungen …): diese erst ins Netz übernehmen, dann neu ableiten.
 */
export class Store {
  project: Project & { net: Net };
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();
  private saveTimer = 0;

  /** zuletzt gemessene Größe des gespeicherten Projekts (Bytes) */
  savedBytes = 0;
  /** je abgeleiteter Straße: was jeder ihrer Punkte im Netz ist (Knoten, Stützpunkt, Hilfspunkt) */
  refs: Record<string, PointRef[]> = {};
  /** Ableitung je Straßenzug (für Teil-Neuberechnung und die Rückübernahme) */
  private derived = new Map<string, DerivedRoad>();

  private constructor(project: Project) {
    this.project = Store.withNet(project);
    this.derive();
  }

  /** ältere Projekte (ohne Netz) einmalig umrechnen */
  private static withNet(p: Project): Project & { net: Net } {
    if (!p.net) p.net = fromProject({ roads: p.roads ?? [], junctions: p.junctions, stripLinks: p.stripLinks });
    p.roads ??= [];
    return p as Project & { net: Net };
  }

  /**
   * Projekt laden: IndexedDB (unbegrenzt). Ein Stand im alten localStorage-Schlüssel hat Vorrang
   * und wird einmalig übernommen — so funktionieren auch ältere Projekte und Testszenen.
   */
  static async load(): Promise<Store> {
    let project: Project | undefined;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        project = JSON.parse(raw);
        await idbSet(STORAGE_KEY, project);
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      /* kein localStorage */
    }
    if (!project) {
      try {
        project = await idbGet<Project>(STORAGE_KEY);
      } catch (e) {
        console.error('Laden aus IndexedDB fehlgeschlagen', e);
      }
    }
    return new Store(project ?? emptyProject());
  }

  on(fn: Listener) {
    this.listeners.add(fn);
  }

  road(id: string | null): Road | undefined {
    return id ? this.project.roads.find((r) => r.id === id) : undefined;
  }

  /** Knoten-ID zu einer Koordinate (Knotenschlüssel der Darstellung) */
  nodeAt(key: string): string | undefined {
    for (const n of Object.values(this.project.net.nodes)) if (keyOf(n.pos) === key) return n.id;
    return undefined;
  }

  /** Vor jeder Änderung aufrufen, die per Strg+Z rückgängig gemacht werden soll. */
  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Nur das Netz und die Projekteinstellungen — die Straßen werden ohnehin abgeleitet */
  private snapshot() {
    return JSON.stringify(this.persisted());
  }

  private persisted() {
    const { roads: _r, junctions: _j, stripLinks: _s, ...rest } = this.project;
    return { ...rest, roads: [] };
  }

  private restore(json: string) {
    this.project = Store.withNet({ roads: [], ...JSON.parse(json) });
    this.derive();
  }

  /** Abgeleitete Straßen wurden bearbeitet: ins Netz übernehmen, neu ableiten, melden */
  changed(reason: Reason, source?: unknown) {
    this.absorb();
    this.netChanged(reason, source);
  }

  /**
   * Das Netz wurde durch Operationen geändert: neu ableiten, melden. `only`: nur diese Straßenzüge
   * haben sich geändert (beim Ziehen — große Netze bleiben flüssig).
   */
  netChanged(reason: Reason, source?: unknown, only?: Iterable<string>) {
    this.derive(only);
    this.scheduleSave();
    for (const fn of this.listeners) fn(reason, source);
  }

  /** Straßen, Knoteneinstellungen und Streifen-Zuordnungen aus dem Netz berechnen */
  private derive(only?: Iterable<string>) {
    const net = this.project.net;
    if (only) for (const id of only) {
      const c = net.corridors[id];
      if (c) this.derived.set(id, deriveRoad(net, c));
      else this.derived.delete(id);
    }
    else {
      this.derived.clear();
      for (const c of Object.values(net.corridors)) this.derived.set(c.id, deriveRoad(net, c));
    }
    const nodes = deriveNodes(net);
    const roads: Road[] = [];
    this.refs = {};
    for (const [id, d] of this.derived) {
      roads.push(d.road);
      this.refs[id] = d.refs;
      Object.assign(nodes.stripLinks, d.links);
    }
    this.project.roads = roads;
    this.project.junctions = nodes.junctions;
    this.project.stripLinks = nodes.stripLinks;
  }

  /** Netz-Bezug eines Punkts einer abgeleiteten Straße */
  pointRef(roadId: string, index: number): PointRef | undefined {
    return this.refs[roadId]?.[index];
  }

  /**
   * Bearbeitungen an den abgeleiteten Straßen ins Netz übernehmen: Name, Glättung, Tempo,
   * Querschnitte und Abschnitte (als Lage entlang der Straße), Knoteneinstellungen, Streifen-
   * Zuordnungen. Geometrie kommt nur aus dem Netz — eingefügte Hilfspunkte ändern sie nicht.
   * Neue Straßen (z. B. aus dem Import) werden ins Netz aufgenommen, entfernte entfernt.
   */
  private absorb() {
    const p = this.project;
    const net = p.net;
    const ids = new Set(p.roads.map((r) => r.id));
    for (const id of Object.keys(net.corridors)) if (!ids.has(id)) removeCorridor(net, id);
    const fresh: Road[] = [];
    for (const r of p.roads) {
      const c = net.corridors[r.id];
      if (!c) {
        fresh.push(r);
        continue;
      }
      c.name = r.name;
      c.smooth = r.smooth;
      if (r.speed) c.speed = r.speed;
      else delete c.speed;
      const events: CrossEvent[] = [{ at: 0, profile: r.profile }];
      const known = this.derived.get(r.id)?.eventAt;
      for (const s of r.sections ?? []) {
        // bekannte Grenze: ihre Lage aus der Ableitung; neue (z. B. vom Abschnitt-Werkzeug) ausmessen
        const q = r.points[s.index];
        const at = known?.get(keyOf(q)) ?? fractionNear(net, c.id, q);
        if (at <= 1e-6 || at >= 1 - 1e-6) continue;
        const ev: CrossEvent = { at, profile: s.profile };
        if (s.transition) ev.transition = s.transition;
        const prefix = `sec:${r.id}:${s.index}|`;
        for (const [k, to] of Object.entries(p.stripLinks ?? {})) if (k.startsWith(prefix)) (ev.links ??= {})[k.slice(prefix.length)] = to;
        events.push(ev);
      }
      events.sort((x, y) => x.at - y.at);
      c.cross = events;
    }
    for (const n of Object.values(net.nodes)) {
      const k = keyOf(n.pos);
      const st = p.junctions?.[k];
      if (st) n.junction = st;
      else delete n.junction;
      const links: Record<string, string> = {};
      for (const [key, to] of Object.entries(p.stripLinks ?? {})) if (key.startsWith(k + '|')) links[key.slice(k.length + 1)] = to;
      if (Object.keys(links).length) n.links = links;
      else delete n.links;
    }
    if (fresh.length) absorbRoads(net, { roads: fresh, junctions: p.junctions, stripLinks: p.stripLinks });
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.snapshot());
    this.restore(prev);
    this.netChanged('load');
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    this.netChanged('load');
  }

  replace(project: Project) {
    this.checkpoint();
    this.project = Store.withNet(project);
    this.netChanged('load');
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(async () => {
      try {
        // strukturierte Kopie, damit spätere Änderungen das Gespeicherte nicht berühren
        // nur das Netz — Straßen, Knoteneinstellungen und Zuordnungen werden beim Laden abgeleitet
        const snapshot = JSON.parse(JSON.stringify(this.persisted()));
        await idbSet(STORAGE_KEY, snapshot);
        this.savedBytes = JSON.stringify(snapshot).length;
      } catch (e) {
        console.error('Speichern fehlgeschlagen', e);
      }
    }, 400);
  }
}
