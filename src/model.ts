export type LngLat = [number, number];

export type StripType =
  | 'drive'
  | 'bus'
  | 'bike'
  | 'parking'
  | 'sidewalk'
  | 'green'
  | 'median'
  | 'tram';

/** Linie an der rechten Kante eines Streifens (zum nächsten Streifen hin). */
export type LineStyle = 'auto' | 'none' | 'dashed' | 'solid' | 'wide';

export interface Strip {
  id: string;
  type: StripType;
  /** Breite in Metern */
  width: number;
  /** 1 = in Zeichenrichtung, -1 = entgegen */
  dir: 1 | -1;
  lineRight: LineStyle;
  /** Bepflanzung von Grünstreifen und Mittelinseln */
  planting?: Planting;
  /** Abbiegepfeile vor der Kreuzung (Fahrstreifen) */
  turn?: Turn;
}

export type Planting = 'lawn' | 'trees' | 'bushes' | 'flowers' | 'mixed';

export const PLANTING_LABELS: Record<Planting, string> = {
  trees: 'Bäume',
  mixed: 'Bäume + Büsche',
  bushes: 'Büsche',
  flowers: 'Blumen',
  lawn: 'Rasen',
};

export interface Road {
  id: string;
  name: string;
  /** Mittellinie in Zeichenrichtung */
  points: LngLat[];
  /** Querschnitt von links nach rechts (in Zeichenrichtung gesehen) — gilt ab Punkt 0 */
  profile: Strip[];
  /** weitere Abschnitte: ab Stützpunkt `index` gilt `profile` (aufsteigend sortiert) */
  sections?: Section[];
  smooth: boolean;
}

export interface Section {
  index: number;
  profile: Strip[];
  /** Länge der Verziehung zum vorigen Abschnitt (m), sonst automatisch */
  transition?: number;
}

export type Turn = 'straight' | 'left' | 'right' | 'left-straight' | 'right-straight' | 'left-right' | 'all';

export const TURN_LABELS: Record<Turn, string> = {
  straight: 'Geradeaus',
  left: 'Links',
  right: 'Rechts',
  'left-straight': 'Links und geradeaus',
  'right-straight': 'Rechts und geradeaus',
  'left-right': 'Links und rechts',
  all: 'Alle Richtungen',
};

// ---- Abschnitte -----------------------------------------------------------

/** Querschnitt, der ab Stützpunkt i gilt */
export function profileAt(road: Road, i: number): Strip[] {
  let p = road.profile;
  for (const s of road.sections ?? []) if (s.index <= i) p = s.profile;
  return p;
}

/** Abschnittsnummer (0 = Anfang) ab Stützpunkt i */
export function sectionAt(road: Road, i: number): number {
  let k = 0;
  (road.sections ?? []).forEach((s, n) => {
    if (s.index <= i) k = n + 1;
  });
  return k;
}

/** Querschnitt von Abschnitt k lesen/schreiben (0 = Grundquerschnitt) */
export const sectionProfile = (road: Road, k: number) => (k === 0 ? road.profile : road.sections![k - 1].profile);
export function setSectionProfile(road: Road, k: number, p: Strip[]) {
  if (k === 0) road.profile = p;
  else road.sections![k - 1].profile = p;
}

/** Stützpunkt einfügen und Abschnittsgrenzen mitführen */
export function insertPoint(road: Road, i: number, p: LngLat) {
  road.points.splice(i, 0, p);
  for (const s of road.sections ?? []) if (s.index >= i) s.index++;
}

/** Stützpunkt entfernen; eine dort beginnende Abschnittsgrenze entfällt */
export function removePoint(road: Road, i: number) {
  road.points.splice(i, 1);
  if (!road.sections) return;
  road.sections = road.sections.filter((s) => s.index !== i);
  for (const s of road.sections) if (s.index > i) s.index--;
  if (!road.sections.length) delete road.sections;
}

