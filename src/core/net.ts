/**
 * Straßennetz als Graph mit Identitäten (siehe docs/SPURMODELL.md): Knoten mit fester ID und
 * Straßenzüge zwischen zwei Knoten. Topologie entsteht nur durch Operationen, nie durch
 * zufällig gleiche Koordinaten. Aus dem Netz werden die bisherigen `Road`-Objekte abgeleitet,
 * mit denen Darstellung, Kreuzungsbau, Spurnetz und Simulation arbeiten.
 */
import { localProjection, type Vec } from '../geometry';
import { uid, type JunctionSettings, type LngLat, type Project, type Road, type Section, type Strip } from '../model';

export interface NetNode {
  id: string;
  pos: LngLat;
  /** Kreuzungseinstellungen (Bauform, Regelung, Spurverbindungen …) */
  junction?: JunctionSettings;
  /** Durchgangsknoten (zwei Straßenzüge): Streifen-Zuordnung an der Verziehung, Streifen → Streifen */
  links?: Record<string, string>;
}

/** Ab Lage `at` (Anteil 0…1 der Länge) gilt `profile` */
export interface CrossEvent {
  at: number;
  profile: Strip[];
  /** Länge der Verziehung zum vorigen Querschnitt (m), sonst automatisch */
  transition?: number;
  /** Streifen-Zuordnung an dieser Verziehung, Streifen → Streifen ("" = endet/entsteht) */
  links?: Record<string, string>;
}

export interface Corridor {
  id: string;
  name: string;
  /** Anfangs- und Endknoten */
  a: string;
  b: string;
  /** innere Stützpunkte (ohne die Enden — die liegen auf den Knoten) */
  shape: LngLat[];
  /** Querschnitte entlang der Lage, das erste bei 0 */
  cross: CrossEvent[];
  smooth: boolean;
  speed?: number;
}

export interface Net {
  nodes: Record<string, NetNode>;
  corridors: Record<string, Corridor>;
}

export const emptyNet = (): Net => ({ nodes: {}, corridors: {} });

// ---- Geometrie-Hilfen ---------------------------------------------------------

/** Linienzug eines Straßenzugs inklusive Enden */
export const corridorPoints = (net: Net, c: Corridor): LngLat[] => [net.nodes[c.a].pos, ...c.shape, net.nodes[c.b].pos];

const metres = (pts: LngLat[]) => {
  const proj = localProjection(pts[0]);
  const q = pts.map(proj.fwd);
  const cum = [0];
  for (let i = 1; i < q.length; i++) cum.push(cum[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]));
  return { proj, q, cum, length: cum[cum.length - 1] };
};

