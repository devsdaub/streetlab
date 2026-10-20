import type { Feature, FeatureCollection, Polygon } from 'geojson';
import {
  band,
  cumulativeLength,
  dedupe,
  leftNormal,
  linePolygons,
  pointAt,
  polylineLength,
  localProjection,
  resample,
  offsetPolyline,
  slicePolyline,
  smoothPolyline,
  smoothWithIndex,
  type Vec,
} from './geometry';
import { stripColor, stripDecor } from './decor';
import { speedSign } from './glyphs';
import { buildJunction, type ArmInput, type JunctionInfo } from './junction';
import {
  STRIP_TYPES,
  defaultJunction,
  reverseProfile,
  sameProfile,
  type JunctionSettings,
  type LineStyle,
  type LngLat,
  type MarkingStyle,
  profileAt,
  sectionAt,
  type Road,
  type Strip,
} from './model';

type Marking = Exclude<LineStyle, 'auto'> | 'center';
type Line = { shift: number; width: number; color: string; dash?: [number, number] };

const WHITE = '#f4f4f0';
const YELLOW = '#f2c230';

/** Linien einer Markierungsart; shift = Versatz zur Streifengrenze (+ = links) */
function markingLines(kind: Marking, style: MarkingStyle): Line[] {
  switch (kind) {
    case 'dashed':
      return [{ shift: 0, width: 0.15, color: WHITE, dash: [3, 6] }];
    case 'solid':
      return [{ shift: 0, width: 0.15, color: WHITE }];
    case 'wide':
      return [{ shift: 0, width: 0.25, color: WHITE }];
    case 'center':
      return style === 'us'
        ? [{ shift: 0.1, width: 0.1, color: YELLOW }, { shift: -0.1, width: 0.1, color: YELLOW }]
        : [{ shift: 0, width: 0.15, color: WHITE, dash: [3, 6] }];
    default:
      return [];
  }
}

/** Überlappung der Teilstücke eines Zugs — verhindert Haarrisse an den Übergängen */
const OVERLAP = 0.3;

const isLane = (s: Strip) => s.type === 'drive' || s.type === 'bus';

function autoLine(a: Strip, b: Strip): Marking {
  if (isLane(a) && isLane(b)) {
    if (a.dir !== b.dir) return 'center';
    return a.type === b.type ? 'dashed' : 'wide';
  }
  if (a.type === 'bike' && b.type === 'bike') return a.dir !== b.dir ? 'center' : 'dashed';
  if ((a.type === 'bike' && isLane(b)) || (b.type === 'bike' && isLane(a))) return 'wide';
  if ((a.type === 'parking' && isLane(b)) || (b.type === 'parking' && isLane(a))) return 'solid';
  if ((a.type === 'tram') !== (b.type === 'tram') && (isLane(a) || isLane(b))) return 'solid';
  return 'none';
}

export interface RoadFeatures {
  surfaces: Feature<Polygon>[];
  markings: Feature<Polygon>[];
  decor: Feature<Polygon>[];
}

const emptyFeatures = (): RoadFeatures => ({ surfaces: [], markings: [], decor: [] });

export interface Built {
  surfaces: FeatureCollection;
  markings: FeatureCollection;
  decor: FeatureCollection;
  /** Kreuzungsdaten für den Editor, Schlüssel = nodeKey */
  junctions?: Map<string, JunctionInfo>;
  /** Verziehungen, Schlüssel = Grenze (nodeKey oder sec:…) */
  transitions?: Map<string, TransitionInfo>;
}

/** Darstellungsoptionen, die das Ergebnis verändern (Teil der Cache-Schlüssel) */
export interface RenderOptions {
  style: MarkingStyle;
  traffic: boolean;
  /** Streifen-Zuordnung an Verziehungen (Project.stripLinks) */
  links?: Record<string, string>;
}

/** Verziehung zwischen zwei Querschnitten — für das Bearbeiten direkt in der Karte */
export interface TransitionInfo {
  key: string;
  /** Querschnitt vorher / nachher (in Zugrichtung) */
  A: Strip[];
  B: Strip[];
  length: number;
  auto: boolean;
  pairs: { a?: string; b?: string }[];
  /** Streifenmitten am Anfang (a) und Ende (b) der Verziehung — zum Verbinden in der Karte */
  ends: { id: string; side: 'a' | 'b'; pos: LngLat }[];
}

/** Knoten-Schlüssel: Stützpunkte gelten als identisch, wenn sie auf ~1 mm übereinstimmen. */
export const nodeKey = (p: LngLat) => `${p[0].toFixed(8)},${p[1].toFixed(8)}`;

type Proj = ReturnType<typeof localProjection>;