/** Abschnittsgrenze an Stützpunkt i sicherstellen (Querschnitt bleibt zunächst gleich) */
export function ensureSection(road: Road, i: number): number {
  if (i <= 0 || i >= road.points.length - 1) return sectionAt(road, i);
  const list = (road.sections ??= []);
  if (!list.some((s) => s.index === i)) {
    list.push({ index: i, profile: structuredClone(profileAt(road, i)).map((s) => ({ ...s, id: uid() })) });
    list.sort((a, b) => a.index - b.index);
  }
  return sectionAt(road, i);
}

export interface Project {
  version: 1;
  name: string;
  roads: Road[];
  view?: { center: LngLat; zoom: number };
  basemap?: string;
  /** Markierungsstil: Deutschland (weiß) oder USA (gelbe Mittellinie) */
  markingStyle?: MarkingStyle;
  /**
   * Streifen-Zuordnung an Verziehungen (wie Spurverbindungen): „Grenze|Streifen-ID“ → ID des
   * Streifens, in den er übergeht, oder "" = endet bzw. entsteht neu. Wird in beide Richtungen eingetragen.
   */
  stripLinks?: Record<string, string>;
  /** Fahrzeuge, Radfahrer und Fußgänger als Belebung zeigen */
  traffic?: boolean;
  /** Einstellungen je Knotenpunkt, Schlüssel = nodeKey */
  junctions?: Record<string, JunctionSettings>;
}

export type MarkingStyle = 'de' | 'us';

export type Crossing = 'none' | 'zebra' | 'furt';

export type JunctionKind = 'cross' | 'roundabout' | 'mini';

/** Verkehrsregelung am Knoten */
export type Control = 'none' | 'stoplines' | 'priority' | 'signals' | 'allstop';

/** Rolle einer Zufahrt bei „Vorfahrt geregelt“ */
export type ArmRole = 'main' | 'yield' | 'stop';

export interface JunctionSettings {
  kind: JunctionKind;
  /** Bordsteinradius an den Ecken bzw. Ein-/Ausfahrradius beim Kreisverkehr (m) */
  radius: number;
  /** Querung für alle Arme (einzelne Arme können abweichen) */
  crossing: Crossing;
  /** Querung je Arm, Schlüssel = Arm-ID (`roadId:f|b`) */
  armCrossing?: Record<string, Crossing>;
  bikeCrossing: boolean;
  /** veraltet: früher „Haltlinien an/aus“, wird zu control übersetzt */
  stopLines: boolean;
  control?: Control;
  /** Rollen je Arm bei control = 'priority' */
  roles?: Record<string, ArmRole>;
  /** Spurverbindungen: Zufahrtsstreifen-ID → Ausfahrtsstreifen-IDs (sonst automatisch) */
  connections?: Record<string, string[]>;
  /** Abbiegeleitlinien (gestrichelt) in der Kreuzung zeichnen */
  guides?: boolean;
  /** Kreisverkehr: Außenradius der Kreisfahrbahn (m) */
  rbRadius: number;
  /** Kreisverkehr: Breite der Kreisfahrbahn (m) */
  rbLane: number;
  /** Kreisverkehr: Fahrstreifen im Kreis */
  rbLanes?: 1 | 2;
  /** Durchgangsknoten mit Querschnittswechsel: Länge der Verziehung (m) */
  transition?: number;
}

export const defaultJunction = (): JunctionSettings => ({
  kind: 'cross',
  radius: 6,
  crossing: 'none',
  bikeCrossing: true,
  stopLines: true,
  control: 'stoplines',
  rbRadius: 15,
  rbLane: 6.5,
  rbLanes: 1,
});

/** effektive Regelung — ältere Projekte kennen nur stopLines */
export const controlOf = (st: JunctionSettings): Control => st.control ?? (st.stopLines ? 'stoplines' : 'none');

export const CONTROL_LABELS: Record<Control, string> = {
  none: 'Rechts vor links',
  stoplines: 'Haltlinien',
  priority: 'Vorfahrt per Schild',
  signals: 'Ampel',
  allstop: 'Stopp an allen Zufahrten',
};

