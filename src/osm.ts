/**
 * Bestand aus OpenStreetMap übernehmen: die Straßen eines Kartenausschnitts mit Fahrstreifen,
 * Abbiegepfeilen, Bus- und Radstreifen, Parken, Gehwegen und Straßenbäumen nachbauen.
 * Reine Umrechnung ohne DOM — der Prüfstand (scripts/osm-test.mjs) nutzt sie direkt.
 */
import { localProjection, type Vec } from './geometry';
import { defaultJunction, makeStrip, reverseProfile, uid, type ArmRole, type Crossing, type JunctionSettings, type LngLat, type Road, type Strip, type Turn } from './model';
import { nodeKey } from './render';

/** west, süd, ost, nord */
export type BBox = [number, number, number, number];
type Tags = Record<string, string>;
interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: Tags }
interface OsmWay { type: 'way'; id: number; nodes: number[]; tags?: Tags }
export interface OsmData { elements: { type: string }[] }

export interface OsmImport {
  roads: Road[];
  junctions: Record<string, JunctionSettings>;
  stats: { roads: number; trees: number; signals: number; roundabouts: number };
}

/** Straßenklassen, die übernommen werden; Rang für Vorfahrt und Kreuzungsradius */
const RANK: Record<string, number> = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1, residential: 1, living_street: 0, pedestrian: 0 };
const CLASSES = [...Object.keys(RANK), 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'];
const LANE_WIDTH: Record<string, number> = { motorway: 3.75, trunk: 3.5, primary: 3.25, secondary: 3.25, tertiary: 3.0, unclassified: 3.0, residential: 2.75, living_street: 2.75 };
const baseClass = (hw: string) => hw.replace(/_link$/, '');

export function overpassQuery([w, s, e, n]: BBox): string {
  const b = `(${s},${w},${n},${e})`;
  return (
    `[out:json][timeout:60];(way["highway"~"^(${CLASSES.join('|')})$"]${b};` +
    `node["natural"="tree"]${b};way["natural"="tree_row"]${b};` +
    `node["highway"~"^(traffic_signals|mini_roundabout|crossing)$"]${b};);out body;>;out skel qt;`
  );
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

/**
 * Daten des Ausschnitts holen — bei Ausfall des Hauptservers vom Spiegel.
 * `onBytes` meldet laufend die empfangene Datenmenge (Overpass nennt vorab keine Größe).
 */
export async function fetchOsm(bbox: BBox, signal?: AbortSignal, onBytes?: (n: number) => void): Promise<OsmData> {
  let last: unknown = new Error('kein Overpass-Server erreichbar');
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(bbox) }), signal });
      if (res.ok) {
        if (!res.body || !onBytes) return await res.json();
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let n = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          onBytes((n += value.length));
        }
        const all = new Uint8Array(n);
        let o = 0;
        for (const c of chunks) all.set(c, (o += c.length) - c.length);
        return JSON.parse(new TextDecoder().decode(all));
      }
      last = new Error(`${new URL(url).host}: HTTP ${res.status}`);
    } catch (e) {
      if (signal?.aborted) throw e;
      last = e;
    }
  }
  throw last;
}

// ---- Querschnitt aus den Tags ------------------------------------------------

const num = (v?: string) => {
  const x = parseFloat((v ?? '').replace(',', '.'));
  return Number.isFinite(x) ? x : undefined;
};
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
type Side = 'left' | 'right';

const isOneway = (t: Tags, hw: string) =>
  ['yes', '1', 'true', '-1'].includes(t.oneway) || t.junction === 'roundabout' || t.junction === 'circular' || ((hw === 'motorway' || hw === 'motorway_link') && t.oneway !== 'no');

/** Fahrstreifen [in Wegrichtung, dagegen] */
function laneCounts(t: Tags, hw: string): [number, number] {
  const n = num(t.lanes), f = num(t['lanes:forward']), b = num(t['lanes:backward']);
  if (isOneway(t, hw)) {
    const k = Math.max(1, Math.round(f ?? b ?? n ?? (baseClass(hw) === 'motorway' || baseClass(hw) === 'trunk' ? 2 : 1)));
    return t.oneway === '-1' ? [0, k] : [k, 0];
  }
  if (f !== undefined && b !== undefined) return [Math.max(1, f), Math.max(1, b)];
  if (n === undefined || n <= 2) return [1, 1];
  const ff = f ?? (b !== undefined ? n - b : Math.ceil(n / 2));
  return [Math.max(1, ff), Math.max(1, n - ff)];
}

