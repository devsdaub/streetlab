// Gemeinsame Regeln für Darstellung und Simulation — genutzt von invariants.mjs (Zufallskreuzungen)
// und osm-test.mjs (echte Straßen aus OpenStreetMap). Erwartet die Bündel in scripts/.build.
const { RoadRenderer, networkGraph } = await import('./.build/render.js');
const { buildNetwork } = await import('./.build/network.js');
const { Simulation } = await import('./.build/sim.js');

// ---------------------------------------------------------------- Geometrie-Helfer
const centroid = (f) => {
  const r = f.geometry.coordinates[0];
  let x = 0, y = 0;
  for (const p of r) (x += p[0]), (y += p[1]);
  return [x / r.length, y / r.length];
};
const bbox = (f) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of f.geometry.coordinates[0]) (a = Math.min(a, x)), (b = Math.min(b, y)), (c = Math.max(c, x)), (d = Math.max(d, y));
  return [a, b, c, d];
};
const inside = (pt, f, bb) => {
  if (pt[0] < bb[0] || pt[0] > bb[2] || pt[1] < bb[1] || pt[1] > bb[3]) return false;
  const r = f.geometry.coordinates[0];
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
/** echte Kreuzung zweier nicht benachbarter Kanten des Rings (in Metern; sichtbar erst ab 25 cm) */
function selfIntersects(ring) {
  const [O] = ring;
  const kx = Math.cos((O[1] * Math.PI) / 180);
  const p = ring.map(([x, y]) => [(x - O[0]) * 111320 * kx, (y - O[1]) * 111320]);
  const n = p.length - 1;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [a, b, c, d] = [p[i], p[i + 1], p[j], p[j + 1]];
      const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
      const la = Math.hypot(b[0] - a[0], b[1] - a[1]), lc = Math.hypot(d[0] - c[0], d[1] - c[1]);
      if (la < 0.05 || lc < 0.05) continue;
      if (d1 * d2 < 0 && d3 * d4 < 0 && Math.min(Math.abs(d1), Math.abs(d2)) / lc > 0.25 && Math.min(Math.abs(d3), Math.abs(d4)) / la > 0.25) return true;
    }
  return false;
}
const surfaceType = (f) => f.properties.kind ?? f.properties.type;

// ---------------------------------------------------------------- Prüfungen
const WALK = new Set(['sidewalk', 'green', 'median', 'island']);
const DRIVE = new Set(['drive', 'bus', 'tram', 'bike', 'furt', 'parking', 'asphalt']);

export function checkRender(p) {
  const errs = [];
  const built = new RoadRenderer().build(p.roads, p.junctions);
  const surf = built.surfaces.features.map((f) => ({ f, bb: bbox(f), t: surfaceType(f), morph: !!f.properties.transition }));
  const under = (pt) => surf.filter((s) => inside(pt, s.f, s.bb));
  for (const m of built.markings.features) {
    const k = m.properties.kind;
    if (!k || k === 'crossing') continue;
    const c = centroid(m), u = under(c);
    const bad = u.find((s) => WALK.has(s.t));
    if (bad) errs.push(`${k} auf ${bad.t}`);
    if ((k === 'zebra' || k === 'stopline') && u.some((s) => s.morph)) errs.push(`${k} in Verziehung`);
    if (!u.length) errs.push(`${k} außerhalb jeder Fläche`);
  }
  // Kreuzungsflächen dürfen sich nicht selbst überschneiden (gefaltete Ecken, Keile)
  for (const f of built.surfaces.features) {
    if (!f.properties.node) continue;
    if (selfIntersects(f.geometry.coordinates[0])) errs.push(`Kreuzungsfläche (${surfaceType(f)}) überschneidet sich selbst`);
  }
  // Radfurten dürfen sich kreuzen, aber nicht längs übereinanderliegen (Spaghetti in der Kreuzung)
  const furts = built.surfaces.features.filter((f) => f.properties.node && f.properties.kind === 'furt').map((f) => ({ f, bb: bbox(f) }));
  for (let i = 0; i < furts.length; i++)
    for (let j = 0; j < furts.length; j++) {
      const [A, B] = [furts[i], furts[j]];
      if (i === j || A.f.properties.node !== B.f.properties.node) continue;
      const ring = A.f.geometry.coordinates[0];
      const share = ring.filter((p) => inside(p, B.f, B.bb)).length / ring.length;
      if (share > 0.33) errs.push(`Radfurten überlagern sich (${Math.round(share * 100)} %)`);
    }
  // höchstens eine gemalte Furt je Rad-Zufahrt (sonst fächern sie auf)
  for (const [node, info] of built.junctions ?? []) {
    const bikeIns = info.lanes.filter((l) => l.bike && l.kind === 'in').length;
    const n = furts.filter((x) => x.f.properties.node === node).length;
    if (n > bikeIns) errs.push(`mehr Radfurten (${n}) als Rad-Zufahrten (${bikeIns})`);
  }
  for (const d of built.decor.features) {
    if (d.properties.kind !== 'sign') continue;
    const bad = under(centroid(d)).find((s) => DRIVE.has(s.t));
    if (bad) errs.push(`Schild/Ampel auf ${bad.t}`);
  }
  return { errs, built };
}

