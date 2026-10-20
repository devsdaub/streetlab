/**
 * Spurnetz für Simulation und SUMO-Export: Kanten je Fahrtrichtung mit Spuren, Knoten mit
 * Regelung und Verbindungen zwischen Spuren (aus dem Kreuzungseditor bzw. automatisch).
 * Alle Koordinaten in Metern in einer gemeinsamen lokalen Projektion.
 */
import { localProjection, offsetPolyline, type Vec } from './geometry';
import type { JunctionInfo } from './junction';
import { controlOf, defaultJunction, type Control, type JunctionKind, type LngLat, type Project, type StripType } from './model';
import { networkGraph, nodeKey } from './render';

export type LaneClass = 'car' | 'bike' | 'tram' | 'ped';

export interface LaneDef {
  /** SUMO-Index: 0 = rechte Spur */
  index: number;
  stripId: string;
  type: StripType;
  cls: LaneClass;
  width: number;
  /** Mittellinie der Spur in Fahrtrichtung (m) */
  shape: Vec[];
  length: number;
}

export interface EdgeDef {
  id: string;
  segId: string;
  roadId: string;
  from: string;
  to: string;
  forward: boolean;
  /** Bezugslinie für SUMO (linker Rand der linken Spur, Spuren liegen rechts davon) */
  shape: Vec[];
  lanes: LaneDef[];
  /** zulässige Geschwindigkeit (m/s) */
  speed: number;
}

export interface NodeDef {
  id: string;
  key: string;
  pos: Vec;
  kind: 'junction' | 'pass' | 'end';
  control: Control;
  junctionKind: JunctionKind;
}

export interface ConnDef {
  from: string;
  fromLane: number;
  to: string;
  toLane: number;
  /** Fahrweg durch den Knoten (m); fehlt bei automatisch erzeugten Übergängen */
  pts?: Vec[];
  /** aus dem Kreuzungseditor (true) oder automatisch ergänzt */
  explicit: boolean;
}

export interface Network {
  nodes: Map<string, NodeDef>;
  edges: EdgeDef[];
  conns: ConnDef[];
  toLocal: (p: LngLat) => Vec;
  toLngLat: (p: Vec) => LngLat;
}

