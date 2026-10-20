/**
 * Verkehrssimulation (mikroskopisch): Fahrzeuge folgen Spuren und Spurverbindungen,
 * Fahrverhalten nach dem Intelligent Driver Model (IDM). Knoten regeln Ampeln
 * (zwei Phasen), Vorfahrt, Stopp und gegenseitigen Ausschluss in der Kreuzung.
 */
import type { Vec } from './geometry';
import type { EdgeDef, LaneClass, LaneDef, Network, NodeDef } from './network';

export type VehicleKind = 'car' | 'van' | 'truck' | 'bus' | 'bike' | 'tram';

/** Strecke, auf der ein Fahrzeug fährt: eine Spur oder eine Verbindung durch den Knoten */
interface Track {
  id: string;
  pts: Vec[];
  cum: number[];
  length: number;
  /** Spur: nach dieser Bogenlänge geht es in die Verbindung (je Verbindung verschieden) */
  lane?: { edge: EdgeDef; lane: LaneDef; outs: Exit[]; conns?: Track[] };
  /** Verbindung durch einen Knoten */
  conn?: { node: NodeDef; from: EdgeDef; to: Track; entryS: number; turn: 'left' | 'straight' | 'right'; ringIn?: number };
  vehicles: Vehicle[];
  /** Verbindungen, die auf diese Spur führen (> 1 = Einfädelpunkt) */
  feeders?: Track[];
  /** Konfliktpunkte mit kreuzenden Fahrwegen im selben Knoten (Bogenlänge hier / dort) */
  conflicts?: { other: Track; mine: number; theirs: number }[];
}

interface Exit {
  conn: Track;
  /** Bogenlänge auf der Spur, an der die Verbindung beginnt (Kreuzungsrand) */
  at: number;
  /** Bogenlänge der Haltlinie (vor der Querung, ≤ at) */
  stop: number;
}

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  len: number;
  track: Track;
  s: number;
  v: number;
  /** gewählte Ausfahrt der aktuellen Spur */
  exit: Exit | null;
  v0: number;
  a: number;
  T: number;
  s0: number;
  born: number;
  /** an Stopp-Regel bereits angehalten */
  stopped: boolean;
  /** wartet seit (s) an der Haltelinie */
  waitFrom: number | null;
  /** zurückgelegter Weg der Front (älteste zuerst) — das Heck folgt genau dieser Spur */
  trail: Vec[];
  /** Ausfahrt, für die die Haltlinie mit Freigabe überfahren wurde */
  cleared: Exit | null;
  /** schon gewählte Ausfahrt der nächsten Spur (hinter einem Übergang mit vorgezogener Haltlinie) */
  nextExit: Exit | null;
}

export interface SimStats {
  time: number;
  vehicles: number;
  arrived: number;
  meanSpeed: number;
  meanTravel: number;
}

const B = 2.5;
const LOOK = 80;

function track(id: string, pts: Vec[]): Track {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { id, pts, cum, length: cum[cum.length - 1], vehicles: [] };
}

/** Punkt und Richtung bei Bogenlänge s */
export function pose(t: { pts: Vec[]; cum: number[]; length: number }, s: number): { p: Vec; h: Vec } {
  // entartete Strecke (ein Punkt): fester Ort, Richtung beliebig
  if (t.pts.length < 2) return { p: t.pts[0] ?? [0, 0], h: [1, 0] };
  const x = Math.max(0, Math.min(t.length, s));
  let i = 1;
  while (i < t.cum.length - 1 && t.cum[i] < x) i++;
  const a = t.pts[i - 1], b = t.pts[i];
  const l = t.cum[i] - t.cum[i - 1] || 1;
  const u = (x - t.cum[i - 1]) / l;
  return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], h: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] };
}

/** Bogenlänge des Punkts auf einer Polylinie, der q am nächsten liegt */
/** wie project, aber vor dem Anfang liegende Punkte ergeben negative Werte */
function projectExt(t: Track, q: Vec): number {
  const s = project(t, q);
  if (s > 0.01 || t.pts.length < 2) return s;
  const [a, b] = t.pts;
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return Math.min(0, ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / l);
}

function project(t: Track, q: Vec): number {
  let best = 0, bd = Infinity;
  for (let i = 1; i < t.pts.length; i++) {
    const a = t.pts[i - 1], b = t.pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2));
    const d = Math.hypot(a[0] + dx * u - q[0], a[1] + dy * u - q[1]);
    if (d < bd) [bd, best] = [d, t.cum[i - 1] + u * Math.sqrt(l2)];
  }
  return best;
}

const heading = (pts: Vec[], atEnd: boolean): number => {
  const [a, b] = atEnd ? [pts[pts.length - 2], pts[pts.length - 1]] : [pts[0], pts[1]];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
};
const turnOf = (h0: number, h1: number): 'left' | 'straight' | 'right' => {
  let d = h1 - h0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d) < Math.PI / 5 ? 'straight' : d > 0 ? 'left' : 'right';
};