/** Flächen und Markierungen eines Straßenstücks entlang einer (lokalen) Mittellinie. */
function stripFeatures(
  roadId: string,
  section: number,
  profile: Strip[],
  center: Vec[],
  proj: Proj,
  phase = 0,
  keepOut: [number, number] = [0, 0],
  opts: RenderOptions = { style: 'de', traffic: false },
  /** Rückschnitt der Mittelinsel (bei Querungen bis an den Knoten = Fußgänger-Insel) */
  noses: [number, number] = keepOut,
): RoadFeatures {
  const { style } = opts;
  const out = emptyFeatures();
  if (center.length < 2 || !profile.length) return out;
  const ring = (pts: Vec[]) => pts.map(proj.inv);
  const total = profile.reduce((s, x) => s + x.width, 0);
  let left = total / 2;

  profile.forEach((strip, i) => {
    const right = left - strip.width;
    const info = STRIP_TYPES[strip.type];
    const surface = (pts: Vec[], color: string, rank: number) =>
      out.surfaces.push({
        type: 'Feature',
        properties: { roadId, section, stripId: strip.id, type: strip.type, color, rank },
        geometry: { type: 'Polygon', coordinates: [ring(pts)] },
      });
    const L = polylineLength(center);
    const n0 = noses[0] > 0 ? noses[0] + 1 : 0, n1 = noses[1] > 0 ? noses[1] + 1 : 0;
    if (strip.type === 'median' && (n0 || n1) && L - n0 - n1 > strip.width) {
      // Mittelinsel endet vor der Kreuzung mit runder Nase, darunter Fahrbahn
      surface(band(center, left, right), STRIP_TYPES.drive.color, 4);
      const piece = slicePolyline(center, n0, L - n1);
      const mid = (left + right) / 2, r = strip.width / 2;
      const nose = (s: number, back: 1 | -1) => {
        const { p, t } = pointAt(piece, s);
        const n = leftNormal(t);
        const c: Vec = [p[0] + n[0] * mid, p[1] + n[1] * mid];
        return Array.from({ length: 13 }, (_, i) => {
          const a = (i / 12) * Math.PI;
          const u = r * Math.cos(a), v = r * Math.sin(a) * back;
          return [c[0] + n[0] * u + t[0] * v, c[1] + n[1] * u + t[1] * v] as Vec;
        });
      };
      surface(band(piece, left, right), stripColor(strip), info.rank + 3);
      if (n0) surface(nose(0, -1), stripColor(strip), info.rank + 3);
      if (n1) surface(nose(polylineLength(piece), 1), stripColor(strip), info.rank + 3);
    } else {
      surface(band(center, left, right), stripColor(strip), info.rank);
    }
    stripDecor(roadId, strip, left, right, center, ring, phase, keepOut, out, opts.traffic);

    const next = profile[i + 1];
    if (next) {
      const lines: Line[] = [];
      const cwHere = info.carriageway, cwNext = STRIP_TYPES[next.type].carriageway;
      if (cwHere !== cwNext) {
        // Bordstein: helle Kante, bei Fahrstreifen zusätzlich weiße Randlinie auf der Fahrbahn
        lines.push({ shift: 0, width: 0.1, color: '#ece4d8' });
        const lane = cwHere ? strip : next;
        if (isLane(lane)) lines.push({ shift: cwHere ? 0.35 : -0.35, width: 0.15, color: WHITE });
      }
      lines.push(...markingLines(strip.lineRight === 'auto' ? autoLine(strip, next) : strip.lineRight, style));
      for (const ln of lines) {
        for (const poly of linePolygons(offsetPolyline(center, right + ln.shift), ln.width, ln.dash, phase, keepOut)) {
          out.markings.push({
            type: 'Feature',
            properties: { roadId, color: ln.color },
            geometry: { type: 'Polygon', coordinates: [ring(poly)] },
          });
        }
      }
    }
    left = right;
  });
  return out;
}

/** Länge einer Querschnitts-Verziehung zwischen zwei verschiedenen Querschnitten (m) */
const TRANSITION = 20;

interface MorphStrip {
  type: Strip['type'];
  dir: 1 | -1;
  wA: number;
  wB: number;
  src: Strip;
  /** Streifen vorher, falls er einen anderen Typ hatte (Farbwechsel in der Mitte) */
  from?: Strip;
  aId?: string;
  bId?: string;
  /** Bord-Elemente (Gehweg, Grün, Parken) wechseln kurz in der Mitte statt über die ganze Länge */
  quick: boolean;
}

const flowing = (t: Strip['type']) => t === 'drive' || t === 'bus' || t === 'tram' || t === 'bike';

/**
 * Ordnet zwei Querschnitte einander zu. Festgelegte Zuordnungen (wie Spurverbindungen) haben
 * Vorrang; dazwischen gilt die längste gemeinsame Folge gleicher Streifen. Nicht zugeordnete
 * Streifen wachsen aus 0 bzw. laufen auf 0 aus.
 */
