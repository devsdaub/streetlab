import { idbGet, idbSet } from './idb';
import { cleanPoints, emptyProject, type Project, type Road } from './model';

const STORAGE_KEY = 'streetlab.project.v1';

/** geometry = nur Punkte bewegt, props = Eigenschaften, structure = Straßen hinzu/weg, load = alles neu */
export type Reason = 'geometry' | 'props' | 'structure' | 'load';
type Listener = (reason: Reason, source?: unknown) => void;

export class Store {
  project: Project;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();
  private saveTimer = 0;

  /** zuletzt gemessene Größe des gespeicherten Projekts (Bytes) */
  savedBytes = 0;

  private constructor(project: Project) {
    this.project = project;
    // doppelte Punkte (Stücke ohne Länge) aus älteren Ständen bereinigen
    for (const r of project.roads ?? []) cleanPoints(r);
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

  /** Vor jeder Änderung aufrufen, die per Strg+Z rückgängig gemacht werden soll. */
  checkpoint() {
    this.undoStack.push(JSON.stringify(this.project));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  changed(reason: Reason, source?: unknown) {
    this.scheduleSave();
    for (const fn of this.listeners) fn(reason, source);
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(prev);
    this.changed('load');
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(next);
    this.changed('load');
  }

  replace(project: Project) {
    this.checkpoint();
    this.project = project;
    this.changed('load');
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(async () => {
      try {
        // strukturierte Kopie, damit spätere Änderungen das Gespeicherte nicht berühren
        const snapshot = JSON.parse(JSON.stringify(this.project));
        await idbSet(STORAGE_KEY, snapshot);
        this.savedBytes = JSON.stringify(snapshot).length;
      } catch (e) {
        console.error('Speichern fehlgeschlagen', e);
      }
    }, 400);
  }
}