const PARAMS: Record<VehicleKind, { len: number; a: number; T: number; s0: number; vmax: number }> = {
  car: { len: 4.5, a: 1.6, T: 1.2, s0: 2, vmax: 99 },
  van: { len: 5.5, a: 1.3, T: 1.3, s0: 2, vmax: 99 },
  truck: { len: 10, a: 0.9, T: 1.6, s0: 2.5, vmax: 22 },
  bus: { len: 12, a: 1.0, T: 1.5, s0: 2.5, vmax: 15 },
  bike: { len: 1.8, a: 1.0, T: 1.0, s0: 1, vmax: 5.5 },
  tram: { len: 30, a: 1.0, T: 2.0, s0: 3, vmax: 14 },
};

export class Simulation {
  time = 0;
  vehicles: Vehicle[] = [];
  /** Fahrzeuge je Stunde und Zufahrtsspur (Kfz); Rad und Bahn anteilig */
  flow = 400;
  private tracks: Track[] = [];
  private spawns: { lane: Track; cls: LaneClass; bus: boolean; next: number }[] = [];
  private signals = new Map<string, { groups: Map<string, 0 | 1>; offset: number }>();
  private nextId = 1;
  private arrived = 0;
  private travel = 0;
  private rnd = mulberry(7);
  /** Fahrzeuge auf der Kreisfahrbahn je Knoten, mit Winkel (je Schritt neu) */
  private onRing = new Map<string, { v: Vehicle; a: number }[]>();
  private connsByNode = new Map<string, Track[]>();
  /** Vorrang nach langer Wartezeit: Einfädelpunkt (m:Spur) bzw. Knoten (n:Knoten) */
  private holds = new Map<string, { by: string; until: number; since: number }>();
  /** letzte Bewegung eines Fahrzeugs im Knoten (Erkennung gegenseitiger Blockaden) */
  private nodeMoved = new Map<string, number>();

  constructor(public net: Network) {
    this.build();
  }

  // ---- Aufbau ----------------------------------------------------------------

  private build() {
    const laneTrack = new Map<string, Track>();
    for (const e of this.net.edges) {
      for (const l of e.lanes) {
        // Gehwege nicht; entartete Stücke ohne Länge (z. B. zwei Knoten übereinander) überspringen
        if (l.cls === 'ped' || l.shape.length < 2 || l.length < 0.2) continue;
        const t = track(`${e.id}_${l.index}`, l.shape);
        t.lane = { edge: e, lane: l, outs: [] };
        laneTrack.set(t.id, t);
        this.tracks.push(t);
      }
    }
    const nodeById = new Map([...this.net.nodes.values()].map((n) => [n.id, n]));
    const edgeById = new Map(this.net.edges.map((e) => [e.id, e]));
    for (const c of this.net.conns) {
      const from = laneTrack.get(`${c.from}_${c.fromLane}`), to = laneTrack.get(`${c.to}_${c.toLane}`);
      const eFrom = edgeById.get(c.from);
      if (!from || !to || !eFrom || !c.pts || c.pts.length < 2) continue;
      const at = c.explicit ? projectExt(from, c.pts[0]) : from.length;
      const entryS = c.explicit ? project(to, c.pts[c.pts.length - 1]) : 0;
      // Verbindungsweg: vom Haltepunkt bis zum Einfädelpunkt
      // Fahrweg beginnt am Kreuzungsrand — liegt der vor dem Spuranfang, auf der Spur davor
      const start = at < 0 && c.explicit ? c.pts[0] : pose(from, at).p;
      const pts = c.explicit ? [start, ...c.pts.slice(1, -1), pose(to, entryS).p] : [start, pose(to, entryS).p];
      const ct = track(`${c.from}>${c.to}:${c.fromLane}>${c.toLane}`, pts.length >= 2 ? pts : [pts[0], pts[0]]);
      const node = nodeById.get(eFrom.to)!;
      ct.conn = { node, from: eFrom, to, entryS, turn: turnOf(heading(from.pts, true), heading(to.pts, false)) };
      // Kreisverkehr: Winkel, an dem der Fahrweg auf die Kreisfahrbahn trifft
      if (node.ring && c.explicit && c.pts.length > 2) ct.conn.ringIn = Math.atan2(c.pts[1][1] - node.pos[1], c.pts[1][0] - node.pos[0]);
      // Haltlinie darf vor dem Spuranfang liegen (kurzer Arm hinter einem Übergang): dann negativ
      const stop = c.stop ? Math.min(at, projectExt(from, c.stop)) : at;
      from.lane!.outs.push({ conn: ct, at, stop: at - stop < 15 ? stop : at });
      (to.feeders ??= []).push(ct);
      (from.lane!.conns ??= []).push(ct);
      this.tracks.push(ct);
    }
    this.findConflicts();
    // Zufahrten am Netzrand
    for (const t of laneTrack.values()) {
      const node = nodeById.get(t.lane!.edge.from);
      if (node?.kind !== 'end') continue;
      this.spawns.push({ lane: t, cls: t.lane!.lane.cls, bus: t.lane!.lane.type === 'bus', next: this.rnd() * 5 });
    }
    // Ampeln: Zufahrten nach Richtung in zwei Phasen
    for (const n of this.net.nodes.values()) {
      if (n.control !== 'signals' || n.junctionKind !== 'cross') continue;
      const ins = this.net.edges.filter((e) => e.to === n.id && e.lanes.length);
      if (!ins.length) continue;
      const ref = heading(ins[0].lanes[0].shape, true);
      const groups = new Map<string, 0 | 1>();
      for (const e of ins) {
        let d = Math.abs(heading(e.lanes[0].shape, true) - ref) % Math.PI;
        if (d > Math.PI / 2) d = Math.PI - d;
        groups.set(e.id, d < Math.PI / 4 ? 0 : 1);
      }
      this.signals.set(n.id, { groups, offset: this.rnd() * 60 });
    }
  }