function alignProfiles(A: Strip[], B: Strip[], link: (id: string) => string | undefined = () => undefined): MorphStrip[] {
  const pair = (a: Strip, b: Strip): MorphStrip => ({
    type: b.type, dir: b.dir, wA: a.width, wB: b.width, src: b, aId: a.id, bId: b.id,
    from: a.type !== b.type ? a : undefined,
    quick: a.type !== b.type || !flowing(b.type),
  });
  const ends = (a: Strip): MorphStrip => ({ type: a.type, dir: a.dir, wA: a.width, wB: 0, src: a, aId: a.id, quick: !flowing(a.type) });
  const grows = (b: Strip): MorphStrip => ({ type: b.type, dir: b.dir, wA: 0, wB: b.width, src: b, bId: b.id, quick: !flowing(b.type) });

  const aIdx = new Map(A.map((x, i) => [x.id, i]));
  let fixed: [number, number][] = [];
  B.forEach((b, j) => {
    const l = link(b.id);
    if (l && aIdx.has(l)) fixed.push([aIdx.get(l)!, j]);
  });
  // nur reihenfolgetreue Zuordnungen (Streifen können sich nicht kreuzen)
  fixed.sort((x, y) => x[1] - y[1]);
  fixed = fixed.filter((p, k) => fixed.slice(0, k).every((q) => q[0] < p[0]));
  const blocked = (x: Strip) => link(x.id) !== undefined;

  const lcs = (As: Strip[], Bs: Strip[]): MorphStrip[] => {
    const same = (a: Strip, b: Strip) =>
      !blocked(a) && !blocked(b) && a.type === b.type && (!STRIP_TYPES[a.type].directional || a.dir === b.dir);
    const n = As.length, m = Bs.length;
    const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i][j] = same(As[i], Bs[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out: MorphStrip[] = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && same(As[i], Bs[j])) out.push(pair(As[i++], Bs[j++]));
      else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) out.push(ends(As[i++]));
      else out.push(grows(Bs[j++]));
    }
    return out;
  };

  const out: MorphStrip[] = [];
  let pi = 0, pj = 0;
  for (const [fi, fj] of [...fixed, [A.length, B.length] as [number, number]]) {
    out.push(...lcs(A.slice(pi, fi), B.slice(pj, fj)));
    if (fi < A.length) out.push(pair(A[fi], B[fj]));
    pi = fi + 1;
    pj = fj + 1;
  }
  return out;
}

const smoothstep = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * Verziehung: Flächen und Linien, deren Querversatz sich entlang der Strecke stetig ändert.
 * `zoneStart`/`zoneLen` beziehen sich auf die Bogenlänge im Zug, `s0` ist der Anfang des Stücks.
 */
function morphFeatures(
  roadId: string,
  section: number,
  tKey: string,
  morph: MorphStrip[],
  piece: Vec[],
  s0: number,
  zoneStart: number,
  zoneLen: number,
  proj: Proj,
  phase: number,
  style: MarkingStyle,
): RoadFeatures {
  const out = emptyFeatures();
  const pts = resample(piece, 0.75);
  if (pts.length < 2) return out;
  const cum = cumulativeLength(pts);
  const tRaw = cum.map((s) => Math.min(1, Math.max(0, (s0 + s - zoneStart) / zoneLen)));
  // Bord-Elemente wechseln im mittleren Drittel, Fahrstreifen über die ganze Länge
  const ease = (m: MorphStrip, t: number) => (m.quick ? smoothstep((t - 0.35) / 0.3) : smoothstep(t));
  // Normale je Punkt: Mittel der angrenzenden Strecken
  const normals = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return leftNormal([(b[0] - a[0]) / l, (b[1] - a[1]) / l]);
  });
  const widths = tRaw.map((t) => morph.map((m) => m.wA + (m.wB - m.wA) * ease(m, t)));
  /** Versatz der linken Kante von Streifen j an Punkt i */
  const leftOf = (i: number, j: number) => {
    const w = widths[i];
    let left = w.reduce((s, x) => s + x, 0) / 2;
    for (let k = 0; k < j; k++) left -= w[k];
    return left;
  };
  const line = (j: number, side: 'l' | 'r', shift = 0) =>
    pts.map((p, i) => {
      const o = leftOf(i, j) - (side === 'r' ? widths[i][j] : 0) + shift;
      return [p[0] + normals[i][0] * o, p[1] + normals[i][1] * o] as Vec;
    });
  const ring = (r: Vec[]) => r.map(proj.inv);

  morph.forEach((m, j) => {
    if (Math.max(m.wA, m.wB) < 0.05) return;
    const info = STRIP_TYPES[m.type];
    const l = line(j, 'l'), r = line(j, 'r');
    const poly = (from: number, to: number, strip: Strip) => {
      const ll = l.slice(from, to + 1), rr = r.slice(from, to + 1).reverse();
      if (ll.length < 2) return;
      out.surfaces.push({
        type: 'Feature',
        properties: { roadId, section, stripId: m.src.id, type: strip.type, transition: tKey, color: stripColor(strip), rank: STRIP_TYPES[strip.type].rank },
        geometry: { type: 'Polygon', coordinates: [ring([...ll, ...rr, ll[0]])] },
      });
    };
    if (m.from) {
      // Typwechsel (z. B. Parken → Grün): Farbe wechselt in der Mitte
      const mid = Math.max(1, tRaw.findIndex((t) => t >= 0.5));
      poly(0, mid, m.from);
      poly(mid, pts.length - 1, m.src);
    } else poly(0, pts.length - 1, m.src);
    const next = morph[j + 1];
    if (!next) return;
    const lines: Line[] = [];
    const cwHere = info.carriageway, cwNext = STRIP_TYPES[next.type].carriageway;
    if (cwHere !== cwNext) lines.push({ shift: 0, width: 0.1, color: '#ece4d8' });
    const a = { ...m.src, type: m.type, dir: m.dir }, b = { ...next.src, type: next.type, dir: next.dir };
    // Leitlinien nur zwischen fließenden Streifen, Bord-Elemente bekommen nur ihre Kante
    if (!m.quick && !next.quick) lines.push(...markingLines(autoLine(a, b), style));
    for (const ln of lines) {
      for (const poly of linePolygons(line(j, 'r', ln.shift), ln.width, ln.dash, phase)) {
        out.markings.push({ type: 'Feature', properties: { roadId, color: ln.color }, geometry: { type: 'Polygon', coordinates: [ring(poly)] } });
      }
    }
  });
  return out;
}