/** Abbiegerichtungen einer Spur (OSM: through, left, slight_right;through …) */
export function turnOf(v?: string): Turn | undefined {
  if (!v || v === 'none') return undefined;
  let l = false, s = false, r = false;
  for (const x of v.split(';')) {
    if (x.startsWith('merge')) continue;
    if (x.includes('left')) l = true;
    else if (x.includes('right')) r = true;
    else if (x === 'through') s = true;
  }
  if (l && s && r) return 'all';
  if (l && s) return 'left-straight';
  if (r && s) return 'right-straight';
  if (l && r) return 'left-right';
  return l ? 'left' : r ? 'right' : s ? 'straight' : undefined;
}

/** Liste je Spur in Fahrtrichtung von links nach rechts (`key:forward`, bei Einbahn auch `key`) */
function perLane(t: Tags, key: string, forward: boolean, oneway: boolean, n: number): (string | undefined)[] {
  const raw = t[`${key}:${forward ? 'forward' : 'backward'}`] ?? (oneway && forward === (t.oneway !== '-1') ? t[key] : undefined);
  const list = raw?.split('|');
  return list && list.length === n ? list : Array(n).fill(undefined);
}

function bikeOn(t: Tags, s: Side): 'lane' | 'track' | undefined {
  const general = t.cycleway;
  let v: string | undefined = t[`cycleway:${s}`] ?? t['cycleway:both'];
  if (v === undefined && general) {
    if (general.startsWith('opposite')) v = s === 'left' ? general.replace('opposite_', '') : undefined;
    else v = general;
  }
  if (v === 'lane' || v === 'opposite_lane') return 'lane';
  if (v === 'track' || v === 'opposite_track') return 'track';
  return undefined;
}

/** Parkwinkel je Seite (neues Schema parking:*, altes parking:lane:*), undefined = kein Parken */
function parkingOn(t: Tags, s: Side): 0 | 45 | 90 | undefined {
  const v = t[`parking:${s}`] ?? t['parking:both'];
  if (v !== undefined) {
    if (!['lane', 'street_side', 'half_on_kerb', 'on_kerb', 'shoulder', 'yes'].includes(v)) return undefined;
    const o = t[`parking:${s}:orientation`] ?? t['parking:both:orientation'];
    return o === 'diagonal' ? 45 : o === 'perpendicular' ? 90 : 0;
  }
  const old = t[`parking:lane:${s}`] ?? t['parking:lane:both'];
  if (old === 'diagonal') return 45;
  if (old === 'perpendicular') return 90;
  return old === 'parallel' || old === 'marked' || old === 'yes' ? 0 : undefined;
}

function sidewalkOn(t: Tags, s: Side, hw: string): boolean {
  const per = t[`sidewalk:${s}`] ?? t['sidewalk:both'];
  if (per) return per !== 'no' && per !== 'none';
  const v = t.sidewalk;
  if (v) return v === 'both' || v === 'yes' || v === 'separate' || v === s;
  // nicht erfasst: innerorts üblich, außer an Schnellstraßen, Rampen und verkehrsberuhigten Bereichen
  const base = baseClass(hw);
  if (hw.endsWith('_link') || base === 'motorway' || base === 'trunk' || base === 'living_street') return false;
  // getrennte Richtungsfahrbahn: nur außen (in Fahrtrichtung rechts)
  if (isOneway(t, hw) && RANK[base] >= 2) return s === (t.oneway === '-1' ? 'left' : 'right');
  return true;
}

const PARK_WIDTH = { 0: 2.0, 45: 4.6, 90: 5.0 } as const;

/**
 * Querschnitt in Wegrichtung (links → rechts). `trees` legt Baumstreifen an die Seiten:
 * Fahrbahn | Parken | Bäume | Radweg (Hochbord) | Gehweg.
 */