/** Länge einer Polylinie in Längen-/Breitengrad, in Metern */
const lengthM = (pts) => {
  let l = 0;
  for (let i = 1; i < pts.length; i++) {
    const k = Math.cos((pts[i][1] * Math.PI) / 180);
    l += Math.hypot((pts[i][0] - pts[i - 1][0]) * 111320 * k, (pts[i][1] - pts[i - 1][1]) * 111320);
  }
  return l;
};
/** Fläche und Umfang eines Rings in m² bzw. m */
const areaPerimeter = (ring) => {
  const [O] = ring;
  const kx = Math.cos((O[1] * Math.PI) / 180);
  const q = ring.map(([x, y]) => [(x - O[0]) * 111320 * kx, (y - O[1]) * 111320]);
  let a = 0, per = 0;
  for (let i = 1; i < q.length; i++) {
    a += q[i - 1][0] * q[i][1] - q[i][0] * q[i - 1][1];
    per += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
  }
  return [Math.abs(a / 2), per];
};
/** Querschnitt unabhängig von der Zeichenrichtung vergleichbar */
const profileSig = (prof) => {
  const f = prof.map((x) => `${x.type}${x.width.toFixed(2)}${x.dir}${x.planting ?? ''}${x.parkAngle ?? ''}`).join('|');
  const b = prof.slice().reverse().map((x) => `${x.type}${x.width.toFixed(2)}${-x.dir}${x.planting ?? ''}${x.parkAngle ?? ''}`).join('|');
  return f < b ? f : b;
};

/**
 * Bildqualität des Netzes — was im Luftbild sofort „kaputt“ aussieht: Splitterflächen, zu dichte
 * Kreuzungen, Querschnitte, die nur kurz gelten, Schilder auf der Fahrbahn.
 * strict: auch Planungsfragen melden (für den OSM-Import; beim Zeichnen entscheidet der Mensch).
 */
export function checkQuality(p, built, strict = false) {
  const errs = [];
  // Splitter: mittlere Breite (2·Fläche/Umfang) unter 0,3 m bei mehr als 3 m Umfang
  for (const f of built.surfaces.features) {
    const [a, per] = areaPerimeter(f.geometry.coordinates[0]);
    if (per > 3 && (2 * a) / per < 0.3) errs.push(`Splitterfläche (${surfaceType(f)}, ${per.toFixed(0)} m Umfang)`);
  }
  // Schilder (Tempo, Vorfahrt, Ampel) nie auf Fahrbahn oder Kreuzungsfläche
  const drive = built.surfaces.features.filter((f) => DRIVE.has(surfaceType(f))).map((f) => ({ f, bb: bbox(f) }));
  for (const d of built.decor.features) {
    if (d.properties.kind !== 'sign') continue;
    const c = centroid(d);
    const hit = drive.find((x) => inside(c, x.f, x.bb));
    if (hit) errs.push(`Schild auf ${surfaceType(hit.f)}${d.properties.node ? '' : ' (Tempo)'}`);
  }
  const { segments } = networkGraph(p.roads);
  const degree = new Map();
  for (const s of segments) for (const k of [s.start, s.end]) degree.set(k, (degree.get(k) ?? 0) + 1);
  const isJunction = (k) => !k.startsWith('end:') && !k.startsWith('sec:') && (degree.get(k) ?? 0) >= 3;
  // offenes Straßenende dicht neben einer anderen Straße: Lücke im Netz (sollte verbunden sein)
  {
    const toM = (o) => { const k = Math.cos((o[1] * Math.PI) / 180); return (q) => [(q[0] - o[0]) * 111320 * k, (q[1] - o[1]) * 111320]; };
    for (const s of segments)
      for (const [key, q] of [[s.start, s.center[0]], [s.end, s.center[s.center.length - 1]]]) {
        if (!key.startsWith('end:')) continue;
        const f = toM(q);
        for (const o of segments) {
          if (o === s || o.road === s.road) continue;
          const pts = o.center.map(f);
          let d = Infinity;
          for (let i = 1; i < pts.length; i++) {
            const [a, b] = [pts[i - 1], pts[i]];
            const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, (-a[0] * dx - a[1] * dy) / l2));
            d = Math.min(d, Math.hypot(a[0] + t * dx, a[1] + t * dy));
          }
          if (d < 8) {
            errs.push(`Straßenende neben anderer Straße (${s.road.name} → ${o.road.name}, ${d.toFixed(1)} m)`);
            break;
          }
        }
      }
  }
  // zwei Kreuzungen dicht hintereinander (versetzte Kreuzung aus zwei OSM-Knoten)
  for (const s of segments)
    if (isJunction(s.start) && isJunction(s.end) && lengthM(s.center) < 8) errs.push(`Kreuzungen zu dicht (${lengthM(s.center).toFixed(1)} m)`);
  if (strict) {
    // Querschnitt, der nur auf einem kurzen Stück gilt (davor und danach ein anderer)
    const at = new Map();
    for (const s of segments) for (const k of [s.start, s.end]) at.set(k, [...(at.get(k) ?? []), s]);
    for (const s of segments) {
      if (isJunction(s.start) || isJunction(s.end) || lengthM(s.center) >= 30) continue;
      const other = (k) => (at.get(k) ?? []).filter((x) => x !== s);
      const nb = [...other(s.start), ...other(s.end)];
      if (nb.length === 2 && nb.every((x) => profileSig(x.profile) !== profileSig(s.profile))) errs.push(`Querschnitt nur ${lengthM(s.center).toFixed(0)} m lang (${s.road.name})`);
    }
  }
  return errs;
}

