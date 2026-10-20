import {
  ensureSection,
  insertPoint,
  makeStrip,
  sectionAt,
  sectionProfile,
  setSectionProfile,
  type LngLat,
  type Road,
} from './model';
import { nodeKey } from './render';

/** Zufahrt zu einem Knoten: eine Straße, die von einer Seite in den Knoten mündet */
export interface Approach {
  road: Road;
  /** Index des Knotens in road.points */
  nodeIdx: number;
  /** true = Verkehr kommt aus Richtung Straßenanfang (fährt in Zeichenrichtung zu) */
  back: boolean;
  label: string;
}

const M = 111320;
const meters = (a: LngLat, b: LngLat) => {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * M * k, (b[1] - a[1]) * M);
};

const COMPASS = ['Osten', 'Nordosten', 'Norden', 'Nordwesten', 'Westen', 'Südwesten', 'Süden', 'Südosten'];

export function approachesAt(roads: Road[], key: string): Approach[] {
  const out: Approach[] = [];
  for (const road of roads) {
    road.points.forEach((p, i) => {
      if (nodeKey(p) !== key) return;
      for (const back of [true, false]) {
        const j = back ? i - 1 : i + 1;
        if (j < 0 || j >= road.points.length) continue;
        const q = road.points[j];
        const k = Math.cos((p[1] * Math.PI) / 180);
        const ang = Math.atan2(q[1] - p[1], (q[0] - p[0]) * k);
        const dir = COMPASS[(Math.round(ang / (Math.PI / 4)) + 8) % 8];
        out.push({ road, nodeIdx: i, back, label: `${road.name} aus ${dir}` });
      }
    });
  }
  return out;
}

/**
 * Fügt vor dem Knoten eine Abbiegespur ein: Die Straße wird `length` Meter vor dem Knoten
 * geteilt, im knotennahen Abschnitt kommt ein Fahrstreifen mit Abbiegepfeil hinzu.
 * Die Verziehung entsteht automatisch an der neuen Abschnittsgrenze.
 */
export function addTurnLane(a: Approach, turn: 'left' | 'right', length = 50): boolean {
  const { road } = a;
  let nodeIdx = a.nodeIdx;
  const step = a.back ? -1 : 1;

  // Teilungspunkt `length` Meter vom Knoten entfernt suchen (oder vorhandenen Punkt nutzen)
  let total = 0;
  for (let j = nodeIdx; j + step >= 0 && j + step < road.points.length; j += step) total += meters(road.points[j], road.points[j + step]);
  const target = Math.min(length, total * 0.6);
  let acc = 0;
  let splitIdx = -1;
  for (let j = nodeIdx; j + step >= 0 && j + step < road.points.length; j += step) {
    const p = road.points[j], q = road.points[j + step];
    const d = meters(p, q);
    if (acc + d >= target - 3) {
      if (Math.abs(acc + d - target) <= 3) splitIdx = j + step;
      else {
        const t = (target - acc) / d;
        const x: LngLat = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        const at = a.back ? j : j + 1;
        insertPoint(road, at, x);
        if (a.back) nodeIdx++;
        splitIdx = at;
      }
      break;
    }
    acc += d;
  }
  if (splitIdx < 0) return false;

  const [lo, hi] = a.back ? [splitIdx, nodeIdx] : [nodeIdx, splitIdx];
  ensureSection(road, hi);
  ensureSection(road, lo);
  const sec = sectionAt(road, lo);

  // Fahrstreifen einfügen: Linksabbieger zur Fahrbahnmitte, Rechtsabbieger an den Rand
  const dir: 1 | -1 = a.back ? 1 : -1;
  const profile = structuredClone(sectionProfile(road, sec));
  const lanes = profile.map((s, i) => (s.type === 'drive' && s.dir === dir ? i : -1)).filter((i) => i >= 0);
  if (!lanes.length) return false;
  // in Fahrtrichtung links = im Profil links bei dir +1, rechts bei dir −1
  const towardLeft = (turn === 'left') === (dir === 1);
  const at = towardLeft ? lanes[0] : lanes[lanes.length - 1] + 1;
  for (const i of lanes) profile[i].turn ??= 'straight';
  const lane = makeStrip('drive', 3.0, dir);
  lane.turn = turn;
  profile.splice(at, 0, lane);
  setSectionProfile(road, sec, profile);
  return true;
}