/** Mittelpunkte der Streifen eines Querschnitts an Bogenlänge s */
function stripCenters(profile: Strip[], center: Vec[], s: number, proj: Proj) {
  const { p, t } = pointAt(center, s);
  const n = leftNormal(t);
  let left = profile.reduce((a, x) => a + x.width, 0) / 2;
  return profile.map((x) => {
    const o = left - x.width / 2;
    left -= x.width;
    return { id: x.id, pos: proj.inv([p[0] + n[0] * o, p[1] + n[1] * o]) };
  });
}

/** Einzelne Straße ohne Knotenbezug (z. B. Vorschau beim Zeichnen). */
export function buildRoad(road: Road): RoadFeatures {
  if (road.points.length < 2) return emptyFeatures();
  const proj = localProjection(road.points[0]);
  let center = dedupe(road.points.map(proj.fwd));
  if (road.smooth) center = smoothPolyline(center);
  return stripFeatures(road.id, 0, road.profile, center, proj);
}

/** Teilstück einer Straße zwischen zwei Knoten (oder Straßenenden). */
interface Segment {
  id: string;
  road: Road;
  raw: LngLat[];
  /** Querschnitt dieses Stücks (Abschnitt der Straße) */
  profile: Strip[];
  section: number;
  start?: string;
  end?: string;
}

/** Schlüssel einer reinen Abschnittsgrenze (kein Knoten mit anderen Straßen) */
const sectionKey = (road: Road, i: number) => `sec:${road.id}:${i}`;

interface Part {
  seg: Segment;
  /** true = Segment wird entgegen seiner Zeichenrichtung durchlaufen */
  rev: boolean;
}

/**
 * Zug = Folge von Segmenten, die an Durchgangsknoten (genau zwei Straßen) ineinander übergehen.
 * Er wird als eine Straße geglättet und gezeichnet; wechselt der Querschnitt, entsteht eine Verziehung.
 */
interface Chain {
  id: string;
  parts: Part[];
  /** Querschnitt je Teil, in Zugrichtung */
  profiles: Strip[][];
  start?: string;
  end?: string;
  proj: Proj;
  center: Vec[];
  length: number;
  /** Bogenlänge an jeder Teilgrenze (parts.length + 1 Werte) */
  bounds: number[];
  geomKey: string;
}

/** Fingerabdruck der Geometrie einer Straße (Punkte, Glättung, Abschnittsgrenzen) */
function geomHash(road: Road): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const [x, y] of road.points) {
    const a = Math.round(x * 1e8), b = Math.round(y * 1e8);
    h1 = Math.imul(h1 ^ (a | 0), 16777619) ^ Math.imul(h2 ^ (b | 0), 2246822507);
    h2 = Math.imul(h2 ^ (a / 4294967296) | 0, 3266489909) + (b | 0);
  }
  return `${road.points.length}:${h1 >>> 0}:${h2 >>> 0}:${road.smooth ? 1 : 0}:${(road.sections ?? []).map((x) => x.index).join(',')}`;
}

/** Knotenschlüssel je Straße, nur bei geänderter Geometrie neu berechnet */
const keyCache = new WeakMap<Road, { hash: string; keys: string[] }>();
function pointKeys(road: Road, hash: string): string[] {
  const hit = keyCache.get(road);
  if (hit && hit.hash === hash) return hit.keys;
  const keys = road.points.map(nodeKey);
  keyCache.set(road, { hash, keys });
  return keys;
}

/** Punkte, an denen sich mindestens zwei verschiedene Straßen treffen. */
function findNodes(roads: Road[], hashes: Map<Road, string> = new Map()): Map<string, LngLat> {
  const seen = new Map<string, { p: LngLat; roads: Set<string> }>();
  for (const r of roads) {
    const keys = pointKeys(r, hashes.get(r) ?? geomHash(r));
    for (let i = 0; i < r.points.length; i++) {
      const p = r.points[i];
      const k = keys[i];
      const e = seen.get(k) ?? { p, roads: new Set<string>() };
      e.roads.add(r.id);
      seen.set(k, e);
    }
  }
  const nodes = new Map<string, LngLat>();
  for (const [k, e] of seen) if (e.roads.size >= 2) nodes.set(k, e.p);
  return nodes;
}

function segmentRoad(road: Road, nodes: Map<string, LngLat>): Segment[] {
  const n = road.points.length;
  if (n < 2) return [];
  const secStarts = new Set((road.sections ?? []).map((x) => x.index));
  const cuts = [0];
  for (let i = 1; i < n - 1; i++) if (nodes.has(nodeKey(road.points[i])) || secStarts.has(i)) cuts.push(i);
  cuts.push(n - 1);
  const keyAt = (i: number) => {
    const k = nodeKey(road.points[i]);
    if (nodes.has(k)) return k;
    return secStarts.has(i) ? sectionKey(road, i) : undefined;
  };
  const segs: Segment[] = [];
  for (let c = 0; c < cuts.length - 1; c++) {
    const [a, b] = [cuts[c], cuts[c + 1]];
    segs.push({
      id: `${road.id}#${c}`,
      road,
      raw: road.points.slice(a, b + 1),
      profile: profileAt(road, a),
      section: sectionAt(road, a),
      start: a === 0 ? keyAt(0) : keyAt(a),
      end: keyAt(b),
    });
  }
  return segs;
}