  /** Signalbild für eine Zufahrt: 'green' | 'amber' | 'red' (Umlauf 60 s, zwei Phasen) */
  signalFor(nodeId: string, edgeId: string): 'green' | 'amber' | 'red' | null {
    const sig = this.signals.get(nodeId);
    if (!sig) return null;
    const g = sig.groups.get(edgeId);
    if (g === undefined) return null;
    const t = (this.time + sig.offset) % 60; // 0–25 grün A, 25–28 gelb A, 28–30 rot, 30–55 grün B, 55–58 gelb B
    const local = g === 0 ? t : (t + 30) % 60;
    return local < 25 ? 'green' : local < 28 ? 'amber' : 'red';
  }

  /** Haltepunkte der Ampeln (für die Anzeige) */
  signalHeads(): { pos: Vec; h: Vec; state: 'green' | 'amber' | 'red' }[] {
    const out: { pos: Vec; h: Vec; state: 'green' | 'amber' | 'red' }[] = [];
    for (const t of this.tracks) {
      if (!t.lane || !t.lane.outs.length) continue;
      const node = this.net.edges.find((e) => e.id === t.lane!.edge.id)!.to;
      const state = this.signalFor(node, t.lane.edge.id);
      if (!state) continue;
      const at = Math.min(...t.lane.outs.map((o) => o.stop));
      const { p: p0, h } = pose(t, Math.max(0, at));
      const p: Vec = at < 0 ? [p0[0] + h[0] * at, p0[1] + h[1] * at] : p0;
      out.push({ pos: p, h, state });
    }
    return out;
  }

  // ---- Schritt -----------------------------------------------------------------

  step(dt: number) {
    this.time += dt;
    this.spawn(dt);
    this.updateRing();
    // Beschleunigungen zuerst für alle berechnen, dann gemeinsam bewegen
    const acc = this.vehicles.map((v) => this.accel(v));
    this.vehicles.forEach((v, i) => {
      v.v = Math.max(0, v.v + acc[i] * dt);
      v.s += v.v * dt;
      if (v.v < 0.3) v.stopped = true;
    });
    for (const v of this.vehicles.slice()) this.advance(v);
    for (const t of this.tracks) t.vehicles.sort((a, b) => a.s - b.s);
    for (const v of this.vehicles) {
      this.record(v);
      const n = v.track.conn?.node;
      if (n && v.v > 0.3) this.nodeMoved.set(n.id, this.time);
    }
  }

  /** Weg der Front mitschreiben (alle 0,4 m), nur so lang wie das Fahrzeug */
  private record(v: Vehicle) {
    const p = pose(v.track, v.s).p;
    const tr = v.trail;
    const last = tr[tr.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.4) return;
    tr.push(p);
    let total = 0;
    for (let i = tr.length - 1; i > 0; i--) {
      total += Math.hypot(tr[i][0] - tr[i - 1][0], tr[i][1] - tr[i - 1][1]);
      if (total > v.len + 2) {
        tr.splice(0, i - 1);
        break;
      }
    }
  }

  /** Punkt auf dem gefahrenen Weg, d Meter hinter der Front */
  pointBehind(v: Vehicle, d: number): Vec {
    const front = pose(v.track, v.s);
    let prev = front.p;
    let dir: Vec = front.h;
    for (let i = v.trail.length - 1; i >= 0; i--) {
      const q = v.trail[i];
      const seg = Math.hypot(prev[0] - q[0], prev[1] - q[1]);
      if (seg < 1e-6) continue;
      if (seg >= d) return [prev[0] + ((q[0] - prev[0]) * d) / seg, prev[1] + ((q[1] - prev[1]) * d) / seg];
      dir = [(prev[0] - q[0]) / seg, (prev[1] - q[1]) / seg];
      d -= seg;
      prev = q;
    }
    // gerade erst eingesetzt: Heck in Verlängerung nach hinten
    return [prev[0] - dir[0] * d, prev[1] - dir[1] * d];
  }

