/** Simulation im Browser: Ablauf, Darstellung der Fahrzeuge und Ampeln, Kennzahlen. */
import type { Feature, Polygon } from 'geojson';
import type { Map as MapLibre } from 'maplibre-gl';
import type { Vec } from './geometry';
import { bus, car, cyclist, tram, truck, van, type Shape } from './glyphs';
import { EMPTY, setData } from './map';
import { buildNetwork } from './network';
import type { Built } from './render';
import { Simulation, type SimStats, type VehicleKind } from './sim';
import type { Store } from './store';

const CAR_COLORS = ['#e2e3e4', '#e2e3e4', '#c9ccd0', '#2e3033', '#8e959c', '#9b2c2c', '#2c4a7a', '#f1efe9', '#3d5c3a'];
/** Gelenkfahrzeuge: Glieder als [Anfang, Ende] in Metern hinter der Front */
const ARTICULATED: Partial<Record<VehicleKind, [number, number][]>> = {
  tram: [[0, 10.1], [10.1, 20.3], [20.3, 30]],
};
const SIGNAL ={ green: '#2fbf71', amber: '#f5b82e', red: '#e5383b' } as const;

export class SimView {
  sim: Simulation | null = null;
  running = false;
  /** Zeitraffer */
  speed = 1;
  /** Kfz je Stunde und Zufahrtsspur */
  flow = 400;
  /** wird bei jeder Zustandsänderung gerufen (Seitenleiste, Werkzeugleiste) */
  onChange = () => {};
  /** wird etwa alle 0,5 s mit Kennzahlen gerufen */
  onStats = (_s: SimStats) => {};

  private raf = 0;
  private last = 0;
  private statsAt = 0;
  private shapes = new Map<VehicleKind, (color: string) => Shape[]>([
    ['car', (c) => car(c)],
    ['van', (c) => van(c)],
    ['truck', () => truck()],
    ['bus', () => bus('#d9443b')],
    ['bike', () => cyclist()],
    ['tram', () => tram()],
  ]);
  private cache = new Map<string, Shape[]>();

  constructor(
    private map: MapLibre,
    private store: Store,
    private getBuilt: () => Built,
  ) {}

  /** Netz neu aufbauen (nach Änderungen am Entwurf); läuft weiter, wenn es lief */
  rebuild() {
    if (!this.sim) return;
    const net = buildNetwork(this.store.project, this.getBuilt().junctions);
    const time = this.sim.time;
    this.sim = new Simulation(net);
    this.sim.flow = this.flow;
    this.sim.time = time;
    this.draw();
  }

  start() {
    if (!this.sim) {
      this.sim = new Simulation(buildNetwork(this.store.project, this.getBuilt().junctions));
      this.sim.flow = this.flow;
    }
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running || !this.sim) return;
      // Echtzeit × Zeitraffer, in festen Schritten von 0,1 s
      let dt = Math.min(0.25, (now - this.last) / 1000) * this.speed;
      this.last = now;
      while (dt > 1e-6) {
        const h = Math.min(0.1, dt);
        this.sim.step(h);
        dt -= h;
      }
      this.draw();
      if (now - this.statsAt > 500) {
        this.statsAt = now;
        this.onStats(this.sim.stats());
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.onChange();
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.onChange();
  }

  /** Simulation beenden und Fahrzeuge entfernen */
  stop() {
    this.pause();
    this.sim = null;
    setData(this.map, 'sim', EMPTY);
    this.onChange();
  }

  setFlow(v: number) {
    this.flow = v;
    if (this.sim) this.sim.flow = v;
  }

  /** Simuliert ohne Anzeige (für Tests und schnelles Vorspulen) */
  fastForward(seconds: number) {
    if (!this.sim) this.start();
    for (let t = 0; t < seconds; t += 0.1) this.sim!.step(0.1);
    this.draw();
    this.onStats(this.sim!.stats());
  }

  private shapesFor(kind: VehicleKind, id: number): Shape[] {
    const color = CAR_COLORS[id % CAR_COLORS.length];
    const key = `${kind}|${kind === 'car' || kind === 'van' ? color : ''}`;
    let s = this.cache.get(key);
    if (!s) this.cache.set(key, (s = this.shapesFor0(kind, color)));
    return s;
  }
  private shapesFor0(kind: VehicleKind, color: string) {
    return this.shapes.get(kind)!(color);
  }

  private draw() {
    const sim = this.sim;
    if (!sim) return;
    const toLL = sim.net.toLngLat;
    const features: Feature<Polygon>[] = [];
    const push = (pts: Vec[], color: string, rank: number) =>
      features.push({ type: 'Feature', properties: { color, rank }, geometry: { type: 'Polygon', coordinates: [pts.map(toLL)] } });
    for (const v of sim.vehicles) {
      // Glieder (Abstand von der Front): jedes Glied liegt als Sehne auf dem gefahrenen Weg
      const parts = ARTICULATED[v.kind] ?? [[0, v.len]];
      const frames = parts.map(([a, b]) => {
        const pa = sim.pointBehind(v, a), pb = sim.pointBehind(v, b);
        const l = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) || 1;
        const h: Vec = [(pa[0] - pb[0]) / l, (pa[1] - pb[1]) / l];
        return { a, pa, h, n: [-h[1], h[0]] as Vec };
      });
      for (const sh of this.shapesFor(v.kind, v.id)) {
        // Formen sind auf die Fahrzeugmitte bezogen (x nach vorn); Glied nach der Lage der Form
        const cx = sh.pts.reduce((s, q) => s + q[0], 0) / sh.pts.length;
        const dc = v.len / 2 - cx;
        const f = frames.find((_, i) => dc <= parts[i][1]) ?? frames[frames.length - 1];
        push(
          sh.pts.map(([x, y]) => {
            const back = v.len / 2 - x - f.a;
            return [f.pa[0] - f.h[0] * back + f.n[0] * y, f.pa[1] - f.h[1] * back + f.n[1] * y] as Vec;
          }),
          sh.color,
          (sh.rank ?? 2) + 10,
        );
      }
    }
    // Ampeln: farbiger Punkt an der Haltelinie jeder Zufahrtsspur
    for (const s of sim.signalHeads()) {
      const ring = Array.from({ length: 13 }, (_, i) => {
        const a = (i / 12) * 2 * Math.PI;
        return [s.pos[0] + 0.55 * Math.cos(a), s.pos[1] + 0.55 * Math.sin(a)] as Vec;
      });
      push(ring, SIGNAL[s.state], 30);
    }
    setData(this.map, 'sim', { type: 'FeatureCollection', features });
  }
}