const CLASS: Partial<Record<StripType, LaneClass>> = { drive: 'car', bus: 'car', bike: 'bike', tram: 'tram', sidewalk: 'ped' };
const length = (pts: Vec[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

export function buildNetwork(project: Project, junctionInfo: Map<string, JunctionInfo> = new Map()): Network {
  const { segments } = networkGraph(project.roads);
  const origin = project.roads[0]?.points[0] ?? [0, 0];
  const proj = localProjection(origin);
  const nodes = new Map<string, NodeDef>();
  const edges: EdgeDef[] = [];
  const conns: ConnDef[] = [];

  const node = (key: string, at: LngLat) => {
    let n = nodes.get(key);
    if (!n) {
      const st = { ...defaultJunction(), ...project.junctions?.[key] };
      const kind = key.startsWith('end:') ? 'end' : key.startsWith('sec:') ? 'pass' : 'junction';
      n = { id: `n${nodes.size}`, key, pos: proj.fwd(at), kind, control: controlOf(st), junctionKind: st.kind };
      nodes.set(key, n);
    }
    return n;
  };

  /** Kante je Segment und Richtung */
  const edgeOf = new Map<string, EdgeDef>();
  segments.forEach((seg, si) => {
    const center = seg.center.map(proj.fwd);
    const a = node(seg.start, seg.center[0]);
    const b = node(seg.end, seg.center[seg.center.length - 1]);
    const total = seg.profile.reduce((s, x) => s + x.width, 0);
    let left = total / 2;
    const placed = seg.profile.map((s) => {
      const p = { s, l: left, r: left - s.width };
      left -= s.width;
      return p;
    });
    const speedKmh = seg.road.speed ?? 50;
    for (const forward of [true, false]) {
      const dir = forward ? 1 : -1;
      // Spuren dieser Richtung; Gehweg am rechten Rand dieser Richtung
      const lanesLR = placed.filter((p) => CLASS[p.s.type] && CLASS[p.s.type] !== 'ped' && p.s.dir === dir);
      if (!lanesLR.some((p) => CLASS[p.s.type] === 'car' || CLASS[p.s.type] === 'bike' || CLASS[p.s.type] === 'tram')) continue;
      const sidewalk = forward ? placed[placed.length - 1] : placed[0];
      const withWalk = sidewalk?.s.type === 'sidewalk' ? [...(forward ? lanesLR : []), sidewalk, ...(forward ? [] : lanesLR)] : lanesLR;
      // in Fahrtrichtung von links nach rechts; SUMO zählt von rechts
      const ordered = forward ? withWalk : withWalk.slice().reverse();
      const lanes: LaneDef[] = ordered
        .slice()
        .reverse()
        .map((p, index) => {
          let shape = offsetPolyline(center, (p.l + p.r) / 2);
          if (!forward) shape = shape.slice().reverse();
          return { index, stripId: p.s.id, type: p.s.type, cls: CLASS[p.s.type]!, width: p.s.width, shape, length: length(shape) };
        });
      const leftEdge = forward ? ordered[0].l : -ordered[0].r;
      let ref = offsetPolyline(center, forward ? leftEdge : -leftEdge);
      if (!forward) ref = ref.slice().reverse();
      const e: EdgeDef = {
        id: `e${si}${forward ? 'f' : 'b'}`,
        segId: seg.id,
        roadId: seg.road.id,
        from: (forward ? a : b).id,
        to: (forward ? b : a).id,
        forward,
        shape: ref,
        lanes,
        speed: speedKmh / 3.6,
      };
      edges.push(e);
      edgeOf.set(`${seg.id}|${forward ? 'f' : 'b'}`, e);
    }
  });

  // ---- Verbindungen aus dem Kreuzungseditor ----
  const segAt = (key: string, armId: string) => {
    const [roadId, side] = armId.split(':');
    return segments.find((s) => s.road.id === roadId && (side === 'f' ? s.start === key : s.end === key));
  };
  const handled = new Set<string>();
  for (const [key, info] of junctionInfo) {
    if (!info.links.length) continue;
    handled.add(key);
    for (const link of info.links) {
      const inL = info.lanes.find((l) => l.id === link.from && l.kind === 'in');
      const outL = info.lanes.find((l) => l.id === link.to && l.kind === 'out');
      if (!inL || !outL) continue;
      const sIn = segAt(key, inL.armId), sOut = segAt(key, outL.armId);
      if (!sIn || !sOut) continue;
      // Zufahrt am Arm „f“ fährt gegen die Zeichenrichtung zum Knoten, Ausfahrt am Arm „f“ mit ihr
      const eIn = edgeOf.get(`${sIn.id}|${inL.armId.endsWith(':f') ? 'b' : 'f'}`);
      const eOut = edgeOf.get(`${sOut.id}|${outL.armId.endsWith(':f') ? 'f' : 'b'}`);
      const li = eIn?.lanes.find((l) => l.stripId === link.from);
      const lo = eOut?.lanes.find((l) => l.stripId === link.to);
      if (!eIn || !eOut || !li || !lo) continue;
      conns.push({ from: eIn.id, fromLane: li.index, to: eOut.id, toLane: lo.index, pts: link.pts.map(proj.fwd), explicit: true });
    }
  }

  // ---- übrige Knoten: alle Weiterfahrten ohne Wenden, Spuren gleicher Art nach Lage zuordnen ----
  for (const n of nodes.values()) {
    if (n.kind === 'end' || handled.has(n.key)) continue;
    const ins = edges.filter((e) => e.to === n.id), outs = edges.filter((e) => e.from === n.id);
    for (const ei of ins) {
      for (const eo of outs) {
        if (eo.segId === ei.segId) continue; // kein Wenden
        for (const cls of ['car', 'bike', 'tram'] as LaneClass[]) {
          const li = ei.lanes.filter((l) => l.cls === cls), lo = eo.lanes.filter((l) => l.cls === cls);
          if (!li.length || !lo.length) continue;
          li.forEach((l, i) => {
            const j = Math.min(lo.length - 1, Math.round((i * (lo.length - 1)) / Math.max(1, li.length - 1)));
            const p0 = l.shape[l.shape.length - 1], p1 = lo[j].shape[0];
            conns.push({ from: ei.id, fromLane: l.index, to: eo.id, toLane: lo[j].index, pts: [p0, p1], explicit: false });
          });
        }
      }
    }
  }
  return { nodes, edges, conns, toLocal: proj.fwd, toLngLat: proj.inv };
}

export { nodeKey };