/** Punkt bei Anteil `at` der Länge, mit Index des Stücks davor */
export function pointAtFraction(pts: LngLat[], at: number): { p: LngLat; i: number; t: number } {
  const m = metres(pts);
  const s = Math.max(0, Math.min(1, at)) * m.length;
  let i = 1;
  while (i < m.cum.length - 1 && m.cum[i] < s) i++;
  const l = m.cum[i] - m.cum[i - 1] || 1;
  const t = (s - m.cum[i - 1]) / l;
  const [a, b] = [m.q[i - 1], m.q[i]];
  return { p: m.proj.inv([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as Vec), i: i - 1, t };
}

/** Anteil der Länge, an dem der Stützpunkt k liegt */
export function fractionOfVertex(pts: LngLat[], k: number): number {
  const m = metres(pts);
  return m.length ? m.cum[k] / m.length : 0;
}

export const corridorLength = (net: Net, c: Corridor) => metres(corridorPoints(net, c)).length;

// ---- Invarianten -------------------------------------------------------------

/** Liste der Verstöße (leer = Netz ist in Ordnung) */
export function checkNet(net: Net): string[] {
  const errs: string[] = [];
  const used = new Set<string>();
  for (const c of Object.values(net.corridors)) {
    for (const k of [c.a, c.b]) {
      if (!net.nodes[k]) errs.push(`Straßenzug ${c.id}: Knoten ${k} fehlt`);
      used.add(k);
    }
    if (c.a === c.b && !c.shape.length) errs.push(`Straßenzug ${c.id}: Anfang = Ende ohne Verlauf`);
    if (!c.cross.length || c.cross[0].at !== 0) errs.push(`Straßenzug ${c.id}: kein Querschnitt ab 0`);
    for (let i = 1; i < c.cross.length; i++) if (!(c.cross[i].at > c.cross[i - 1].at) || c.cross[i].at > 1) errs.push(`Straßenzug ${c.id}: Querschnitte nicht aufsteigend`);
  }
  for (const id of Object.keys(net.nodes)) if (!used.has(id)) errs.push(`Knoten ${id} ohne Straßenzug`);
  const seen = new Map<string, string>();
  for (const n of Object.values(net.nodes)) {
    const k = n.pos[0].toFixed(8) + ',' + n.pos[1].toFixed(8);
    if (seen.has(k)) errs.push(`Knoten ${n.id} und ${seen.get(k)} liegen übereinander`);
    seen.set(k, n.id);
  }
  return errs;
}

// ---- Ableitung: Netz → Straßen (für Darstellung, Spurnetz, Simulation) ---------------

const keyOf = (p: LngLat) => `${p[0].toFixed(8)},${p[1].toFixed(8)}`;

/**
 * Straßen und Knoteneinstellungen im bisherigen Format. Querschnitts-Ereignisse werden zu
 * Abschnitten; liegt ein Ereignis nicht auf einem Stützpunkt, wird dort einer eingefügt (in der
 * abgeleiteten Straße — das Netz bleibt unberührt).
 */
export function toRoads(net: Net): { roads: Road[]; junctions: Record<string, JunctionSettings>; stripLinks: Record<string, string> } {
  const roads: Road[] = [];
  const stripLinks: Record<string, string> = {};
  for (const c of Object.values(net.corridors)) {
    const points = corridorPoints(net, c).map((p) => [p[0], p[1]] as LngLat);
    const sections: Section[] = [];
    for (const ev of c.cross.slice(1)) {
      let index: number;
      const m = metres(points);
      const s = ev.at * m.length;
      // auf einen Stützpunkt (±1 m) legen, sonst einen einfügen
      const near = m.cum.findIndex((x) => Math.abs(x - s) < 1);
      if (near > 0 && near < points.length - 1) index = near;
      else {
        const { p, i } = pointAtFraction(points, ev.at);
        index = i + 1;
        points.splice(index, 0, p);
        for (const x of sections) if (x.index >= index) x.index++;
      }
      if (sections.some((x) => x.index === index)) continue;
      sections.push({ index, profile: ev.profile, ...(ev.transition ? { transition: ev.transition } : {}) });
      for (const [from, to] of Object.entries(ev.links ?? {})) stripLinks[`sec:${c.id}:${index}|${from}`] = to;
    }
    sections.sort((x, y) => x.index - y.index);
    roads.push({ id: c.id, name: c.name, points, profile: c.cross[0].profile, smooth: c.smooth, ...(sections.length ? { sections } : {}), ...(c.speed ? { speed: c.speed } : {}) });
  }
  const junctions: Record<string, JunctionSettings> = {};
  for (const n of Object.values(net.nodes)) {
    if (n.junction) junctions[keyOf(n.pos)] = n.junction;
    for (const [from, to] of Object.entries(n.links ?? {})) stripLinks[`${keyOf(n.pos)}|${from}`] = to;
  }
  return { roads, junctions, stripLinks };
}

// ---- Umrechnung: bisheriges Projekt → Netz ------------------------------------

/**
 * Knoten entstehen an allen Straßenenden und an Punkten, die mehrere Straßen teilen; Straßen, die
 * durch einen solchen Punkt laufen, werden dort in Straßenzüge geteilt. Abschnitte werden zu
 * Ereignissen an ihrer Lage.
 */
export function fromProject(p: Pick<Project, 'roads' | 'junctions' | 'stripLinks'>): Net {
  const net = emptyNet();
  const shared = new Map<string, Set<string>>();
  for (const r of p.roads) for (const q of r.points) shared.set(keyOf(q), (shared.get(keyOf(q)) ?? new Set()).add(r.id));
  const nodeAt = new Map<string, string>();
  const node = (q: LngLat) => {
    const k = keyOf(q);
    let id = nodeAt.get(k);
    if (!id) {
      id = uid();
      nodeAt.set(k, id);
      net.nodes[id] = { id, pos: [q[0], q[1]] };
      if (p.junctions?.[k]) net.nodes[id].junction = structuredClone(p.junctions[k]);
    }
    return id;
  };
  for (const r of p.roads) {
    if (r.points.length < 2) continue;
    const cuts = [0];
    for (let i = 1; i < r.points.length - 1; i++) if ((shared.get(keyOf(r.points[i]))?.size ?? 0) >= 2) cuts.push(i);
    cuts.push(r.points.length - 1);
    for (let k = 0; k < cuts.length - 1; k++) {
      const [i0, i1] = [cuts[k], cuts[k + 1]];
      const pts = r.points.slice(i0, i1 + 1);
      const id = k === 0 ? r.id : `${r.id}-${k + 1}`;
      // Querschnitt am Anfang des Stücks und Abschnittsgrenzen darin
      const sec = (i: number) => {
        let prof = r.profile;
        for (const s of r.sections ?? []) if (s.index <= i) prof = s.profile;
        return prof;
      };
      const cross: CrossEvent[] = [{ at: 0, profile: structuredClone(sec(i0)) }];
      for (const s of r.sections ?? []) {
        if (s.index <= i0 || s.index >= i1) continue;
        const ev: CrossEvent = { at: fractionOfVertex(pts, s.index - i0), profile: structuredClone(s.profile) };
        if (s.transition) ev.transition = s.transition;
        const prefix = `sec:${r.id}:${s.index}|`;
        for (const [key, to] of Object.entries(p.stripLinks ?? {})) if (key.startsWith(prefix)) (ev.links ??= {})[key.slice(prefix.length)] = to;
        cross.push(ev);
      }
      net.corridors[id] = { id, name: r.name, a: node(pts[0]), b: node(pts[pts.length - 1]), shape: pts.slice(1, -1).map((q) => [q[0], q[1]]), cross, smooth: r.smooth, ...(r.speed ? { speed: r.speed } : {}) };
    }
  }
  // Streifen-Zuordnungen an Durchgangsknoten
  for (const [key, to] of Object.entries(p.stripLinks ?? {})) {
    if (key.startsWith('sec:')) continue;
    const [k, strip] = key.split('|');
    const id = nodeAt.get(k);
    if (id) (net.nodes[id].links ??= {})[strip] = to;
  }
  return net;
}

// ---- Operationen ---------------------------------------------------------------
// Alle Operationen verändern das übergebene Netz (der Aufrufer legt vorher einen Undo-Punkt an).

/** Straßenzüge an einem Knoten */
export const corridorsAt = (net: Net, nodeId: string) => Object.values(net.corridors).filter((c) => c.a === nodeId || c.b === nodeId);

export function moveNode(net: Net, nodeId: string, pos: LngLat) {
  net.nodes[nodeId].pos = [pos[0], pos[1]];
}

/** Neuen Knoten anlegen */
export function addNode(net: Net, pos: LngLat): string {
  const id = uid();
  net.nodes[id] = { id, pos: [pos[0], pos[1]] };
  return id;
}

/** Wo ein neuer Straßenzug beginnt oder endet: an einem Knoten, auf einem Straßenzug, oder frei */
export type Anchor = { node: string } | { corridor: string; at: number } | { pos: LngLat };

/** Anker auflösen: Knoten verwenden, Straßenzug teilen oder neuen Knoten anlegen */
export function resolveAnchor(net: Net, a: Anchor): string {
  if ('node' in a) return a.node;
  if ('corridor' in a) return splitCorridor(net, a.corridor, a.at);
  return addNode(net, a.pos);
}

/** Neuen Straßenzug zeichnen: Enden an Anker hängen, innere Punkte frei */
export function addCorridor(net: Net, start: Anchor, inner: LngLat[], end: Anchor, profile: Strip[], name: string, smooth = true): string {
  const a = resolveAnchor(net, start);
  const b = resolveAnchor(net, end);
  const id = uid();
  net.corridors[id] = { id, name, a, b, shape: inner.map((q) => [q[0], q[1]]), cross: [{ at: 0, profile: profile.map((s) => ({ ...structuredClone(s), id: uid() })) }], smooth };
  return id;
}

/**
 * Straßenzug an Lage `at` teilen: neuer Knoten dort, zwei Straßenzüge. Querschnitts-Ereignisse
 * werden auf die beiden Teile umgerechnet. Gibt die ID des neuen Knotens zurück.
 */
export function splitCorridor(net: Net, cid: string, at: number): string {
  const c = net.corridors[cid];
  const pts = corridorPoints(net, c);
  // nahe an einem Ende: den vorhandenen Knoten nehmen
  const L = corridorLength(net, c);
  if (at * L < 0.5) return c.a;
  if ((1 - at) * L < 0.5) return c.b;
  const { p, i } = pointAtFraction(pts, at);
  const nodeId = addNode(net, p);
  const first = [...pts.slice(0, i + 1), p];
  const second = [p, ...pts.slice(i + 1)];
  const lenFirst = metres(first).length, lenSecond = metres(second).length;
  const total = lenFirst + lenSecond || 1;
  const cut = lenFirst / total;
  const profileAtCut = [...c.cross].reverse().find((e) => e.at <= cut)!.profile;
  const secondId = uid();
  const crossA = c.cross.filter((e) => e.at < cut).map((e) => ({ ...e, at: e.at / cut }));
  const crossB: CrossEvent[] = [
    { at: 0, profile: structuredClone(profileAtCut) },
    ...c.cross.filter((e) => e.at > cut).map((e) => ({ ...e, at: (e.at - cut) / (1 - cut) })),
  ];
  // gleiche Streifen-IDs auf beiden Seiten: nahtlos ohne Verziehung
  crossB[0].profile = profileAtCut.map((s) => ({ ...s }));
  net.corridors[secondId] = { ...structuredClone(c), id: secondId, a: nodeId, b: c.b, shape: second.slice(1, -1), cross: crossB };
  c.b = nodeId;
  c.shape = first.slice(1, -1);
  c.cross = crossA;
  return nodeId;
}

/**
 * Straßenzug entfernen. Knoten ohne Straßenzug entfallen; ein Knoten, an dem danach nur noch
 * zwei Teile derselben Straße mit gleichem Querschnitt hängen, wird wieder zusammengefügt.
 */
export function removeCorridor(net: Net, cid: string) {
  const c = net.corridors[cid];
  if (!c) return;
  delete net.corridors[cid];
  for (const k of [c.a, c.b]) {
    const rest = corridorsAt(net, k);
    if (!rest.length) delete net.nodes[k];
    else if (rest.length === 2) healNode(net, k);
  }
}

/** Gleicher Querschnitt, unabhängig von den Streifen-IDs */
const sameCross = (p: Strip[], q: Strip[]) =>
  p.length === q.length && p.every((s, i) => s.type === q[i].type && Math.abs(s.width - q[i].width) < 0.01 && s.dir === q[i].dir && s.planting === q[i].planting && s.parkAngle === q[i].parkAngle);

/** Umgekehrte Zeichenrichtung (Querschnitt spiegeln) */
export function reverseCorridor(net: Net, cid: string) {
  const c = net.corridors[cid];
  const L = c.cross;
  const flip = (prof: Strip[]) => prof.slice().reverse().map((s) => ({ ...s, dir: -s.dir as 1 | -1 }));
  const events: CrossEvent[] = [{ at: 0, profile: flip(L[L.length - 1].profile) }];
  for (let i = L.length - 1; i > 0; i--) events.push({ ...L[i], at: 1 - L[i].at, profile: flip(L[i - 1].profile) });
  [c.a, c.b] = [c.b, c.a];
  c.shape = c.shape.slice().reverse();
  c.cross = events;
}

/**
 * Durchgangsknoten (genau zwei Straßenzüge, keine Kreuzungseinstellung) auflösen, wenn beide Teile
 * dieselbe Straße mit gleichem Querschnitt am Knoten sind. Gibt true zurück, wenn zusammengefügt.
 */
export function healNode(net: Net, nodeId: string): boolean {
  const list = corridorsAt(net, nodeId);
  if (list.length !== 2 || net.nodes[nodeId].junction) return false;
  let [x, y] = list;
  if (x === y || x.name !== y.name || x.smooth !== y.smooth || x.speed !== y.speed) return false;
  // x endet am Knoten, y beginnt dort
  if (x.b !== nodeId) reverseCorridor(net, x.id);
  if (y.a !== nodeId) reverseCorridor(net, y.id);
  [x, y] = [net.corridors[x.id], net.corridors[y.id]];
  if (x.a === y.b) return false; // würde einen Ring ohne Knoten ergeben
  if (!sameCross(x.cross[x.cross.length - 1].profile, y.cross[0].profile)) return false;
  const lx = corridorLength(net, x), ly = corridorLength(net, y), L = lx + ly || 1;
  const cut = lx / L;
  x.cross = [...x.cross.map((e) => ({ ...e, at: e.at * cut })), ...y.cross.slice(1).map((e) => ({ ...e, at: cut + e.at * (1 - cut) }))];
  x.shape = [...x.shape, net.nodes[nodeId].pos, ...y.shape];
  x.b = y.b;
  delete net.corridors[y.id];
  delete net.nodes[nodeId];
  return true;
}

/** Knoten `drop` auf Knoten `keep` legen (Einrasten eines Endes auf einem anderen Knoten) */
export function mergeNodes(net: Net, keep: string, drop: string) {
  if (keep === drop) return;
  for (const c of Object.values(net.corridors)) {
    if (c.a === drop) c.a = keep;
    if (c.b === drop) c.b = keep;
  }
  // Straßenzug ohne Länge (beide Enden jetzt am selben Knoten, kein Verlauf) entfällt
  for (const c of Object.values(net.corridors)) if (c.a === c.b && !c.shape.length) delete net.corridors[c.id];
  delete net.nodes[drop];
}

/** Ende eines Straßenzugs vom Knoten lösen: eigener Knoten etwas entlang der Straße versetzt */
export function detachEnd(net: Net, cid: string, end: 'a' | 'b', offset = 1.5): string {
  const c = net.corridors[cid];
  const pts = corridorPoints(net, c);
  const L = metres(pts).length;
  const { p } = pointAtFraction(pts, end === 'a' ? Math.min(0.5, offset / L) : Math.max(0.5, 1 - offset / L));
  const id = addNode(net, p);
  c[end] = id;
  return id;
}

/** Querschnitt zwischen den Lagen at0 < at1 setzen; davor und danach bleibt alles */
export function setCross(net: Net, cid: string, at0: number, at1: number, profile: Strip[]) {
  const c = net.corridors[cid];
  const before = (at: number) => [...c.cross].reverse().find((e) => e.at <= at)!;
  const after = before(at1);
  const fresh = profile.map((s) => ({ ...structuredClone(s), id: uid() }));
  const kept = c.cross.filter((e) => e.at < at0 || e.at > at1);
  const events: CrossEvent[] = [...kept];
  if (at0 <= 0.0001) events.unshift({ at: 0, profile: fresh });
  else events.push({ at: at0, profile: fresh });
  if (at1 < 0.9999 && !kept.some((e) => Math.abs(e.at - at1) < 1e-6)) events.push({ at: at1, profile: after.profile });
  events.sort((x, y) => x.at - y.at);
  // erstes Ereignis bei 0; doppelte Lagen und Wechsel ohne Unterschied entfallen
  const out: CrossEvent[] = [];
  for (const e of events) {
    if (out.length && Math.abs(out[out.length - 1].at - e.at) < 1e-6) out[out.length - 1] = e;
    else if (!out.length || !sameCross(out[out.length - 1].profile, e.profile) || out[out.length - 1].profile.some((s, i) => s.turn !== e.profile[i]?.turn)) out.push(e);
  }
  out[0] = { ...out[0], at: 0 };
  c.cross = out;
}

/** Ganzen Straßenzug verschieben (samt seiner Knoten — angehängte Straßen ziehen mit) */
export function translateCorridor(net: Net, cid: string, d: [number, number]) {
  const c = net.corridors[cid];
  const mv = (q: LngLat): LngLat => [q[0] + d[0], q[1] + d[1]];
  c.shape = c.shape.map(mv);
  for (const k of new Set([c.a, c.b])) net.nodes[k].pos = mv(net.nodes[k].pos);
}