const oriented = (p: Part) => (p.rev ? reverseProfile(p.seg.profile) : p.seg.profile);
const endKey = (seg: Segment, atStart: boolean) => `${seg.id}|${atStart ? 's' : 'e'}`;

/** Verkettet Segmente an Durchgangsknoten zu Zügen. */
function buildChains(segs: Segment[]): { parts: Part[]; start?: string; end?: string }[] {
  // Segment-Enden je Knoten
  const ends = new Map<string, { seg: Segment; atStart: boolean }[]>();
  for (const s of segs) {
    if (s.start) ends.set(s.start, [...(ends.get(s.start) ?? []), { seg: s, atStart: true }]);
    if (s.end) ends.set(s.end, [...(ends.get(s.end) ?? []), { seg: s, atStart: false }]);
  }
  // Durchgangsknoten: genau zwei Enden verschiedener Segmente. Gleicher Querschnitt → nahtlos;
  // anderer Querschnitt → Verziehung, aber nur bei sanftem Knick (sonst Knotenpunkt mit Ecke)
  const links = new Map<string, { seg: Segment; atStart: boolean }>();
  const heading = (seg: Segment, atStart: boolean) => {
    const [p, q] = atStart ? [seg.raw[0], seg.raw[1]] : [seg.raw[seg.raw.length - 1], seg.raw[seg.raw.length - 2]];
    const k = Math.cos((p[1] * Math.PI) / 180);
    return Math.atan2(q[1] - p[1], (q[0] - p[0]) * k);
  };
  for (const [key, list] of ends) {
    if (list.length !== 2 || list[0].seg === list[1].seg) continue;
    const [a, b] = list;
    const incoming = a.atStart ? reverseProfile(a.seg.profile) : a.seg.profile;
    const outgoing = b.atStart ? b.seg.profile : reverseProfile(b.seg.profile);
    // Abschnittsgrenzen innerhalb einer Straße werden immer verbunden
    if (!key.startsWith('sec:') && !sameProfile(incoming, outgoing)) {
      // beide Richtungen zeigen vom Knoten weg: geradeaus = 180° Unterschied
      let d = Math.abs(heading(a.seg, a.atStart) - heading(b.seg, b.atStart));
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d < (130 * Math.PI) / 180) continue;
    }
    links.set(endKey(a.seg, a.atStart), b);
    links.set(endKey(b.seg, b.atStart), a);
  }

  const next = (p: Part): Part | undefined => {
    const o = links.get(endKey(p.seg, p.rev));
    return o && { seg: o.seg, rev: !o.atStart };
  };
  const prev = (p: Part): Part | undefined => {
    const o = links.get(endKey(p.seg, !p.rev));
    return o && { seg: o.seg, rev: o.atStart };
  };

  const used = new Set<Segment>();
  const chains: { parts: Part[]; start?: string; end?: string }[] = [];
  for (const s of segs) {
    if (used.has(s)) continue;
    // an den Anfang des Zugs zurücklaufen (Ringe brechen am Ausgangssegment ab)
    let first: Part = { seg: s, rev: false };
    const seen = new Set([s]);
    for (let p = prev(first); p && !seen.has(p.seg); p = prev(p)) {
      seen.add(p.seg);
      first = p;
    }
    const parts: Part[] = [];
    for (let p: Part | undefined = first; p && !used.has(p.seg); p = next(p)) {
      used.add(p.seg);
      parts.push(p);
    }
    const head = parts[0], tail = parts[parts.length - 1];
    chains.push({
      parts,
      start: head.rev ? head.seg.end : head.seg.start,
      end: tail.rev ? tail.seg.start : tail.seg.end,
    });
  }
  return chains;
}

function chainGeometry(c: { parts: Part[]; start?: string; end?: string }): Chain {
  const raw: LngLat[] = [];
  const rawBounds: number[] = [];
  for (const p of c.parts) {
    const pts = p.rev ? p.seg.raw.slice().reverse() : p.seg.raw;
    for (const q of pts) if (!raw.length || nodeKey(raw[raw.length - 1]) !== nodeKey(q)) raw.push(q);
    rawBounds.push(raw.length - 1);
  }
  rawBounds.unshift(0);
  const smooth = c.parts.every((p) => p.seg.road.smooth);
  const proj = localProjection(raw[0]);
  const local = raw.map(proj.fwd);
  const { pts, idx } = smooth ? smoothWithIndex(local) : { pts: local, idx: local.map((_, i) => i) };
  const cum = cumulativeLength(pts);
  return {
    id: c.parts.map((p) => p.seg.id).join('+'),
    parts: c.parts,
    profiles: c.parts.map(oriented),
    start: c.start,
    end: c.end,
    proj,
    center: dedupe(pts),
    length: cum[cum.length - 1],
    bounds: rawBounds.map((i) => cum[idx[i]]),
    geomKey: '',
  };
}

/**
 * Baut das ganze Netz: Straßen werden an Knoten geteilt, an Durchgangsknoten zu Zügen
 * verkettet, an echten Kreuzungen zurückgeschnitten und durch Knotenflächen verbunden.
 * Unveränderte Teile kommen aus dem Cache.
 */