  private spawn(dt: number) {
    for (const sp of this.spawns) {
      sp.next -= dt;
      if (sp.next > 0) continue;
      const rate = (sp.cls === 'car' ? this.flow : sp.cls === 'bike' ? this.flow * 0.3 : 12) / 3600;
      sp.next = -Math.log(1 - this.rnd()) / Math.max(rate, 1e-6);
      const first = sp.lane.vehicles[0];
      if (first && first.s - first.len < 10) continue; // Einfahrt belegt
      const r = this.rnd();
      const kind: VehicleKind =
        sp.cls === 'bike' ? 'bike' : sp.cls === 'tram' ? 'tram' : sp.bus ? 'bus' : r < 0.06 ? 'truck' : r < 0.16 ? 'van' : r < 0.2 ? 'bus' : 'car';
      const p = PARAMS[kind];
      const e = sp.lane.lane!.edge;
      const v0 = Math.min(p.vmax, e.speed) * (0.9 + this.rnd() * 0.2);
      const v: Vehicle = { id: this.nextId++, kind, len: p.len, track: sp.lane, s: 0, v: v0 * 0.7, exit: null, v0, a: p.a, T: p.T, s0: p.s0, born: this.time, stopped: false, waitFrom: null, trail: [], cleared: null, nextExit: null };
      v.exit = this.chooseExit(sp.lane);
      sp.lane.vehicles.unshift(v);
      this.vehicles.push(v);
    }
  }

  private chooseExit(t: Track): Exit | null {
    const outs = t.lane?.outs ?? [];
    return outs.length ? outs[Math.floor(this.rnd() * outs.length)] : null;
  }

  /** IDM-Beschleunigung mit Blick auf Vorderfahrzeug, Haltelinie und nächste Strecke */
  private accel(v: Vehicle): number {
    let v0 = v.v0;
    const t = v.track;
    const ring = t.conn?.node.ring;
    if (ring) v0 = Math.min(v0, Math.max(4, Math.sqrt(2.5 * ring)));
    else if (t.conn && t.conn.turn !== 'straight') v0 = Math.min(v0, v.kind === 'bike' ? 4 : 6);
    let gap = Infinity, dv = 0;

    const idx = t.vehicles.indexOf(v);
    const ahead = t.vehicles[idx + 1];
    if (ahead) {
      gap = ahead.s - ahead.len - v.s;
      dv = v.v - ahead.v;
    }
    // Haltlinie: gilt auch, wenn das Vorderfahrzeug schon darüber ist
    let blocked = false;
    const ex = t.lane ? v.exit : null;
    if (ex && v.cleared !== ex && (!ahead || ahead.s - ahead.len > ex.stop)) {
      const restStop = ex.stop - v.s;
      if (restStop < LOOK) {
        const why = this.blockedBy(v, ex.conn, restStop);
        if (why) {
          this.noteWait(v, ex.conn, why);
          blocked = true;
          const g = Math.max(0.1, restStop - 0.5);
          if (g < gap) [gap, dv] = [g, v.v];
        } else if (restStop < 0.5) v.cleared = ex;
      }
    }
    // vorgezogene Haltlinie der nächsten Spur (liegt noch auf dieser Spur, vor einem Übergang)
    const up = !blocked && !ahead ? this.upstreamStop(v) : null;
    if (up && v.cleared !== up.exit) {
      const why = this.blockedBy(v, up.exit.conn, up.rest);
      if (why) {
        this.noteWait(v, up.exit.conn, why);
        blocked = true;
        const g = Math.max(0.1, up.rest - 0.5);
        if (g < gap) [gap, dv] = [g, v.v];
      } else if (up.rest < 0.5) v.cleared = up.exit;
    }
    // auch der Kreuzungsrand kann noch vor dem Übergang liegen: dort nur Platz prüfen
    if (up && v.cleared === up.exit) {
      const restAt = up.rest + up.exit.at - up.exit.stop;
      const why = restAt < LOOK ? this.blockedBy(v, up.exit.conn, restAt, true) : null;
      if (why) {
        this.noteWait(v, up.exit.conn, why);
        blocked = true;
        const g = Math.max(0.1, restAt - 0.5);
        if (g < gap) [gap, dv] = [g, v.v];
      }
    }
    // nach der Haltlinie: am Kreuzungsrand nur noch prüfen, ob dahinter Platz ist
    if (ex && v.cleared === ex && !ahead) {
      const restAt = ex.at - v.s;
      const why = this.blockedBy(v, ex.conn, restAt, true);
      if (why) {
        this.noteWait(v, ex.conn, why);
        blocked = true;
        const g = Math.max(0.1, restAt - 0.5);
        if (g < gap) [gap, dv] = [g, v.v];
      }
    }
    // Vorausschau auf Fahrzeuge der nächsten Strecken — immer, auch wenn eine Haltlinie bremst
    const follow = (g: number, x: Vehicle) => {
      if (g < gap) [gap, dv] = [g, v.v - x.v];
    };
    if (!ahead) {
      const end = t.lane ? (v.exit ? v.exit.at : t.length) : t.length;
      const rest = end - v.s;
      if (rest < LOOK) {
        {
          const next = t.lane ? v.exit?.conn : t.conn?.to;
          const entry = t.lane ? 0 : t.conn!.entryS;
          let lead = next?.vehicles.find((x) => x.s >= entry - 1);
          // gerade erst abgebogene Fahrzeuge derselben Spur auf anderen Fahrwegen
          if (t.lane && v.exit)
            for (const o of t.lane.outs) {
              const x = o.conn.vehicles[0];
              if (x && x.s < 12 && Math.abs(o.at - v.exit.at) < 2 && (!lead || x.s < lead.s)) lead = x;
            }
          if (lead) follow(rest + (lead.s - entry) - lead.len, lead);
          else {
            // weiter vorausschauen: kurze Übergänge und Fahrwege bis zur nächsten Spur
            let cur = next, from = entry, dist = rest;
            for (let hop = 0; cur && dist < LOOK && hop < 4; hop++) {
              const x = hop ? cur.vehicles.find((y) => y.s >= from - 1) : null;
              if (x) {
                follow(dist + x.s - from - x.len, x);
                break;
              }
              if (cur.lane) {
                // Spur leer: Heck eines Fahrzeugs, das schon in den nächsten Knoten eingefahren ist
                const tail = this.tailBack(cur);
                if (tail) follow(dist + tail.pos - from, tail.v);
                break;
              }
              dist += cur.length - from;
              from = cur.conn!.entryS;
              cur = cur.conn!.to;
            }
          }
        }
      }
    }
    // Reißverschluss: Fahrwege, die auf dieselbe Spur führen — dem Fahrzeug folgen, das näher am
    // Zusammenführungspunkt ist; gilt schon auf der Zufahrt, nicht erst auf dem Fahrweg
    const myConn = t.conn ? t : t.lane && v.exit ? v.exit.conn : null;
    if (myConn) {
      const mine = t.conn ? t.length - v.s : v.exit!.at - v.s + myConn.length;
      if (mine < LOOK)
        for (const f of myConn.conn!.to.feeders ?? []) {
          if (f === myConn) continue;
          const consider = (x: Vehicle, theirs: number) => {
            const ahead = theirs < mine || (theirs === mine && x.id < v.id);
            if (!ahead || mine - theirs > 40 || mine - theirs - x.len >= gap) return;
            gap = mine - theirs - x.len;
            dv = v.v - x.v;
          };
          for (const x of f.vehicles) consider(x, f.length - x.s);
          // Fahrzeuge noch auf der Zufahrt nur bei Fahrstreifen-Zusammenführung (Übergang);
          // an Kreuzungen und Kreiseln warten sie ohnehin, bis Einfädeln frei ist
          if (f.conn!.node.kind === 'pass')
          for (const lane of this.lanesInto(f))
            for (const x of lane.vehicles) if (x.exit?.conn === f) consider(x, x.exit.at - x.s + f.length);
        }
    }
    // Kreisfahrbahn: Abstand zum vorausfahrenden Fahrzeug auf dem Ring (auch auf anderen Fahrwegen)
    if (ring) {
      const list = this.onRing.get(t.conn!.node.id) ?? [];
      const me = list.find((x) => x.v === v);
      if (me) {
        let best = Infinity, lv: Vehicle | null = null;
        for (const o of list) {
          if (o.v === v) continue;
          const d = ccw(me.a, o.a) * ring;
          if (d > 0.1 && d < best) [best, lv] = [d, o.v];
        }
        if (lv && best - lv.len < gap) {
          gap = best - lv.len;
          dv = v.v - lv.v;
        }
      }
    }
    const sStar = v.s0 + Math.max(0, v.v * v.T + (v.v * dv) / (2 * Math.sqrt(v.a * B)));
    const free = 1 - Math.pow(v.v / Math.max(v0, 0.1), 4);
    const inter = Number.isFinite(gap) ? Math.pow(sStar / Math.max(gap, 0.1), 2) : 0;
    return Math.max(-9, v.a * (free - inter));
  }