export function checkSim(p, built, steps = 6000) {
  const errs = [];
  const net = buildNetwork(p, built.junctions);
  const sim = new Simulation(net);
  sim.flow = 500;
  // Sackgassen: Spur endet an einem Knoten ohne Weiterfahrt → Fahrzeug verschwindet mitten im Netz
  const nodeById = new Map([...net.nodes.values()].map((n) => [n.id, n]));
  for (const t of sim.tracks ?? sim['tracks'])
    if (t.lane && !t.lane.outs.length && nodeById.get(t.lane.edge.to)?.kind !== 'end' && t.lane.lane.cls === 'car' && (t.feeders?.length || nodeById.get(t.lane.edge.from)?.kind === 'end')) errs.push(`Kfz-Spur ohne Weiterfahrt (${t.id})`);
  const seen = new Set();
  const frontSince = new Map();
  const once = (k, msg) => !seen.has(k) && (seen.add(k), errs.push(msg));
  for (let i = 0; i < steps; i++) {
    sim.step(0.1);
    if (i % 10) continue;
    const vs = sim.vehicles.filter((v) => v.kind !== 'bike');
    const body = vs.map((v) => {
      const f = sim.pointBehind(v, 0.3), m = sim.pointBehind(v, v.len / 2), b = sim.pointBehind(v, v.len - 0.3);
      const h = [f[0] - b[0], f[1] - b[1]], l = Math.hypot(...h) || 1;
      return { v, pts: [f, m, b], h: [h[0] / l, h[1] / l] };
    });
    for (let a = 0; a < body.length; a++)
      for (let b = a + 1; b < body.length; b++) {
        const A = body[a], B = body[b];
        if (A.h[0] * B.h[0] + A.h[1] * B.h[1] < 0.5) continue; // nur gleiche Fahrtrichtung (Auffahren)
        const dmin = Math.min(...A.pts.flatMap((x) => B.pts.map((y) => Math.hypot(x[0] - y[0], x[1] - y[1]))));
        if (dmin < 1.0) once(`c${A.v.id}-${B.v.id}`, `Zusammenstoß ${A.v.kind}/${B.v.kind} bei t=${sim.time.toFixed(0)} s (${A.v.track.id} / ${B.v.track.id})`);
      }
    for (const v of sim.vehicles) {
      const ex = v.track.lane ? v.exit : null;
      if (ex && v.v < 0.1 && v.cleared !== ex && v.s > ex.stop + 0.5 && ex.at - ex.stop > 1)
        once(`s${v.id}`, `hält hinter der Haltlinie (${v.track.id}, ${(v.s - ex.stop).toFixed(1)} m)`);
      // Wartezeit vorn an der Haltlinie bzw. am Kreuzungsrand (nicht im Stau dahinter)
      const atFront = ex && v.v < 0.1 && (ex.stop - v.s < 4 || (v.cleared === ex && ex.at - v.s < 4));
      if (!atFront) frontSince.delete(v);
      else {
        if (!frontSince.has(v)) frontSince.set(v, sim.time);
        if (sim.time - frontSince.get(v) > 150) once(`w${v.id}`, `wartet über 150 s an der Linie (${v.track.id}, ${sim.blockedBy(v, ex.conn, 0)})`);
      }
    }
  }
  if (sim.stats().arrived < 5) errs.push(`kaum Verkehr angekommen (${sim.stats().arrived})`);
  return errs;
}