export class RoadRenderer {
  private chainCache = new Map<string, Chain>();
  private segCache = new Map<string, { key: string; segs: Segment[] }>();
  private junctionCache = new Map<string, { sig: string; res: ReturnType<typeof buildJunction> }>();
  private featCache = new Map<string, RoadFeatures>();

  build(
    roads: Road[],
    junctions: Record<string, JunctionSettings> = {},
    withJunctions = true,
    opts: RenderOptions = { style: 'de', traffic: false },
  ): Built {
    const { style } = opts;
    const optKey = `${style}${opts.traffic ? '+t' : ''}`;
    const junctionInfo = new Map<string, JunctionInfo>();
    const transitions = new Map<string, TransitionInfo>();
    const hashes = new Map(roads.map((r) => [r, geomHash(r)] as const));
    const nodes = withJunctions ? findNodes(roads, hashes) : new Map<string, LngLat>();
    const surfaces: Feature[] = [];
    const markings: Feature[] = [];
    const decor: Feature[] = [];

    // 1. Segmente und Züge
    const segCache = new Map<string, { key: string; segs: Segment[] }>();
    const segs = roads.flatMap((r) => {
      const keys = pointKeys(r, hashes.get(r)!);
      const cut = keys.map((k, i) => (nodes.has(k) ? i : -1)).filter((i) => i >= 0).join(',');
      const key = `${hashes.get(r)}|${cut}|${JSON.stringify([r.profile, r.sections?.map((x) => x.profile)])}`;
      const hit = this.segCache.get(r.id);
      const out = hit && hit.key === key ? hit.segs : segmentRoad(r, nodes);
      for (const x of out) x.road = r;
      segCache.set(r.id, { key, segs: out });
      return out;
    });
    this.segCache = segCache;
    const chainCache = new Map<string, Chain>();
    const chains = buildChains(segs).map((c) => {
      const probe = c.parts.map((p) => `${p.seg.id}${p.rev ? 'r' : ''}@${hashes.get(p.seg.road) ?? geomHash(p.seg.road)}|${p.seg.start}|${p.seg.end}`).join('+');
      const chain = this.chainCache.get(probe) ?? chainGeometry(c);
      // Geometrie aus dem Cache, Bezüge immer aktuell
      Object.assign(chain, { parts: c.parts, profiles: c.parts.map(oriented), start: c.start, end: c.end, geomKey: probe });
      chainCache.set(probe, chain);
      return chain;
    });
    this.chainCache = chainCache;

    // 2. Knoten (Kreuzungen, Einmündungen, Querschnittswechsel)
    const arms = new Map<string, ArmInput[]>();
    const toArm = (c: Chain, atStart: boolean): ArmInput => {
      const local = atStart ? c.center : c.center.slice().reverse();
      const part = atStart ? c.parts[0] : c.parts[c.parts.length - 1];
      // verlässt die Straße den Knoten in ihrer Zeichenrichtung?
      const forward = atStart ? !part.rev : part.rev;
      return {
        segId: c.id,
        roadId: part.seg.road.id,
        armId: `${part.seg.road.id}:${forward ? 'f' : 'b'}`,
        pts: slicePolyline(local, 0, 80).map(c.proj.inv),
        profile: atStart ? c.profiles[0] : c.profiles[c.profiles.length - 1],
        atStart,
        // beide Enden an Knoten: jeder Knoten darf höchstens die Hälfte beanspruchen
        maxTrim: Math.max(0.5, (c.start && c.end ? c.length / 2 : c.length) - 0.5),
        both: !!(c.start && c.end),
        length: c.length,
        uniform: uniformLength(c, atStart),
        sig: `${c.geomKey}|${atStart}|${JSON.stringify(atStart ? c.profiles[0] : c.profiles[c.profiles.length - 1])}`,
      };
    };
    /** Strecke ab dem Knoten, auf der der Querschnitt gleich bleibt (vor der ersten Verziehung) */
    const uniformLength = (c: Chain, atStart: boolean) => {
      const keys = c.profiles.map((p) => JSON.stringify(p.map((x) => [x.type, x.width, x.dir])));
      if (atStart) {
        const k = keys.findIndex((x) => x !== keys[0]);
        return k < 0 ? Infinity : c.bounds[k] - TRANSITION / 2 - 2;
      }
      const last = keys.length - 1;
      let k = last;
      while (k > 0 && keys[k - 1] === keys[last]) k--;
      return k === 0 ? Infinity : c.length - c.bounds[k] - TRANSITION / 2 - 2;
    };
    for (const c of chains) {
      if (c.start) arms.set(c.start, [...(arms.get(c.start) ?? []), toArm(c, true)]);
      if (c.end) arms.set(c.end, [...(arms.get(c.end) ?? []), toArm(c, false)]);
    }
    /** je Zug: Rückschnitt Anfang/Ende, markierungsfreier Bereich Anfang/Ende */
    const trims = new Map<string, [number, number, number, number, number, number]>();
    const junctionCache = new Map<string, { sig: string; res: ReturnType<typeof buildJunction> }>();
    for (const [k, list] of arms) {
      // Kreuzungen nur neu berechnen, wenn sich Arme oder Einstellungen geändert haben
      const st = { ...defaultJunction(), ...junctions[k] };
      const sig = JSON.stringify([st, style]) + list.map((a) => a.sig).sort().join('#');
      const hit = this.junctionCache.get(k);
      const j = hit && hit.sig === sig ? hit.res : buildJunction(k, nodes.get(k)!, list, st, style);
      junctionCache.set(k, { sig, res: j });
      junctionInfo.set(k, j.info);
      surfaces.push(...j.surfaces);
      markings.push(...j.markings);
      decor.push(...j.decor);
      for (const t of j.trims) {
        const cur = trims.get(t.segId) ?? [0, 0, 0, 0, 0, 0];
        cur[t.atStart ? 0 : 1] = t.trim;
        cur[t.atStart ? 2 : 3] = t.keepOut;
        cur[t.atStart ? 4 : 5] = t.median;
        trims.set(t.segId, cur);
      }
    }

    this.junctionCache = junctionCache;

    // 3. Straßenstücke: je Teil des Zugs, damit die Auswahl bei der richtigen Straße landet;
    //    zwischen Teilen mit verschiedenem Querschnitt eine Verziehung
    const featCache = new Map<string, RoadFeatures>();
    const cached = (key: string, make: () => RoadFeatures) => {
      const f = this.featCache.get(key) ?? make();
      featCache.set(key, f);
      surfaces.push(...f.surfaces);
      markings.push(...f.markings);
      decor.push(...f.decor);
    };
    for (const c of chains) {
      const [t0, t1, k0, k1, m0, m1] = trims.get(c.id) ?? [0, 0, 0, 0, 0, 0];
      const last = c.parts.length - 1;
      const pks = c.profiles.map((p) => JSON.stringify(p));
      // Länge der Verziehung an jeder inneren Teilgrenze (0 = gleicher Querschnitt)
      /** Grenze zwischen Teil k und k+1: Abschnittsgrenze (sec:…) oder Durchgangsknoten */
      const boundary = (k: number) => {
        const p = c.parts[k];
        return (p.rev ? p.seg.start : p.seg.end) ?? '';
      };
      const override = (k: number) => {
        const key = boundary(k);
        if (key.startsWith('sec:')) {
          const idx = +key.split(':')[2];
          return c.parts[k].seg.road.sections?.find((x) => x.index === idx)?.transition;
        }
        return junctions[key]?.transition;
      };
      const zone = c.parts.map((_, k) => {
        if (k === last || pks[k] === pks[k + 1]) return 0;
        const shortest = Math.min(c.bounds[k + 1] - c.bounds[k], c.bounds[k + 2] - c.bounds[k + 1]);
        const ov = override(k);
        return ov ? Math.min(ov, shortest * 0.95) : Math.min(TRANSITION, shortest * 0.8);
      });
      // Lage der Verziehung: mittig auf der Grenze, aber nie im Kreuzungsbereich
      // (Querung, Haltlinie, Pfeile) — dort wird sie auf die freie Strecke geschoben
      const freeLo = c.start ? t0 + k0 + 2 : 0, freeHi = c.length - (c.end ? t1 + k1 + 2 : 0);
      const zStart = zone.map((z, k) => {
        if (!z) return 0;
        const room = freeHi - freeLo;
        if (room < z) {
          zone[k] = Math.max(Math.min(z, 2), room);
          return room > 0 ? freeLo : c.bounds[k + 1] - zone[k] / 2;
        }
        return Math.min(Math.max(c.bounds[k + 1] - z / 2, freeLo), freeHi - z);
      });
      c.parts.forEach((part, k) => {
        const zOut = zone[k];
        const lo = k === 0 ? t0 : zone[k - 1] ? zStart[k - 1] + zone[k - 1] - OVERLAP : c.bounds[k] - OVERLAP;
        const hi = k === last ? c.length - t1 : zOut ? zStart[k] + OVERLAP : c.bounds[k + 1] + OVERLAP;
        const roadId = part.seg.road.id;
        // Strichmuster ab dem Kreuzungsrand takten, vor Haltlinien/Querungen frei lassen
        const keepOut: [number, number] = [k === 0 ? k0 : 0, k === last ? k1 : 0];
        const noses: [number, number] = [k === 0 ? m0 : 0, k === last ? m1 : 0];
        if (hi - lo >= 0.05) {
          // Liegt das Stück (wegen einer verschobenen Verziehung) teils auf der Nachbarstraße, an der
          // Straßengrenze teilen: jedes Teilstück gehört der Straße, auf der es liegt (Auswahl, Greifen)
          const cuts = [lo, ...c.bounds.slice(1, -1).filter((b) => b > lo + 0.05 && b < hi - 0.05), hi];
          for (let q = 0; q < cuts.length - 1; q++) {
            const [p0, p1] = [cuts[q], cuts[q + 1]];
            const m = (p0 + p1) / 2;
            let o = k;
            while (o > 0 && m < c.bounds[o]) o--;
            while (o < last && m >= c.bounds[o + 1]) o++;
            const owner = c.parts[o];
            const ko: [number, number] = [q === 0 ? keepOut[0] : 0, q === cuts.length - 2 ? keepOut[1] : 0];
            const no: [number, number] = [q === 0 ? noses[0] : 0, q === cuts.length - 2 ? noses[1] : 0];
            const ph = Math.max(0, p0) - t0;
            const key = `${optKey}|${c.geomKey}|${k}|${p0.toFixed(2)}|${p1.toFixed(2)}|${ko}|${no}|${pks[k]}|${owner.seg.road.id}|${owner.seg.section}`;
            cached(key, () =>
              stripFeatures(owner.seg.road.id, owner.seg.section, c.profiles[k], slicePolyline(c.center, Math.max(0, p0), Math.min(c.length, p1)), c.proj, ph, ko, opts, no),
            );
          }
        }
        if (zOut > 0) {
          // Verziehung: was vor der Grenze liegt, gehört zu diesem Teil, der Rest zum nächsten
          const b = c.bounds[k + 1], zs = zStart[k], ze = zs + zOut;
          const tKey = boundary(k);
          // Zuordnung gilt je Übergang: Schlüssel „Grenze|Streifen-ID“
          const morph = alignProfiles(c.profiles[k], c.profiles[k + 1], (id) => opts.links?.[`${tKey}|${id}`]);
          transitions.set(tKey, {
            key: tKey,
            A: c.profiles[k],
            B: c.profiles[k + 1],
            length: zOut,
            auto: !override(k),
            pairs: morph.map((x) => ({ a: x.aId, b: x.bId })),
            ends: [
              ...stripCenters(c.profiles[k], c.center, Math.max(0, zs), c.proj).map((e) => ({ ...e, side: 'a' as const })),
              ...stripCenters(c.profiles[k + 1], c.center, Math.min(c.length, zs + zOut), c.proj).map((e) => ({ ...e, side: 'b' as const })),
            ],
          });
          const mKey = JSON.stringify(morph.map((x) => [x.aId, x.bId, x.quick])) + zOut.toFixed(2);
          const halves: [number, number, string, number][] = [];
          if (b > zs) halves.push([zs - OVERLAP, Math.min(b, ze) + OVERLAP, roadId, part.seg.section]);
          if (b < ze) halves.push([Math.max(b, zs) - OVERLAP, ze + OVERLAP, c.parts[k + 1].seg.road.id, c.parts[k + 1].seg.section]);
          halves.forEach(([from, to, rid, sec], hk) => {
            const key = `${optKey}|${c.geomKey}|m${k}.${hk}.${sec}|${from.toFixed(2)}|${to.toFixed(2)}|${pks[k]}|${pks[k + 1]}|${rid}|${mKey}`;
            cached(key, () =>
              morphFeatures(rid, sec, tKey, morph, slicePolyline(c.center, Math.max(0, from), Math.min(c.length, to)), Math.max(0, from), zs, zOut, c.proj, Math.max(0, from) - t0, style),
            );
          });
        }
      });
    }
    this.featCache = featCache;

    for (const road of roads) {
      if (!road.speed || road.points.length < 2) continue;
      const proj = localProjection(road.points[0]);
      const pts = road.points.map(proj.fwd);
      const sign = speedSign(road.speed);
      const placeSign = (p: Vec, q: Vec, total: number) => {
        // von p Richtung q, Schild rechts in dieser Fahrtrichtung
        const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
        const t: Vec = [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
        const n = leftNormal(t);
        // auf dem Gehweg nahe dem äußeren Rand
        const off = Math.max(0, total / 2 - 1.3);
        const c: Vec = [p[0] + t[0] * 6 - n[0] * off, p[1] + t[1] * 6 - n[1] * off];
        for (const sh of sign) {
          decor.push({
            type: 'Feature',
            properties: { roadId: road.id, color: sh.color, rank: sh.rank ?? 6 },
            geometry: { type: 'Polygon', coordinates: [sh.pts.map(([x, y]) => proj.inv([c[0] + t[0] * x + n[0] * y, c[1] + t[1] * x + n[1] * y]))] },
          });
        }
      };
      const width = (p: Strip[]) => p.reduce((s, x) => s + x.width, 0);
      placeSign(pts[0], pts[1], width(road.profile));
      placeSign(pts[pts.length - 1], pts[pts.length - 2], width(profileAt(road, pts.length - 1)));
    }

    return {
      surfaces: { type: 'FeatureCollection', features: surfaces },
      markings: { type: 'FeatureCollection', features: markings },
      decor: { type: 'FeatureCollection', features: decor },
      junctions: junctionInfo,
      transitions,
    };
  }
}

// ---- Netzgraph für Simulation und SUMO-Export -------------------------------

export interface GraphSegment {
  id: string;
  road: Road;
  /** Querschnitt in Zeichenrichtung */
  profile: Strip[];
  /** Knoten am Anfang/Ende: nodeKey, Abschnittsgrenze (sec:…) oder offenes Ende (end:…) */
  start: string;
  end: string;
  /** (geglättete) Mittellinie in Zeichenrichtung */
  center: LngLat[];
}

/** Straßennetz als Folge von Segmenten zwischen Knoten — Grundlage für Simulation und Export. */
export function networkGraph(roads: Road[]): { segments: GraphSegment[]; junctions: Set<string> } {
  const hashes = new Map(roads.map((r) => [r, geomHash(r)] as const));
  const nodes = findNodes(roads, hashes);
  const segments = roads.flatMap((road) =>
    segmentRoad(road, nodes).map((s) => {
      const proj = localProjection(s.raw[0]);
      let local = dedupe(s.raw.map(proj.fwd));
      if (road.smooth) local = smoothPolyline(local);
      return {
        id: s.id,
        road,
        profile: s.profile,
        start: s.start ?? `end:${s.id}:a`,
        end: s.end ?? `end:${s.id}:b`,
        center: local.map(proj.inv),
      };
    }),
  );
  return { segments, junctions: new Set(nodes.keys()) };
}