  /** Einfädeln: Zielspur am Einfädelpunkt frei und niemand sonst gerade dorthin unterwegs? */
  private mergeFree(v: Vehicle, conn: Track): boolean {
    const target = conn.conn!.to;
    if ((target.feeders?.length ?? 0) < 2) return true;
    const entry = conn.conn!.entryS;
    if (target.vehicles.some((x) => x.s > entry - 6 && x.s - x.len < entry + v.len + 2)) return false;
    // wer lange gewartet hat, hat gerade Vorrang
    const hold = this.holds.get('m:' + target.id);
    if (hold && hold.by !== conn.id && this.time < hold.until) return false;
    // Zeitlücke: andere Fahrzeuge erreichen den Einfädelpunkt erst, wenn ich schon drin bin
    const tMe = Math.sqrt((2 * conn.length) / v.a) + 1.5;
    for (const f of target.feeders!) {
      if (f === conn) continue;
      for (const x of f.vehicles) if ((f.length - x.s) / Math.max(x.v, 2) < tMe) return false;
    }
    return true;
  }

  /** An der Haltelinie wartend: nach längerer Wartezeit Vorrang reservieren (gegen Verhungern) */
  private noteWait(v: Vehicle, conn: Track, why: string) {
    v.waitFrom ??= this.time;
    if (this.time - v.waitFrom < 8) return;
    const c = conn.conn!;
    const key = why === 'merge' ? 'm:' + c.to.id : why === 'busy' ? 'n:' + c.node.id : null;
    if (!key) return;
    const h = this.holds.get(key);
    // wer deutlich länger wartet, übernimmt den Vorrang
    if (h && this.time < h.until && !(v.waitFrom < h.since - 5)) return;
    this.holds.set(key, { by: why === 'merge' ? conn.id : c.from.id, until: this.time + 6, since: v.waitFrom });
  }