export function profileFromTags(t: Tags, trees: { left: boolean; right: boolean } = { left: false, right: false }): Strip[] {
  const hw = t.highway;
  if (hw === 'pedestrian') return [makeStrip('sidewalk', clamp(num(t.width) ?? 6, 3, 20))];
  const oneway = isOneway(t, hw);
  const [nf, nb] = laneCounts(t, hw);

  const park = { left: parkingOn(t, 'left'), right: parkingOn(t, 'right') };
  const bike = { left: bikeOn(t, 'left'), right: bikeOn(t, 'right') };
  // Fahrstreifenbreite aus der Fahrbahnbreite, sonst nach Straßenklasse
  let laneW = LANE_WIDTH[baseClass(hw)] ?? 3.0;
  const width = num(t.width) ?? num(t['width:carriageway']);
  if (width && nf + nb > 0) {
    const side = (s: Side) => (park[s] !== undefined && t[`parking:${s}`] !== 'street_side' ? PARK_WIDTH[park[s]!] : 0) + (bike[s] === 'lane' ? 1.85 : 0);
    laneW = clamp((width - side('left') - side('right')) / (nf + nb), 2.5, 3.75);
  }

  const lanes = (forward: boolean, n: number): Strip[] => {
    const turns = perLane(t, 'turn:lanes', forward, oneway, n);
    const bus = perLane(t, 'bus:lanes', forward, oneway, n).map((x, i) => x ?? perLane(t, 'psv:lanes', forward, oneway, n)[i]);
    const list = turns.map((tv, i) => {
      const s = makeStrip(bus[i] === 'designated' ? 'bus' : 'drive', bus[i] === 'designated' ? 3.25 : laneW, forward ? 1 : -1);
      const turn = turnOf(tv);
      if (turn) s.turn = turn;
      return s;
    });
    // in Fahrtrichtung links → rechts; gegen die Wegrichtung liegt das in Zeichenrichtung umgekehrt
    return forward ? list : list.reverse();
  };

  const outer = (s: Side): Strip[] => {
    const dirOf = (): 1 | -1 => {
      if (s === 'right') return 1;
      if (!oneway) return -1;
      const own = t['cycleway:left:oneway'];
      return own === '-1' || t.oneway === '-1' || t['oneway:bicycle'] === 'no' || t.cycleway?.startsWith('opposite') ? -1 : 1;
    };
    const list: Strip[] = [];
    if (bike[s] === 'lane') list.push(makeStrip('bike', clamp(num(t[`cycleway:${s}:width`]) ?? 1.85, 1.25, 3), dirOf()));
    if (park[s] !== undefined) {
      const p = makeStrip('parking', PARK_WIDTH[park[s]!]);
      if (park[s]) p.parkAngle = park[s] as 45 | 90;
      list.push(p);
    }
    if (trees[s]) list.push({ ...makeStrip('green', 2.0), planting: 'trees' });
    if (bike[s] === 'track') {
      if (t[`cycleway:${s}:oneway`] === 'no') list.push(makeStrip('bike', 1.6, -1), makeStrip('bike', 1.6, 1));
      else list.push(makeStrip('bike', clamp(num(t[`cycleway:${s}:width`]) ?? 2.0, 1.25, 3), dirOf()));
    }
    if (sidewalkOn(t, s, hw)) {
      const w = num(t[`sidewalk:${s}:width`] ?? t['sidewalk:both:width'] ?? t['sidewalk:width']);
      list.push(makeStrip('sidewalk', clamp(w ?? 2.5, 1.5, 6)));
    }
    // von der Fahrbahn nach außen aufgebaut; links in Zeichenrichtung also umgekehrt
    return s === 'left' ? list.reverse() : list;
  };

  const back = lanes(false, nb);
  const fwd = lanes(true, nf);
  // Wohnstraßen ohne Markierung: keine Mittellinie zwischen den Richtungen
  const unmarked = t.lane_markings === 'no' || (!t.lanes && ['residential', 'living_street', 'unclassified'].includes(baseClass(hw)));
  if (unmarked && back.length && fwd.length) back[back.length - 1].lineRight = 'none';
  return [...outer('left'), ...back, ...fwd, ...outer('right')];
}

// ---- Umrechnung ---------------------------------------------------------------

interface Piece {
  tags: Tags;
  /** Knoten-IDs (OSM-Zahl, Randpunkt oder Kreisverkehrsmitte als Text) */
  ids: (number | string)[];
  pts: LngLat[];
  profile: Strip[];
}

/** Wie stark sich zwei Querschnitte gleichen müssen, damit Wegstücke zu einer Straße werden */
const signature = (p: Strip[]) => JSON.stringify(p.map((s) => [s.type, s.width.toFixed(2), s.dir, s.turn, s.planting, s.parkAngle, s.lineRight]));

