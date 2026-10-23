/**
 * Richtungsfahrbahnen zusammenführen: OSM erfasst Straßen mit Mittelstreifen als zwei parallele
 * Einbahnstraßen. Gezeichnet sähen sie aus wie zwei Straßen nebeneinander (doppelte Bordsteine,
 * Gehwege im Mittelstreifen, Splitter an jeder Kreuzung). Hier wird jedes solche Paar zu *einer*
 * Straße auf der Mittellinie mit Mittelstreifen; die Kreuzungsknoten beider Fahrbahnen verschmelzen.
 */
import { localProjection, type Vec } from './geometry';
import { makeStrip, reverseProfile, uid, type LngLat, type Strip } from './model';

type Id = number | string;
export interface DualPiece {
  tags: Record<string, string>;
  ids: Id[];
  pts: LngLat[];
  profile: Strip[];
}

const drives = (p: Strip[]) => p.filter((s) => s.type === 'drive' || s.type === 'bus' || s.type === 'tram');
/** Einbahn-Stück: alle Fahrstreifen in einer Richtung */
const oneDir = (p: Strip[]) => {
  const d = drives(p);
  return d.length > 0 && (d.every((s) => s.dir === 1) || d.every((s) => s.dir === -1));
};

/** Stück umdrehen (Punkte, Knoten, Querschnitt) */
const flip = (p: DualPiece): DualPiece => ({ ...p, ids: p.ids.slice().reverse(), pts: p.pts.slice().reverse(), profile: reverseProfile(p.profile) });

interface Stretch {
  pieces: DualPiece[];
  /** Linienzug in lokalen Metern, in Fahrtrichtung */
  line: Vec[];
  cum: number[];
  /** Bogenlänge, an der jedes Stück endet */
  ends: number[];
}

const cumOf = (q: Vec[]) => {
  const c = [0];
  for (let i = 1; i < q.length; i++) c.push(c[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]));
  return c;
};

/** nächster Punkt auf einem Linienzug: Abstand, Bogenlänge, Richtung dort */
function nearest(line: Vec[], cum: number[], p: Vec) {
  let best = { d: Infinity, s: 0, dir: [1, 0] as Vec, q: line[0] };
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    if (l2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    const q: Vec = [a[0] + t * dx, a[1] + t * dy];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < best.d) {
      const l = Math.sqrt(l2);
      best = { d, s: cum[i - 1] + t * l, dir: [dx / l, dy / l], q };
    }
  }
  return best;
}

/** Punkt bei Bogenlänge s */
function at(line: Vec[], cum: number[], s: number): Vec {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const l = cum[i] - cum[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / l));
  return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
}

/** Breite der Fahrbahn (Fahrstreifen samt anliegender Rad-/Parkstreifen) und des inneren Seitenraums */
function widths(p: Strip[]) {
  const cw = p.filter((s) => ['drive', 'bus', 'tram', 'bike', 'parking'].includes(s.type)).reduce((a, s) => a + s.width, 0);
  // innen = links in Fahrtrichtung: Streifen vor dem ersten Fahrbahnstreifen
  let inner = 0;
  for (const s of p) {
    if (['drive', 'bus', 'tram', 'bike', 'parking'].includes(s.type)) break;
    inner += s.width;
  }
  return { cw, inner };
}