  /** Haltlinie der Spur hinter einem Übergang, die noch auf der aktuellen Spur liegt */
  private upstreamStop(v: Vehicle): { exit: Exit; rest: number } | null {
    const t = v.track;
    // auf der Spur vor einem Übergang oder auf dem Übergangsstück selbst:
    // die Haltlinie der nächsten Spur rechtzeitig kennen (kurze Stücke!)
    const passConn = t.lane ? v.exit?.conn : t;
    const c = passConn?.conn;
    if (!passConn || !c || c.node.kind !== 'pass') return null;
    v.nextExit ??= this.chooseExit(c.to);
    const ne = v.nextExit;
    if (!ne) return null;
    const toConnEnd = t.lane ? v.exit!.at - v.s + passConn.length : passConn.length - v.s;
    const rest = toConnEnd + ne.stop - c.entryS;
    return rest < LOOK ? { exit: ne, rest } : null;
  }

  /** Lage (auf der Spur) des hintersten Hecks, das aus einem Fahrweg am Spurende noch zurückragt */
  private tailBack(lane: Track): { pos: number; v: Vehicle } | null {
    let best: { pos: number; v: Vehicle } | null = null;
    for (const o of lane.lane?.outs ?? []) {
      const x = o.conn.vehicles[0];
      if (!x || x.s - x.len >= 0) continue;
      const pos = o.at + x.s - x.len;
      if (!best || pos < best.pos) best = { pos, v: x };
    }
    return best;
  }

  /** Platz auf der Zielspur hinter dem Knoten (inkl. Fahrzeugen, die schon dorthin unterwegs sind) */
  private roomAfter(v: Vehicle, conn: Track): boolean {
    const target = conn.conn!.to;
    const entry = conn.conn!.entryS;
    let need = v.len + 3;
    for (const f of target.feeders ?? []) for (const x of f.vehicles) need += x.len + 2;
    const last = target.vehicles.find((x) => x.s >= entry - 1);
    if (!last) {
      // Heck eines Fahrzeugs, das die Spur gerade in den nächsten Knoten verlässt
      const tail = this.tailBack(target);
      if (tail) return tail.pos - entry > Math.min(need, Math.max(1, target.length - entry - 1));
      // freie Strecke, auch über Übergänge (nur zwei Straßen) hinweg
      let free = target.length - entry, cur = target;
      for (let hop = 0; free < need && hop < 3; hop++) {
        const o = cur.lane?.outs[0];
        if (!o || o.conn.conn!.node.kind !== 'pass') break;
        const c = o.conn.conn!;
        free += o.conn.length;
        const first = c.to.vehicles.find((x) => x.s >= c.entryS);
        if (first) {
          free += first.s - first.len - c.entryS;
          break;
        }
        free += c.to.length - c.entryS;
        cur = c.to;
      }
      return free > Math.min(need, 8);
    }
    return last.s - last.len - entry >= Math.min(need, target.length - entry - 1);
  }

  /** Fahrzeuge auf der Kreisfahrbahn mit ihrem Winkel erfassen */
  private updateRing() {
    this.onRing.clear();
    for (const v of this.vehicles) {
      const n = v.track.conn?.node;
      if (!n?.ring) continue;
      const p = pose(v.track, v.s).p;
      if (Math.abs(Math.hypot(p[0] - n.pos[0], p[1] - n.pos[1]) - n.ring) > 1.5) continue;
      let list = this.onRing.get(n.id);
      if (!list) this.onRing.set(n.id, (list = []));
      list.push({ v, a: Math.atan2(p[1] - n.pos[1], p[0] - n.pos[0]) });
    }
  }

  /** Kreisverkehr: einfahren, wenn auf dem Ring von links niemand naht und die Einfahrt frei ist */
  private ringFree(v: Vehicle, conn: Track): boolean {
    const c = conn.conn!;
    const R = c.node.ring!;
    if (c.ringIn === undefined) return true;
    // Fahrzeuge anderer Zufahrten, die gerade einfahren, aber noch nicht auf dem Ring sind
    // (nur Zufahrten kurz vor meiner, deren Fahrzeuge gleich vor mir auf dem Ring sind)
    for (const t of this.nodeConns(c.node.id)) {
      const theirs = t.conn!.ringIn;
      if (t.conn!.from.id === c.from.id || theirs === undefined || ccw(theirs, c.ringIn) * R > 25) continue;
      if (t.vehicles.some((x) => x.s < 6)) return false;
    }
    for (const o of this.onRing.get(c.node.id) ?? []) {
      if (o.v === v) continue;
      const before = ccw(o.a, c.ringIn) * R; // Strecke, bis es die Einfahrt erreicht
      const after = ccw(c.ringIn, o.a) * R; // schon an der Einfahrt vorbei
      // nach langer Wartezeit genügt eine kürzere Lücke (ungeduldige Fahrer)
      const impatient = v.waitFrom !== null && this.time - v.waitFrom > 30;
      if (before < (impatient ? 7 : Math.max(10, o.v.v * 2.5 + 5)) || after < o.v.len + 2) return false;
    }
    return true;
  }

