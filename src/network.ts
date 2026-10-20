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
  /** Kreisverkehr: Radius der Mittellinie der Kreisfahrbahn (m) */
  ring?: number;
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
  /** Haltlinie auf der Zufahrtsspur (vor der Querung); fehlt = Beginn des Fahrwegs */
  stop?: Vec;
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
      if (kind === 'junction' && st.kind !== 'cross') n.ring = st.rbRadius - st.rbLane / 2;
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

  // Knoten, an denen nur zwei Straßenstücke zusammentreffen, sind Übergänge — keine Kreuzung
  const degree = new Map<string, number>();
  for (const s of segments) for (const k of [s.start, s.end]) if (k) degree.set(k, (degree.get(k) ?? 0) + 1);
  for (const n of nodes.values()) if (n.kind === 'junction' && (degree.get(n.key) ?? 0) <= 2) n.kind = 'pass';

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
      conns.push({ from: eIn.id, fromLane: li.index, to: eOut.id, toLane: lo.index, pts: link.pts.map(proj.fwd), explicit: true, stop: inL.stop && proj.fwd(inL.stop) });
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
            // Kreisverkehr: Straßenbahn quert die Insel, alle anderen fahren auf der Kreisfahrbahn
            const ring =
              n.junctionKind !== 'cross' && n.kind === 'junction' && cls !== 'tram'
                ? ringPath(n, l.shape, lo[j].shape, project.junctions?.[n.key])
                : null;
            conns.push({ from: ei.id, fromLane: l.index, to: eo.id, toLane: lo[j].index, pts: ring ?? [p0, p1], explicit: !!ring });
          });
        }
      }
    }
  }
  rerootShortArms(edges, nodes, conns);
  return { nodes, edges, conns, toLocal: proj.fwd, toLngLat: proj.inv };
}

/**
 * Kurze Kreuzungsarme: Liegen Haltlinie oder Kreuzungsrand schon vor dem Anfang der Zufahrtsspur
 * (Arm kürzer als der Kreuzungsbereich, davor ein Übergang auf eine andere Straße), beginnen die
 * Fahrwege durch die Kreuzung direkt auf der Spur davor. Das Zwischenstück wird übersprungen.
 */
function rerootShortArms(edges: EdgeDef[], nodes: Map<string, NodeDef>, conns: ConnDef[]) {
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const nodeById = new Map([...nodes.values()].map((n) => [n.id, n]));
  const laneOf = (edge: string, index: number) => edgeById.get(edge)?.lanes.find((l) => l.index === index);
  /** Abstand eines Punkts vor dem Spuranfang (> 0 = liegt davor) */
  const before = (shape: Vec[], q: Vec) => {
    const [a, b] = shape;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return -((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / l;
  };
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const c of conns.slice()) {
      if (!c.explicit || !c.pts) continue;
      const lane = laneOf(c.from, c.fromLane);
      const e = edgeById.get(c.from);
      if (!lane || !e || nodeById.get(e.from)?.kind !== 'pass') continue;
      const earliest = c.stop ?? c.pts[0];
      if (before(lane.shape, earliest) < 0.5) continue;
      // Zubringer über den Übergang auf diese Spur
      const feeders = conns.filter((f) => !f.explicit && f.to === c.from && f.toLane === c.fromLane);
      if (!feeders.length) continue;
      conns.splice(conns.indexOf(c), 1);
      for (const f of feeders) conns.push({ ...c, from: f.from, fromLane: f.fromLane });
      changed = true;
    }
    // Spuren, die keine Weiterfahrt mehr haben (alles umgeleitet), bekommen keinen Zufluss mehr
    for (const f of conns.slice()) {
      if (f.explicit) continue;
      const hasOut = conns.some((c) => c.from === f.to && c.fromLane === f.toLane);
      const endsAtJunction = nodeById.get(edgeById.get(f.to)?.to ?? '')?.kind === 'junction';
      if (!hasOut && endsAtJunction) {
        conns.splice(conns.indexOf(f), 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/**
 * Fahrweg im Kreisverkehr: von der Zufahrt auf die Kreisfahrbahn, gegen den Uhrzeigersinn
 * (Rechtsverkehr) bis zur Ausfahrt. Liegt auf der Mitte der Kreisfahrbahn.
 */
function ringPath(n: NodeDef, inShape: Vec[], outShape: Vec[], st?: { rbRadius?: number; rbLane?: number }): Vec[] {
  const def = defaultJunction();
  const outer = st?.rbRadius ?? def.rbRadius;
  const R = outer - (st?.rbLane ?? def.rbLane) / 2;
  const [cx, cy] = n.pos;
  // Spuren laufen bis zur Knotenmitte: Ein- und Ausfahrpunkt am äußeren Rand der Kreisfahrbahn
  const p0 = edgePoint(inShape.slice().reverse(), n.pos, outer + 1.5);
  const p1 = edgePoint(outShape, n.pos, outer + 1.5);
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
  let a1 = Math.atan2(p1[1] - cy, p1[0] - cx);
  while (a1 <= a0 + 0.2) a1 += 2 * Math.PI; // gegen den Uhrzeigersinn, mindestens ein Stück
  const steps = Math.max(4, Math.ceil(((a1 - a0) * R) / 2));
  const arc: Vec[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = a0 + ((a1 - a0) * k) / steps;
    arc.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  return [p0, ...arc, p1];
}

/** Erster Punkt entlang der Linie (vom Knoten weg), der mindestens r von c entfernt ist */
function edgePoint(fromNode: Vec[], c: Vec, r: number): Vec {
  const d = (p: Vec) => Math.hypot(p[0] - c[0], p[1] - c[1]);
  for (let i = 1; i < fromNode.length; i++) {
    const a = fromNode[i - 1], b = fromNode[i];
    if (d(b) < r) continue;
    // auf der Strecke a–b den Übergang suchen
    let lo = 0, hi = 1;
    for (let k = 0; k < 20; k++) {
      const m = (lo + hi) / 2;
      if (d([a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m]) < r) lo = m;
      else hi = m;
    }
    return [a[0] + (b[0] - a[0]) * hi, a[1] + (b[1] - a[1]) * hi];
  }
  return fromNode[fromNode.length - 1];
}

export { nodeKey };