export function mergeDualCarriageways(input: DualPiece[], coords: Map<Id, LngLat>, origin: LngLat): DualPiece[] {
  const proj = localProjection(origin);
  let pieces = input.map((p) => (oneDir(p.profile) && drives(p.profile)[0].dir === -1 ? flip(p) : p));

  // ---- Strecken: zusammenhängende Einbahn-Stücke gleichen Namens zwischen Kreuzungen ----
  const use = new Map<Id, number>();
  for (const p of pieces) for (const id of p.ids) use.set(id, (use.get(id) ?? 0) + 1);
  // Auf- und Abfahrten (…_link) nie paaren — sie laufen neben der Hauptfahrbahn und heißen oft gleich
  const oneway = pieces.filter((p) => oneDir(p.profile) && p.tags.name && !p.tags.highway?.endsWith('_link'));
  const startsAt = new Map<Id, DualPiece[]>();
  for (const p of oneway) startsAt.set(p.ids[0], [...(startsAt.get(p.ids[0]) ?? []), p]);
  const hasPrev = new Set<DualPiece>();
  for (const p of oneway) {
    const nx = startsAt.get(p.ids[p.ids.length - 1]) ?? [];
    if (use.get(p.ids[p.ids.length - 1]) === 2 && nx.length === 1 && nx[0].tags.name === p.tags.name) hasPrev.add(nx[0]);
  }
  const stretches: Stretch[] = [];
  for (const first of oneway) {
    if (hasPrev.has(first)) continue;
    const list = [first];
    for (let cur = first; ; ) {
      const end = cur.ids[cur.ids.length - 1];
      const nx = startsAt.get(end) ?? [];
      if (use.get(end) !== 2 || nx.length !== 1 || nx[0].tags.name !== cur.tags.name || list.includes(nx[0])) break;
      list.push((cur = nx[0]));
    }
    const pts = list.flatMap((p, i) => (i ? p.pts.slice(1) : p.pts));
    const line = pts.map(proj.fwd);
    const cum = cumOf(line);
    const ends: number[] = [];
    let n = 0;
    for (const p of list) ends.push(cum[(n += p.pts.length - 1)]);
    if (cum[cum.length - 1] >= 20) stretches.push({ pieces: list, line, cum, ends });
  }

  // ---- Paare: gleicher Name, Gegenrichtung, zu ≥ 75 % in 2,5…40 m Abstand parallel ----
  const cover = (A: Stretch, B: Stretch) => {
    let hit = 0, n = 0;
    const seps: number[] = [];
    for (let s = 2; s < A.cum[A.cum.length - 1] - 2; s += 4) {
      n++;
      const p = at(A.line, A.cum, s);
      const s2 = Math.min(A.cum[A.cum.length - 1], s + 1);
      const p2 = at(A.line, A.cum, s2);
      const dA: Vec = [p2[0] - p[0], p2[1] - p[1]];
      const l = Math.hypot(...dA) || 1;
      const m = nearest(B.line, B.cum, p);
      if (m.d > 2.5 && m.d < 40 && (dA[0] * m.dir[0] + dA[1] * m.dir[1]) / l < -0.7) {
        hit++;
        seps.push(m.d);
      }
    }
    seps.sort((x, y) => x - y);
    return { share: n ? hit / n : 0, sep: seps[Math.floor(seps.length / 2)] ?? 0 };
  };
  const paired = new Set<Stretch>();
  const pairs: { S: Stretch; T: Stretch; sep: number }[] = [];
  /** beste Gegenfahrbahn einer Strecke (kleinster Abstand), ohne schon vergebene */
  const bestFor = (S: Stretch): { T: Stretch; sep: number } | null => {
    let best: { T: Stretch; sep: number } | null = null;
    for (const T of stretches) {
      if (T === S || paired.has(T) || T.pieces[0].tags.name !== S.pieces[0].tags.name) continue;
      // die Enden beider Fahrbahnen müssen zueinander passen (sie werden zu je einem Knoten)
      const near = (x: Vec, y: Vec) => Math.hypot(x[0] - y[0], x[1] - y[1]) < 45;
      if (!near(S.line[0], T.line[T.line.length - 1]) || !near(S.line[S.line.length - 1], T.line[0])) continue;
      const a = cover(S, T), b = cover(T, S);
      if (a.share >= 0.75 && b.share >= 0.75 && (!best || a.sep < best.sep)) best = { T, sep: (a.sep + b.sep) / 2 };
    }
    return best;
  };
  for (const S of stretches) {
    if (paired.has(S)) continue;
    const best = bestFor(S);
    // nur gegenseitig nächste Fahrbahnen bilden ein Paar
    if (best && bestFor(best.T)?.T === S) {
      paired.add(S).add(best.T);
      pairs.push({ S, T: best.T, sep: best.sep });
    }
  }
  if (!pairs.length) return pieces;

  // ---- Paare zusammenführen ----
  const replace = new Map<Id, Id>();
  const removed = new Set<DualPiece>();
  const added: DualPiece[] = [];
  let k = 0;
  /** zwei Knoten zu einem in der Mitte */
  const join = (a: Id, b: Id): Id => {
    const ra = replace.get(a) ?? a, rb = replace.get(b) ?? b;
    if (ra === rb) return ra;
    const [pa, pb] = [coords.get(ra)!, coords.get(rb)!];
    const id = `dual${k++}`;
    coords.set(id, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]);
    for (const [x, y] of replace) if (y === ra || y === rb) replace.set(x, id);
    replace.set(ra, id).set(rb, id).set(a, id).set(b, id);
    return id;
  };
  for (const { S, T, sep } of pairs) {
    const LS = S.cum[S.cum.length - 1];
    // Mittellinie entlang S (Fahrtrichtung von S), alle 3 m
    const mid: Vec[] = [];
    const samples: number[] = [];
    for (let s = 0; s < LS - 1; s += 3) samples.push(s);
    samples.push(LS);
    for (const s of samples) {
      const p = at(S.line, S.cum, s);
      const m = nearest(T.line, T.cum, p);
      mid.push([(p[0] + m.q[0]) / 2, (p[1] + m.q[1]) / 2]);
    }
    const midCum = cumOf(mid);
    const LM = midCum[midCum.length - 1];
    // Querschnittswechsel beider Seiten, auf die Mittellinie umgerechnet (Anteil 0…1)
    const cuts = new Set<number>([0, 1]);
    S.ends.slice(0, -1).forEach((s) => cuts.add(s / LS));
    T.ends.slice(0, -1).forEach((s) => cuts.add(nearest(S.line, S.cum, at(T.line, T.cum, s)).s / LS));
    // Wechsel beider Seiten, die keine 15 m auseinanderliegen, zu einem zusammenfassen (sonst
    // entstehen Stücke von wenigen Metern, nur weil die Seiten minimal versetzt wechseln)
    const fr: number[] = [];
    for (const f of [...cuts].filter((f) => f >= 0 && f <= 1).sort((x, y) => x - y)) if (!fr.length || (f - fr[fr.length - 1]) * LM >= 15) fr.push(f);
    // das letzte Stück reicht immer bis ans Ende (ein Wechsel kurz davor geht im Ende auf)
    if (fr[fr.length - 1] < 1) fr[fr.length - 1] = fr.length > 1 ? 1 : (fr.push(1), 0);
    if (fr[fr.length - 1] !== 1) fr[fr.length - 1] = 1;
    const pieceAtS = (St: Stretch, s: number) => St.pieces[Math.min(St.pieces.length - 1, St.ends.findIndex((e) => e >= s))];
    // Mittelstreifen: Abstand der Linien minus halbe Fahrbahnen und innere Seitenräume
    const wS = widths(S.pieces[0].profile), wT = widths(T.pieces[0].profile);
    const median = Math.max(0.5, Math.min(30, sep - wS.cw / 2 - wT.cw / 2 - wS.inner - wT.inner));
    const treesInside = [...S.pieces, ...T.pieces].some((p) => {
      const inner = p.profile.slice(0, p.profile.findIndex((s) => ['drive', 'bus', 'tram', 'bike', 'parking'].includes(s.type)));
      return inner.some((s) => s.planting === 'trees');
    });
    // Knoten an den Enden verschmelzen: Anfang von S mit Ende von T und umgekehrt
    const start = join(S.pieces[0].ids[0], T.pieces[T.pieces.length - 1].ids[T.pieces[T.pieces.length - 1].ids.length - 1]);
    const end = join(S.pieces[S.pieces.length - 1].ids[S.pieces[S.pieces.length - 1].ids.length - 1], T.pieces[0].ids[0]);
    // je Abschnitt ein Stück: Gegenfahrbahn (gedreht) + Mittelstreifen + Fahrbahn
    let prevId: Id = start;
    for (let i = 0; i < fr.length - 1; i++) {
      const sMid = ((fr[i] + fr[i + 1]) / 2) * LS;
      const sp = pieceAtS(S, sMid);
      const tp = pieceAtS(T, nearest(T.line, T.cum, at(S.line, S.cum, sMid)).s);
      const strip = makeStrip('median', median);
      strip.planting = treesInside ? 'trees' : 'lawn';
      // innere Seitenräume beider Fahrbahnen gehen im Mittelstreifen auf
      const own = (p: Strip[]) => p.slice(p.findIndex((s) => ['drive', 'bus', 'tram', 'bike', 'parking'].includes(s.type)));
      const profile = [...reverseProfile(own(tp.profile)), strip, ...own(sp.profile)].map((s) => ({ ...s, id: uid() }));
      const a = fr[i] * LM, b = fr[i + 1] * LM;
      const seg = mid.filter((_, j) => midCum[j] > a + 0.01 && midCum[j] < b - 0.01);
      const endId: Id = i === fr.length - 2 ? end : `dualm${k++}`;
      if (endId !== end) coords.set(endId, proj.inv(at(mid, midCum, b)));
      const ids = [prevId, ...seg.map(() => `dualp${k++}`), endId];
      const pts = [coords.get(prevId)!, ...seg.map(proj.inv), coords.get(endId)!];
      ids.slice(1, -1).forEach((id, j) => coords.set(id, pts[j + 1]));
      const tags = { ...sp.tags };
      delete tags.oneway;
      added.push({ tags, ids, pts, profile });
      prevId = endId;
    }
    for (const p of [...S.pieces, ...T.pieces]) removed.add(p);
  }
  // übrige Stücke an die verschmolzenen Knoten hängen; Verbindungsstücke zwischen den Fahrbahnen entfallen
  const out: DualPiece[] = [];
  // auch die neuen Straßen: ein Knoten kann später (vom nächsten Paar) noch einmal verschmolzen worden sein
  for (const p of [...pieces, ...added]) {
    if (removed.has(p)) continue;
    const ids = p.ids.map((id) => replace.get(id) ?? id).filter((id, i, l) => i === 0 || id !== l[i - 1]);
    if (ids.length < 2) continue;
    out.push({ ...p, ids, pts: ids.map((id) => coords.get(id)!) });
  }
  return out;
}