  private nodeConns(id: string): Track[] {
    let l = this.connsByNode.get(id);
    if (!l) this.connsByNode.set(id, (l = this.tracks.filter((t) => t.conn?.node.id === id)));
    return l;
  }

  /** Darf das Fahrzeug jetzt in die Kreuzung einfahren? */
  private mayEnter(v: Vehicle, conn: Track, rest: number): boolean {
    return this.blockedBy(v, conn, rest) === null;
  }

  /** Grund, warum das Fahrzeug nicht einfahren darf (null = frei) – auch für die Fehlersuche */
  blockedBy(v: Vehicle, conn: Track, rest: number, spaceOnly = false): string | null {
    const c = conn.conn!;
    const node = c.node;
    if (node.ring && node.kind === 'junction') return this.ringFree(v, conn) ? null : 'ring';
    if (!this.mergeFree(v, conn)) return 'merge';
    // Kreuzung nicht blockieren: nur einfahren, wenn hinter dem Knoten Platz ist
    if (node.kind === 'junction' && !this.roomAfter(v, conn)) return 'room';
    if (node.kind !== 'junction') return null;
    const signal = this.signalFor(node.id, c.from.id);
    // hinter der Haltlinie zählen nur noch Platz und kreuzender Verkehr (Ampel und Vorfahrt sind geklärt)
    if (spaceOnly) return this.conflictBusy(conn) ? 'busy' : null;
    if (signal) {
      if (signal === 'red') return 'red';
      // Linksabbieger, die bei Grün auf eine Lücke gewartet haben, räumen bei Gelb die Kreuzung
      if (signal === 'amber' && c.turn === 'left' && v.waitFrom !== null && rest < 4) return this.conflictBusy(conn) ? 'busy' : null;
      // bei Gelb nur weiter, wenn Anhalten nicht mehr möglich
      if (signal === 'amber' && rest > (v.v * v.v) / (2 * B) + 1) return 'amber';
      // Linksabbieger lassen den Gegenverkehr durch (im Knoten und gleich ankommend)
      if (c.turn === 'left' && this.oncomingSoon(conn)) return 'oncoming';
      return this.conflictBusy(conn) ? 'busy' : null;
    }
    // Stopp: erst anhalten
    if ((node.control === 'allstop' || node.control === 'priority') && !v.stopped && rest > 3) return null; // noch nicht an der Linie
    if (node.control === 'allstop' && !v.stopped) return 'stop';
    // sonst: einfahren, wenn kein Fahrzeug auf einem kreuzenden Weg den Konfliktpunkt noch vor sich hat
    const hold = this.holds.get('n:' + node.id);
    if (hold && hold.by !== c.from.id && this.time < hold.until) return 'busy';
    return this.conflictBusy(conn) ? 'busy' : null;
  }