export const ROLE_LABELS: Record<ArmRole, string> = {
  main: 'Vorfahrt',
  yield: 'Vorfahrt gewähren',
  stop: 'Stopp',
};

export const KIND_LABELS: Record<JunctionKind, string> = {
  cross: 'Kreuzung',
  roundabout: 'Kreisverkehr',
  mini: 'Mini-Kreisel',
};

export const CROSSING_LABELS: Record<Crossing, string> = {
  none: 'keine Querung',
  zebra: 'Zebrastreifen',
  furt: 'Fußgängerfurt (Ampel)',
};

export interface StripTypeInfo {
  label: string;
  color: string;
  width: number;
  /** liegt auf Fahrbahnniveau (sonst Bordstein dazwischen) */
  carriageway: boolean;
  directional: boolean;
  rank: number;
  /** hat Bepflanzung */
  planted?: boolean;
}

export const STRIP_TYPES: Record<StripType, StripTypeInfo> = {
  drive: { label: 'Fahrstreifen', color: '#434345', width: 3.25, carriageway: true, directional: true, rank: 5 },
  bus: { label: 'Busstreifen', color: '#9b3b36', width: 3.5, carriageway: true, directional: true, rank: 5 },
  tram: { label: 'Stadtbahn/Metro', color: '#8f8f8c', width: 3.2, carriageway: true, directional: true, rank: 5 },
  bike: { label: 'Radweg', color: '#179c4c', width: 2.0, carriageway: true, directional: true, rank: 4 },
  parking: { label: 'Parken', color: '#434345', width: 2.0, carriageway: true, directional: false, rank: 3 },
  median: { label: 'Mittelinsel', color: '#d3bba1', width: 2.0, carriageway: false, directional: false, rank: 2, planted: true },
  sidewalk: { label: 'Gehweg', color: '#d3bba1', width: 2.5, carriageway: false, directional: false, rank: 1 },
  green: { label: 'Grünstreifen', color: '#5f7046', width: 2.0, carriageway: false, directional: false, rank: 1, planted: true },
};

export const LINE_LABELS: Record<LineStyle, string> = {
  auto: 'Automatisch',
  none: 'keine Linie',
  dashed: 'Leitlinie (gestrichelt)',
  solid: 'durchgezogen',
  wide: 'Breitstrich',
};

export const uid = () => Math.random().toString(36).slice(2, 10);

type StripSpec = [StripType, number?, (1 | -1)?, Planting?];

export type PresetCategory = 'Wohnen' | 'Hauptverkehr' | 'ÖPNV' | 'Rad und Fuß' | 'Außerorts';
export const PRESET_CATEGORIES: PresetCategory[] = ['Wohnen', 'Hauptverkehr', 'ÖPNV', 'Rad und Fuß', 'Außerorts'];