/** Umgrenzendes Rechteck eines Vielecks */
export function bboxOf(ring: LngLat[]): BBox {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Umrechnen. `area` ist das Rechteck oder ein beliebiges Vieleck (Lasso) — Straßen werden an
 * seinem Rand abgeschnitten.
 */
export function osmToRoads(data: OsmData, area: BBox | LngLat[]): OsmImport {
  const ring: LngLat[] =
    typeof area[0] === 'number'
      ? (([w, s, e, n]) => [[w, s], [e, s], [e, n], [w, n]] as LngLat[])(area as BBox)
      : (area as LngLat[]).slice();
  if (ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
  const bbox = bboxOf(ring);
  const nodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const e of data.elements) {
    // Overpass liefert Knoten teils doppelt (mit Tags und als Skelett ohne) — die Tags behalten
    if (e.type === 'node') {
      const n = e as OsmNode;
      if (n.tags || !nodes.has(n.id)) nodes.set(n.id, n);
    } else if (e.type === 'way') ways.push(e as OsmWay);
  }
  const center: LngLat = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const proj = localProjection(center);
  const at = new Map<number | string, LngLat>();
  for (const n of nodes.values()) at.set(n.id, [n.lon, n.lat]);

  const roadWays = ways.filter((w) => {
    const t = w.tags ?? {};
    if (!CLASSES.includes(t.highway) || t.area === 'yes' || t.indoor === 'yes') return false;
    // Fußgängerzonen nur mit Namen — unbenannte „pedestrian“-Wege sind meist Park- und Platzwege
    if (t.highway === 'pedestrian' && !t.name) return false;
    // Tunnel liegen unter der Oberfläche — im Lageplan nicht sichtbar
    if (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') return false;
    return w.nodes.every((id) => at.has(id));
  });

  // ---- Kreisverkehre: Ring zu einem Knoten zusammenziehen ----
  const ringWays = roadWays.filter((w) => w.tags!.junction === 'roundabout' || w.tags!.junction === 'circular');
  const ringOf = new Map<number, string>();
  const junctions: Record<string, JunctionSettings> = {};
  let roundabouts = 0;
  {
    // zusammenhängende Ringstücke gruppieren
    const groups: Set<number>[] = [];
    for (const w of ringWays) {
      const hit = groups.filter((g) => w.nodes.some((id) => g.has(id)));
      const merged = new Set<number>(w.nodes);
      for (const g of hit) for (const id of g) merged.add(id);
      for (const g of hit) groups.splice(groups.indexOf(g), 1);
      groups.push(merged);
    }
    groups.forEach((g, i) => {
      const pts = [...g].map((id) => proj.fwd(at.get(id)!));
      const c: Vec = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
      const r = pts.reduce((s, p) => s + Math.hypot(p[0] - c[0], p[1] - c[1]), 0) / pts.length;
      if (r > 40) return; // großer Platz mit Kreisverkehr: als einzelne Straßen belassen
      const id = `rb${i}`;
      const ll = proj.inv(c);
      at.set(id, ll);
      for (const n of g) ringOf.set(n, id);
      const twoLanes = ringWays.some((w) => w.nodes.some((n) => g.has(n)) && (num(w.tags!.lanes) ?? 1) >= 2);
      const rbLane = twoLanes ? 8.5 : 6.5;
      junctions[nodeKey(ll)] = {
        ...defaultJunction(),
        kind: r < 8 ? 'mini' : 'roundabout',
        control: 'none',
        rbLane,
        rbLanes: twoLanes ? 2 : 1,
        rbRadius: clamp(r + rbLane / 2, 10, 40),
      };
      roundabouts++;
    });
  }

  // ---- Wege auf den Ausschnitt zuschneiden ----
  const inside = ([x, y]: LngLat) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  /** Parameter (0…1, aufsteigend), an denen die Strecke a–b den Rand schneidet */
  const cuts = (a: LngLat, b: LngLat): number[] => {
    const d = [b[0] - a[0], b[1] - a[1]];
    const out: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [c, e] = [ring[j], ring[i]];
      const f = [e[0] - c[0], e[1] - c[1]];
      const den = d[0] * f[1] - d[1] * f[0];
      if (Math.abs(den) < 1e-18) continue;
      const w = [c[0] - a[0], c[1] - a[1]];
      const s = (w[0] * f[1] - w[1] * f[0]) / den, u = (w[0] * d[1] - w[1] * d[0]) / den;
      if (s >= 0 && s <= 1 && u >= 0 && u <= 1) out.push(s);
    }
    return out.sort((x, y) => x - y);
  };
  const lerp = (a: LngLat, b: LngLat, t: number): LngLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  /** Schnittpunkt der Strecke a (innen) – b (außen) mit dem Rand: der erste von a aus */
  const exitPoint = (a: LngLat, b: LngLat): LngLat => lerp(a, b, cuts(a, b)[0] ?? 1);
  let edgeId = 0;
  const raw: { tags: Tags; ids: (number | string)[] }[] = [];
  for (const w of roadWays) {
    if (ringOf.has(w.nodes[0]) && w.nodes.every((n) => ringOf.has(n))) continue; // Ringstück selbst
    let run: (number | string)[] = [];
    const flush = () => {
      if (run.length >= 2) raw.push({ tags: w.tags!, ids: run });
      run = [];
    };
    w.nodes.forEach((id, i) => {
      const p = at.get(id)!;
      const prev = i > 0 ? at.get(w.nodes[i - 1])! : null;
      if (inside(p)) {
        if (prev && !inside(prev)) {
          const eid = `edge${edgeId++}`;
          at.set(eid, exitPoint(p, prev));
          run.push(eid);
        }
        run.push(ringOf.get(id) ?? id);
      } else if (prev && inside(prev)) {
        const eid = `edge${edgeId++}`;
        at.set(eid, exitPoint(prev, p));
        run.push(eid);
        flush();
      } else if (prev) {
        // beide Enden draußen, die Strecke läuft aber quer durch den Bereich
        const c = cuts(prev, p);
        for (let k = 0; k + 1 < c.length; k += 2) {
          const ids = [`edge${edgeId++}`, `edge${edgeId++}`];
          at.set(ids[0], lerp(prev, p, c[k]));
          at.set(ids[1], lerp(prev, p, c[k + 1]));
          raw.push({ tags: w.tags!, ids });
        }
      }
    });
    flush();
  }

  // Zufahrten zum Kreisverkehr: Punkte im Ring entfallen, doppelte Mitte zusammenfassen
  for (const r of raw) {
    r.ids = r.ids.filter((id, i, a) => i === 0 || id !== a[i - 1]);
    const ring = r.ids.find((id) => typeof id === 'string' && id.startsWith('rb')) as string | undefined;
    if (!ring) continue;
    const st = junctions[nodeKey(at.get(ring)!)];
    const c = proj.fwd(at.get(ring)!);
    r.ids = r.ids.filter((id) => id === ring || Math.hypot(...(proj.fwd(at.get(id)!).map((v, k) => v - c[k]) as Vec)) > st.rbRadius + 1);
  }

  // geschlossene Wege (Schleifen) in zwei Hälften teilen — Anfang und Ende wären sonst derselbe Punkt
  const pieces0: { tags: Tags; ids: (number | string)[] }[] = [];
  for (const r of raw) {
    if (r.ids.length < 2) continue;
    if (r.ids[0] === r.ids[r.ids.length - 1] && r.ids.length > 3) {
      const m = Math.floor(r.ids.length / 2);
      pieces0.push({ tags: r.tags, ids: r.ids.slice(0, m + 1) }, { tags: r.tags, ids: r.ids.slice(m) });
    } else pieces0.push(r);
  }

  // ---- Stummel am Rand des Bereichs: unter 20 m zwischen Rand und Knoten zerlegen die Kreuzung ----
  {
    const isEdge = (id: number | string) => typeof id === 'string' && id.startsWith('edge');
    const lenM = (ids: (number | string)[]) => {
      let l = 0;
      for (let i = 1; i < ids.length; i++) {
        const [a, b] = [proj.fwd(at.get(ids[i - 1])!), proj.fwd(at.get(ids[i])!)];
        l += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      return l;
    };
    for (let i = pieces0.length - 1; i >= 0; i--) {
      const ids = pieces0[i].ids;
      if ((isEdge(ids[0]) || isEdge(ids[ids.length - 1])) && lenM(ids) < 20) pieces0.splice(i, 1);
    }
  }

  // ---- versetzte Kreuzungen: Kreuzungsknoten dichter als 8 m zu einem Knoten zusammenführen ----
  // (in OSM treffen sich Straßen oft an zwei Punkten wenige Meter auseinander — zwei Mini-Kreuzungen
  // mit Splittern dazwischen sähen kaputt aus; getrennte Richtungsfahrbahnen liegen weiter auseinander)
  for (let round = 0; round < 20; round++) {
    const arms = new Map<number | string, number>();
    for (const r of pieces0) r.ids.forEach((id, i) => arms.set(id, (arms.get(id) ?? 0) + (i === 0 || i === r.ids.length - 1 ? 1 : 2)));
    const isJunction = (id: number | string) => (arms.get(id) ?? 0) >= 3 && typeof id === 'number';
    let pair: [number | string, number | string] | null = null;
    for (const r of pieces0) {
      for (let i = 1; i < r.ids.length && !pair; i++) {
        const [a, b] = [r.ids[i - 1], r.ids[i]];
        if (a === b || !isJunction(a) || !isJunction(b)) continue;
        const [pa, pb] = [proj.fwd(at.get(a)!), proj.fwd(at.get(b)!)];
        if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) < 8) pair = [a, b];
      }
      if (pair) break;
    }
    if (!pair) break;
    const [a, b] = pair;
    const [pa, pb] = [at.get(a)!, at.get(b)!];
    at.set(a, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]);
    for (const r of pieces0) r.ids = r.ids.map((id) => (id === b ? a : id)).filter((id, i, l) => i === 0 || id !== l[i - 1]);
    for (let i = pieces0.length - 1; i >= 0; i--) if (pieces0[i].ids.length < 2) pieces0.splice(i, 1);
  }

  // ---- Bäume: Einzelbäume und Baumreihen (alle 8 m ein Baum) ----
  const treePts: Vec[] = [];
  for (const n of nodes.values()) if (n.tags?.natural === 'tree') treePts.push(proj.fwd([n.lon, n.lat]));
  for (const w of ways) {
    if (w.tags?.natural !== 'tree_row') continue;
    const pts = w.nodes.filter((id) => at.has(id)).map((id) => proj.fwd(at.get(id)!));
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let s = 0; s < l; s += 8) treePts.push([a[0] + ((b[0] - a[0]) * s) / l, a[1] + ((b[1] - a[1]) * s) / l]);
    }
  }
  const treesBeside = (pts: Vec[], profile: Strip[]) => {
    const cw = profile.filter((s) => ['drive', 'bus', 'bike', 'parking'].includes(s.type)).reduce((s, x) => s + x.width, 0) / 2;
    let len = 0;
    const count = { left: 0, right: 0 };
    const [minX, minY, maxX, maxY] = pts.reduce(([a, b, c, d], p) => [Math.min(a, p[0]), Math.min(b, p[1]), Math.max(c, p[0]), Math.max(d, p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    for (const q of treePts) {
      if (q[0] < minX - 20 || q[0] > maxX + 20 || q[1] < minY - 20 || q[1] > maxY + 20) continue;
      let best: { d: number; off: number } | null = null;
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = [pts[i - 1], pts[i]];
        const d: Vec = [b[0] - a[0], b[1] - a[1]];
        const l = Math.hypot(...d);
        if (l < 0.01) continue;
        const t = ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / (l * l);
        if (t < 0 || t > 1) continue;
        const off = (d[0] * (q[1] - a[1]) - d[1] * (q[0] - a[0])) / l; // > 0 = links
        if (!best || Math.abs(off) < best.d) best = { d: Math.abs(off), off };
      }
      if (best && best.d > cw - 1 && best.d < cw + 8) count[best.off > 0 ? 'left' : 'right']++;
    }
    // mindestens zwei Bäume und einer je 25 m
    const dense = (n: number) => n >= 2 && n * 25 >= len;
    return { left: dense(count.left), right: dense(count.right) };
  };

  let pieces: Piece[] = pieces0.map((r) => {
    const pts = r.ids.map((id) => at.get(id)!);
    const trees = treesBeside(pts.map(proj.fwd), profileFromTags(r.tags));
    return { tags: r.tags, ids: r.ids, pts, profile: profileFromTags(r.tags, trees) };
  });

  // ---- getrennte Richtungsfahrbahnen: Gegenfahrbahn gleichen Namens links daneben → innen kein Gehweg ----
  const local = pieces.map((p) => p.pts.map(proj.fwd));
  pieces.forEach((p, i) => {
    const t = p.tags;
    if (!isOneway(t, t.highway) || !t.name || t.junction) return;
    const pts = local[i];
    const m = Math.floor((pts.length - 1) / 2);
    const [a, b] = [pts[m], pts[m + 1]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 0.1) return;
    // Fahrtrichtung (gegen die Wegrichtung bei oneway=-1) und Mitte des Stücks
    const s = t.oneway === '-1' ? -1 : 1;
    const d: Vec = [((b[0] - a[0]) / l) * s, ((b[1] - a[1]) / l) * s];
    const c: Vec = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const twin = pieces.some((q, j) => {
      if (j === i || q.tags.name !== t.name || !isOneway(q.tags, q.tags.highway)) return false;
      const qs = q.tags.oneway === '-1' ? -1 : 1;
      const qp = local[j];
      for (let k = 1; k < qp.length; k++) {
        const [u, v] = [qp[k - 1], qp[k]];
        const e: Vec = [v[0] - u[0], v[1] - u[1]];
        const el = Math.hypot(...e);
        if (el < 0.1) continue;
        const tt = clamp(((c[0] - u[0]) * e[0] + (c[1] - u[1]) * e[1]) / (el * el), 0, 1);
        const near: Vec = [u[0] + e[0] * tt - c[0], u[1] + e[1] * tt - c[1]];
        const dist = Math.hypot(...near);
        const left = d[0] * near[1] - d[1] * near[0] > 0;
        const opposite = (e[0] * qs * d[0] + e[1] * qs * d[1]) / el < -0.7;
        if (dist < 40 && left && opposite) return true;
      }
      return false;
    });
    if (!twin) return;
    // links in Fahrtrichtung = Anfang des Querschnitts (bei oneway=-1 das Ende)
    const prof = s === 1 ? p.profile : p.profile.slice().reverse();
    while (prof[0]?.type === 'sidewalk') prof.shift();
    p.profile = s === 1 ? prof : prof.reverse();
  });

  // ---- kurze Stücke derselben Straße an die Nachbarn angleichen ----
  // OSM-Wege derselben Straße sind oft stückweise unterschiedlich erfasst (Gehweg hier ja, dort
  // nicht; Breite mal gesetzt, mal nicht). Ein kurzes Stück mit eigenem Querschnitt ergäbe zwei
  // Verziehungen hintereinander („Hantel“) — es übernimmt den Querschnitt der Nachbarn, behält aber
  // seine Fahrstreifen-Aufteilung samt Abbiegepfeilen.
  {
    const lenOf = (pc: Piece) => {
      const q = pc.pts.map(proj.fwd);
      let l = 0;
      for (let i = 1; i < q.length; i++) l += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
      return l;
    };
    const lanesSig = (prof: Strip[]) => prof.filter((x) => x.type === 'drive' || x.type === 'bus' || x.type === 'tram').map((x) => x.type + x.dir).join(',');
    const sameStreet = (x: Piece, y: Piece) => (x.tags.name ?? '') === (y.tags.name ?? '') && x.tags.highway === y.tags.highway;
    const ends = new Map<number | string, Piece[]>();
    for (const pc of pieces) for (const id of [pc.ids[0], pc.ids[pc.ids.length - 1]]) ends.set(id, [...(ends.get(id) ?? []), pc]);
    const useAt = new Map<number | string, number>();
    for (const pc of pieces) for (const id of pc.ids) useAt.set(id, (useAt.get(id) ?? 0) + 1);
    /** Nachbar über einen Durchgangspunkt an diesem Ende, Querschnitt in Richtung von pc */
    const neighbour = (pc: Piece, atStart: boolean): Strip[] | null => {
      const id = atStart ? pc.ids[0] : pc.ids[pc.ids.length - 1];
      if (useAt.get(id) !== 2) return null;
      const o = (ends.get(id) ?? []).find((x) => x !== pc);
      if (!o || !sameStreet(o, pc)) return null;
      // gleiche Laufrichtung, wenn der Nachbar dort endet, wo pc beginnt (bzw. umgekehrt)
      const sameDir = atStart ? o.ids[o.ids.length - 1] === id : o.ids[0] === id;
      return sameDir ? o.profile : reverseProfile(o.profile);
    };
    const adopt = (pc: Piece, from: Strip[]) => {
      const turns = pc.profile.filter((x) => x.type === 'drive' || x.type === 'bus').map((x) => x.turn);
      let k = 0;
      pc.profile = from.map((x) => {
        const c = { ...structuredClone(x), id: uid() };
        if (x.type === 'drive' || x.type === 'bus') {
          const t = turns[k++];
          if (t) c.turn = t;
          else delete c.turn;
        }
        return c;
      });
    };
    for (const pc of pieces.slice().sort((x, y) => lenOf(x) - lenOf(y))) {
      const l = lenOf(pc);
      if (l >= 40) break;
      const [a, b] = [neighbour(pc, true), neighbour(pc, false)];
      const mine = lanesSig(pc.profile);
      if (a && b && signature(a) === signature(b) && lanesSig(a) === mine) adopt(pc, a);
      else if (l < 25 && (a ?? b) && !(a && b) && lanesSig((a ?? b)!) === mine) adopt(pc, (a ?? b)!);
    }
  }

  // ---- Wegstücke mit gleichem Querschnitt zu durchgehenden Straßen verbinden ----
  const uses = () => {
    const m = new Map<number | string, number>();
    for (const p of pieces) for (const id of p.ids) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  };
  for (let changed = true; changed; ) {
    changed = false;
    const use = uses();
    outer: for (const a of pieces) {
      const x = a.ids[a.ids.length - 1];
      if (use.get(x) !== 2) continue;
      for (const b of pieces) {
        if (b === a || (b.ids[0] !== x && b.ids[b.ids.length - 1] !== x)) continue;
        if ((b.tags.name ?? '') !== (a.tags.name ?? '') || b.tags.maxspeed !== a.tags.maxspeed) continue;
        const flip = b.ids[0] !== x;
        const bProfile = flip ? reverseProfile(b.profile) : b.profile;
        if (signature(bProfile) !== signature(a.profile)) continue;
        const ids = flip ? b.ids.slice().reverse() : b.ids;
        const pts = flip ? b.pts.slice().reverse() : b.pts;
        if (ids[ids.length - 1] === a.ids[0]) continue; // würde eine Schleife schließen
        a.ids.push(...ids.slice(1));
        a.pts.push(...pts.slice(1));
        pieces = pieces.filter((p) => p !== b);
        changed = true;
        break outer;
      }
    }
  }

  // ---- vereinfachen: Zwischenpunkte, die kaum von der Geraden abweichen, entfallen ----
  const use = uses();
  for (const p of pieces) {
    const local = p.pts.map(proj.fwd);
    const keep = new Array(local.length).fill(false);
    keep[0] = keep[local.length - 1] = true;
    p.ids.forEach((id, i) => (use.get(id) ?? 0) >= 2 && (keep[i] = true));
    const dp = (i: number, j: number) => {
      if (j - i < 2) return;
      const [a, b] = [local[i], local[j]];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
      let worst = -1, at = -1;
      for (let k = i + 1; k < j; k++) {
        const d = Math.abs((b[0] - a[0]) * (local[k][1] - a[1]) - (b[1] - a[1]) * (local[k][0] - a[0])) / l;
        if (d > worst) (worst = d), (at = k);
      }
      if (worst > 0.5) {
        keep[at] = true;
        dp(i, at);
        dp(at, j);
      }
    };
    // zwischen fest zu haltenden Punkten (Knoten) jeweils einzeln vereinfachen
    let last = 0;
    for (let i = 1; i < local.length; i++) if (keep[i]) (dp(last, i), (last = i));
    p.ids = p.ids.filter((_, i) => keep[i]);
    p.pts = p.pts.filter((_, i) => keep[i]);
  }
  pieces = pieces.filter((p) => p.pts.length >= 2 && Math.hypot(...(proj.fwd(p.pts[0]).map((v, k) => v - proj.fwd(p.pts[p.pts.length - 1])[k]) as Vec)) > 1);

  const roads: Road[] = pieces.map((p) => {
    const t = p.tags;
    const speed = t.maxspeed === 'walk' || t.highway === 'living_street' ? 7 : num(t.maxspeed);
    return {
      id: uid(),
      name: t.name ?? t.ref ?? (t.highway === 'pedestrian' ? 'Fußgängerzone' : 'Straße'),
      points: p.pts.map(([x, y]) => [x, y] as LngLat),
      profile: p.profile,
      smooth: true,
      ...(speed ? { speed } : {}),
    };
  });

  // ---- Kreuzungen: Regelung aus Ampeln, Klassen und Querungen ----
  const rankOf = new Map(roads.map((r, i) => [r.id, (RANK[baseClass(pieces[i].tags.highway)] ?? 1) + (pieces[i].tags.priority_road === 'designated' ? 0.5 : 0)]));
  const arms = new Map<string, { arm: string; rank: number }[]>();
  roads.forEach((r) => {
    r.points.forEach((pt, i) => {
      const k = nodeKey(pt);
      const list = arms.get(k) ?? [];
      if (i < r.points.length - 1) list.push({ arm: `${r.id}:f`, rank: rankOf.get(r.id)! });
      if (i > 0) list.push({ arm: `${r.id}:b`, rank: rankOf.get(r.id)! });
      arms.set(k, list);
    });
  });
  const crossings = [...arms].filter(([k, a]) => a.length >= 3 && !junctions[k]).map(([k, a]) => ({ k, a, p: proj.fwd(k.split(',').map(Number) as LngLat) }));
  const nearest = (q: Vec, max: number) => {
    let best: (typeof crossings)[number] | null = null, bd = max;
    for (const c of crossings) {
      const d = Math.hypot(c.p[0] - q[0], c.p[1] - q[1]);
      if (d < bd) (bd = d), (best = c);
    }
    return best;
  };
  const signalled = new Set<string>();
  const crossingAt = new Map<string, Crossing>();
  let signals = 0;
  for (const n of nodes.values()) {
    const hw = n.tags?.highway;
    if (!hw) continue;
    const q = proj.fwd([n.lon, n.lat]);
    if (hw === 'traffic_signals') {
      const c = nearest(q, 30);
      if (c && !signalled.has(c.k)) (signalled.add(c.k), signals++);
    } else if (hw === 'crossing') {
      const c = nearest(q, 20);
      const kind = n.tags!.crossing;
      if (c) crossingAt.set(c.k, kind === 'traffic_signals' ? 'furt' : kind === 'zebra' || n.tags!.crossing_ref === 'zebra' ? 'zebra' : crossingAt.get(c.k) ?? 'none');
    } else if (hw === 'mini_roundabout') {
      const c = nearest(q, 5);
      if (c) junctions[c.k] = { ...defaultJunction(), kind: 'mini', control: 'none', rbRadius: 10, rbLane: 6.5 };
    }
  }
  for (const { k, a } of crossings) {
    if (junctions[k]) continue;
    const top = Math.max(...a.map((x) => x.rank)), low = Math.min(...a.map((x) => x.rank));
    const st: JunctionSettings = { ...defaultJunction(), radius: top >= 3 ? 8 : 6, crossing: crossingAt.get(k) ?? 'none' };
    if (signalled.has(k)) {
      st.control = 'signals';
      if (st.crossing === 'none') st.crossing = 'furt';
    } else if (top > low) {
      st.control = 'priority';
      st.roles = Object.fromEntries(a.map((x) => [x.arm, (x.rank === top ? 'main' : 'yield') as ArmRole]));
    } else st.control = top <= 1 ? 'none' : 'stoplines';
    junctions[k] = st;
  }

  return { roads, junctions, stats: { roads: roads.length, trees: treePts.length, signals, roundabouts } };
}