  /**
   * Konfliktpunkte: Stellen, an denen sich zwei Fahrwege im selben Knoten so nahe kommen, dass
   * Fahrzeuge zusammenstoßen würden. Ausgenommen sind Wege von derselben Spur (Folgen) und auf
   * dieselbe Spur (Einfädeln) — die regeln Folgefahrt bzw. Einfädeln.
   */
  private findConflicts() {
    const byNode = new Map<string, Track[]>();
    for (const t of this.tracks) if (t.conn) byNode.set(t.conn.node.id, [...(byNode.get(t.conn.node.id) ?? []), t]);
    const sample = (t: Track) => {
      const out: { p: Vec; s: number }[] = [];
      for (let s = 0; s <= t.length; s += 1) out.push({ p: pose(t, s).p, s });
      return out;
    };
    for (const list of byNode.values()) {
      const samples = new Map(list.map((t) => [t, sample(t)]));
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const X = list[i], Y = list[j];
          if (X.conn!.to === Y.conn!.to) continue;
          const sx = samples.get(X)!, sy = samples.get(Y)!;
          // gleiche Startspur: erst dort, wo sich die Wege wieder treffen (nach dem Auseinanderlaufen)
          const sameStart = Math.hypot(sx[0].p[0] - sy[0].p[0], sx[0].p[1] - sy[0].p[1]) < 0.5;
          let hit: [number, number] | null = null, apart = !sameStart;
          for (const a of sx) {
            for (const b of sy) {
              const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
              if (sameStart && !apart && d > 2.6) apart = true;
              if (apart && d < 2.2) {
                hit = [a.s, b.s];
                break;
              }
            }
            if (hit) break;
          }
          if (!hit) continue;
          (X.conflicts ??= []).push({ other: Y, mine: hit[0], theirs: hit[1] });
          (Y.conflicts ??= []).push({ other: X, mine: hit[1], theirs: hit[0] });
        }
    }
  }

  /** Ein Fahrzeug auf einem kreuzenden Fahrweg hat den Konfliktpunkt noch nicht ganz passiert */
  private conflictBusy(conn: Track): boolean {
    // Stillstand im Knoten seit 10 s: gegenseitige Blockade — dann nicht mehr warten
    if (this.time - (this.nodeMoved.get(conn.conn!.node.id) ?? 0) > 10) return false;
    for (const cf of conn.conflicts ?? []) for (const u of cf.other.vehicles) if (u.s - u.len < cf.theirs + 1) return true;
    return false;
  }

  /** Linksabbieger: bevorrechtigter Verkehr auf kreuzenden Wegen ist gerade unterwegs zur Kreuzung */
  private oncomingSoon(conn: Track): boolean {
    for (const cf of conn.conflicts ?? []) {
      if (cf.other.conn!.turn === 'left') continue;
      for (const lane of this.lanesInto(cf.other))
        for (const u of lane.vehicles) {
          if (u.exit?.conn !== cf.other) continue;
          const dist = u.exit.at - u.s + cf.theirs;
          if (dist > 0 && dist / Math.max(u.v, 1) < 4 && u.v > 1) return true;
        }
    }
    return false;
  }

  private laneOfConn = new Map<Track, Track[]>();
  private lanesInto(conn: Track): Track[] {
    let l = this.laneOfConn.get(conn);
    if (!l) this.laneOfConn.set(conn, (l = this.tracks.filter((t) => t.lane?.conns?.includes(conn))));
    return l;
  }

  /** Strecke wechseln, wenn das Ende erreicht ist */
  private advance(v: Vehicle) {
    for (let guard = 0; guard < 4; guard++) {
      const t = v.track;
      if (t.lane) {
        const end = v.exit ? v.exit.at : t.length;
        if (v.s < end) return;
        if (!v.exit) return this.remove(v, true);
        if (v.cleared === v.exit ? this.blockedBy(v, v.exit.conn, 0, true) : !this.mayEnter(v, v.exit.conn, 0)) {
          // Einfahrt gesperrt: an der Haltelinie stehen bleiben
          v.s = end - 0.01;
          v.v = 0;
          return;
        }
        // Überhang begrenzen: nie über die nächste Haltelinie hinweg schieben (sehr nahe Knoten)
        // (bei vorgezogenem Kreuzungsrand ist der Abstand bauartbedingt und bleibt erhalten)
        const rest = end < 0 ? v.s - end : Math.min(v.s - end, 1);
        this.move(v, v.exit.conn, rest);
        v.stopped = false;
      } else {
        if (v.s < t.length) return;
        const rest = Math.min(v.s - t.length, 1);
        const to = t.conn!.to;
        this.move(v, to, t.conn!.entryS + rest);
        v.exit = v.nextExit ?? this.chooseExit(to);
        v.nextExit = null;
      }
    }
  }

  private move(v: Vehicle, to: Track, s: number) {
    const from = v.track.vehicles;
    from.splice(from.indexOf(v), 1);
    v.track = to;
    v.s = s;
    v.waitFrom = null;
    // Freigabe für eine vorgezogene Haltlinie gilt über den Übergang hinweg
    if (!v.nextExit || v.cleared !== v.nextExit) {
      if (!(to.lane && v.cleared && to.lane.outs.includes(v.cleared))) v.cleared = null;
    }
    // eingefahren: reservierter Vorrang ist eingelöst
    const c = to.conn;
    if (c) {
      const hn = this.holds.get('n:' + c.node.id);
      if (hn?.by === c.from.id) this.holds.delete('n:' + c.node.id);
      const hm = this.holds.get('m:' + c.to.id);
      if (hm?.by === to.id) this.holds.delete('m:' + c.to.id);
    }
    to.vehicles.push(v);
  }

  private remove(v: Vehicle, arrived: boolean) {
    const list = v.track.vehicles;
    list.splice(list.indexOf(v), 1);
    this.vehicles.splice(this.vehicles.indexOf(v), 1);
    if (arrived) {
      this.arrived++;
      this.travel += this.time - v.born;
    }
  }

  /** Lage eines Fahrzeugs (Mitte) und Fahrtrichtung */
  vehiclePose(v: Vehicle): { p: Vec; h: Vec } {
    const front = pose(v.track, v.s);
    const back = this.pointBehind(v, v.len);
    const h: Vec = [front.p[0] - back[0], front.p[1] - back[1]];
    const l = Math.hypot(h[0], h[1]) || 1;
    return { p: [(front.p[0] + back[0]) / 2, (front.p[1] + back[1]) / 2], h: l > 0.2 ? [h[0] / l, h[1] / l] : front.h };
  }

  stats(): SimStats {
    const n = this.vehicles.length;
    return {
      time: this.time,
      vehicles: n,
      arrived: this.arrived,
      meanSpeed: n ? this.vehicles.reduce((s, v) => s + v.v, 0) / n : 0,
      meanTravel: this.arrived ? this.travel / this.arrived : 0,
    };
  }
}

/** Winkel von a bis b gegen den Uhrzeigersinn, 0 … 2π */
function ccw(a: number, b: number): number {
  let d = b - a;
  while (d < 0) d += 2 * Math.PI;
  while (d >= 2 * Math.PI) d -= 2 * Math.PI;
  return d;
}

/** kleiner, reproduzierbarer Zufallsgenerator */
function mulberry(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