/** Querschnitts-Vorlagen (Reihenfolge der ersten Einträge bleibt stabil) */
export const PRESETS: { name: string; category: PresetCategory; strips: StripSpec[] }[] = [
  { name: 'Wohnstraße, beidseitig Parken', category: 'Wohnen', strips: [['sidewalk', 2.5], ['parking'], ['drive', 3.0, -1], ['drive', 3.0, 1], ['parking'], ['sidewalk', 2.5]] },
  { name: 'Hauptstraße 2+2', category: 'Hauptverkehr', strips: [['sidewalk', 3.0], ['drive', 3.25, -1], ['drive', 3.25, -1], ['drive', 3.25, 1], ['drive', 3.25, 1], ['sidewalk', 3.0]] },
  { name: 'Hauptstraße mit Radstreifen', category: 'Hauptverkehr', strips: [['sidewalk', 2.5], ['bike', 2.0, -1], ['drive', 3.25, -1], ['drive', 3.25, 1], ['bike', 2.0, 1], ['sidewalk', 2.5]] },
  { name: 'Allee mit Mittelinsel', category: 'Hauptverkehr', strips: [['sidewalk', 3.0], ['green', 2.5], ['drive', 3.25, -1], ['median', 3.0], ['drive', 3.25, 1], ['green', 2.5], ['sidewalk', 3.0]] },
  { name: 'Umweltspur (Bus und Rad)', category: 'ÖPNV', strips: [['sidewalk', 2.5], ['bus', 3.5, -1], ['drive', 3.25, -1], ['drive', 3.25, 1], ['bus', 3.5, 1], ['sidewalk', 2.5]] },
  { name: 'Fahrradstraße', category: 'Rad und Fuß', strips: [['sidewalk', 2.5], ['parking'], ['bike', 2.5, -1], ['bike', 2.5, 1], ['parking'], ['sidewalk', 2.5]] },
  { name: 'Einbahnstraße mit Gegenrichtungsradeln', category: 'Wohnen', strips: [['sidewalk', 2.5], ['parking'], ['drive', 3.5, 1], ['bike', 1.5, -1], ['sidewalk', 2.5]] },
  { name: 'Wohnstraße ohne Parken', category: 'Wohnen', strips: [['sidewalk', 2.5], ['drive', 3.0, -1], ['drive', 3.0, 1], ['sidewalk', 2.5]] },
  { name: 'Wohnstraße, einseitig Parken', category: 'Wohnen', strips: [['sidewalk', 2.5], ['parking'], ['drive', 3.0, -1], ['drive', 3.0, 1], ['sidewalk', 2.5]] },
  { name: 'Wohnstraße mit Baumreihen', category: 'Wohnen', strips: [['sidewalk', 2.5], ['green', 2.0, 1, 'trees'], ['parking'], ['drive', 3.0, -1], ['drive', 3.0, 1], ['parking'], ['green', 2.0, 1, 'trees'], ['sidewalk', 2.5]] },
  { name: 'Einbahnstraße, zwei Fahrstreifen', category: 'Wohnen', strips: [['sidewalk', 2.5], ['parking'], ['drive', 3.0, 1], ['drive', 3.0, 1], ['parking'], ['sidewalk', 2.5]] },
  { name: 'Hauptstraße mit geschütztem Radweg', category: 'Hauptverkehr', strips: [['sidewalk', 2.5], ['bike', 2.25, -1], ['green', 1.0, 1, 'bushes'], ['drive', 3.25, -1], ['drive', 3.25, 1], ['green', 1.0, 1, 'bushes'], ['bike', 2.25, 1], ['sidewalk', 2.5]] },
  { name: 'Hauptstraße, Parken und Radstreifen', category: 'Hauptverkehr', strips: [['sidewalk', 2.5], ['parking'], ['bike', 1.85, -1], ['drive', 3.25, -1], ['drive', 3.25, 1], ['bike', 1.85, 1], ['parking'], ['sidewalk', 2.5]] },
  { name: 'Vierstreifig mit Grünmittelstreifen', category: 'Hauptverkehr', strips: [['sidewalk', 3.0], ['bike', 2.0, -1], ['drive', 3.25, -1], ['drive', 3.25, -1], ['median', 4.0, 1, 'trees'], ['drive', 3.25, 1], ['drive', 3.25, 1], ['bike', 2.0, 1], ['sidewalk', 3.0]] },
  { name: 'Boulevard mit Baumreihen', category: 'Hauptverkehr', strips: [['sidewalk', 4.0], ['green', 3.0, 1, 'trees'], ['bike', 2.0, -1], ['drive', 3.25, -1], ['median', 2.5, 1, 'flowers'], ['drive', 3.25, 1], ['bike', 2.0, 1], ['green', 3.0, 1, 'trees'], ['sidewalk', 4.0]] },
  { name: 'Busstreifen beidseitig', category: 'ÖPNV', strips: [['sidewalk', 3.0], ['bus', 3.5, -1], ['drive', 3.25, -1], ['drive', 3.25, 1], ['bus', 3.5, 1], ['sidewalk', 3.0]] },
  { name: 'Stadtbahn in Mittellage', category: 'ÖPNV', strips: [['sidewalk', 3.0], ['drive', 3.25, -1], ['tram', 3.2, -1], ['tram', 3.2, 1], ['drive', 3.25, 1], ['sidewalk', 3.0]] },
  { name: 'Stadtbahn auf eigenem Gleiskörper', category: 'ÖPNV', strips: [['sidewalk', 3.0], ['bike', 2.0, -1], ['drive', 3.25, -1], ['green', 1.0, 1, 'lawn'], ['tram', 3.2, -1], ['tram', 3.2, 1], ['green', 1.0, 1, 'lawn'], ['drive', 3.25, 1], ['bike', 2.0, 1], ['sidewalk', 3.0]] },
  { name: 'Zweirichtungsradweg', category: 'Rad und Fuß', strips: [['bike', 1.6, -1], ['bike', 1.6, 1]] },
  { name: 'Gemeinsamer Geh- und Radweg', category: 'Rad und Fuß', strips: [['green', 1.0, 1, 'lawn'], ['sidewalk', 2.0], ['bike', 1.5, -1], ['bike', 1.5, 1], ['green', 1.0, 1, 'lawn']] },
  { name: 'Fußweg', category: 'Rad und Fuß', strips: [['sidewalk', 3.0]] },
  { name: 'Promenade mit Bäumen', category: 'Rad und Fuß', strips: [['sidewalk', 3.0], ['green', 3.0, 1, 'mixed'], ['sidewalk', 4.0], ['green', 3.0, 1, 'flowers'], ['sidewalk', 3.0]] },
  { name: 'Landstraße', category: 'Außerorts', strips: [['green', 2.0, 1, 'lawn'], ['drive', 3.5, -1], ['drive', 3.5, 1], ['green', 2.0, 1, 'lawn']] },
  { name: 'Landstraße mit Radweg', category: 'Außerorts', strips: [['green', 1.5, 1, 'lawn'], ['drive', 3.5, -1], ['drive', 3.5, 1], ['green', 2.0, 1, 'trees'], ['bike', 1.5, -1], ['bike', 1.5, 1], ['green', 1.0, 1, 'lawn']] },
  { name: 'Schnellstraße 2+2', category: 'Außerorts', strips: [['green', 2.0, 1, 'lawn'], ['drive', 3.75, -1], ['drive', 3.75, -1], ['median', 3.0, 1, 'lawn'], ['drive', 3.75, 1], ['drive', 3.75, 1], ['green', 2.0, 1, 'lawn']] },
];

export function makeStrip(type: StripType, width?: number, dir: 1 | -1 = 1): Strip {
  return { id: uid(), type, width: width ?? STRIP_TYPES[type].width, dir, lineRight: 'auto' };
}

/**
 * Querschnitt in Gegenrichtung gesehen: Reihenfolge und Fahrtrichtungen drehen sich um,
 * die Linie „rechts von Streifen k“ wandert zum neuen rechten Nachbarn.
 */
export function reverseProfile(profile: Strip[]): Strip[] {
  const n = profile.length;
  return profile.map((_, k) => {
    const old = profile[n - 1 - k];
    return { ...old, dir: -old.dir as 1 | -1, lineRight: profile[n - 2 - k]?.lineRight ?? 'auto' };
  });
}

/** Gleicher Querschnitt (gleich orientiert)? Dann laufen zwei Straßen nahtlos ineinander über. */
export function sameProfile(a: Strip[], b: Strip[]) {
  return (
    a.length === b.length &&
    a.every((s, i) => s.type === b[i].type && Math.abs(s.width - b[i].width) < 0.01 && s.dir === b[i].dir)
  );
}

export function presetProfile(index: number): Strip[] {
  return PRESETS[index].strips.map(([t, w, d, plant]) => ({ ...makeStrip(t, w, d ?? 1), ...(plant ? { planting: plant } : {}) }));
}

export function emptyProject(): Project {
  return { version: 1, name: 'Mein Stadtteil', roads: [] };
}
