// Testszenen für Kreuzungen — Koordinaten in Metern um einen Ursprung in Stuttgart.
const O = [9.1706, 48.7795];
const k = Math.cos((O[1] * Math.PI) / 180);
const ll = (x, y) => [O[0] + x / (111320 * k), O[1] + y / 111320];
let n = 0;
const S = (type, width, dir = 1) => ({ id: 's' + n++, type, width, dir, lineRight: 'auto' });

const wohn = () => [S('sidewalk', 2.5), S('parking', 2), S('drive', 3, -1), S('drive', 3, 1), S('parking', 2), S('sidewalk', 2.5)];
const haupt = () => [S('sidewalk', 2.5), S('bike', 2, -1), S('drive', 3.25, -1), S('drive', 3.25, 1), S('bike', 2, 1), S('sidewalk', 2.5)];
const allee = () => [S('sidewalk', 3), S('green', 2.5), S('drive', 3.25, -1), S('median', 3), S('drive', 3.25, 1), S('green', 2.5), S('sidewalk', 3)];
const road = (id, pts, profile) => ({ id, name: id, points: pts.map(([x, y]) => ll(x, y)), profile, smooth: true });
const pol = (cx, cy, r, deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];

export const scenes = {
  // Kreuzung (4 Arme), T-Einmündung, schiefe Einmündung (3 Arme), Knick mit Profilwechsel
  all: {
    version: 1, name: 'Testszenen',
    view: { center: ll(75, -50), zoom: 17.3 },
    roads: [
      road('kreuz-ow', [[-60, 0], [0, 0], [60, 0]], haupt()),
      road('kreuz-ns', [[0, -60], [0, 0], [0, 60]], wohn()),
      road('t-ow', [[90, 0], [150, 0], [210, 0]], allee()),
      road('t-s', [[150, 0], [150, -60]], wohn()),
      road('y-1', [[0, -140], pol(0, -140, 60, 200)], haupt()),
      road('y-2', [[0, -140], pol(0, -140, 60, 330)], wohn()),
      road('y-3', [[0, -140], pol(0, -140, 60, 95)], wohn()),
      road('knick-1', [[150, -120], [90, -150]], haupt()),
      road('knick-2', [[150, -120], [200, -80]], wohn()),
    ],
  },
};
const key = (p) => p[0].toFixed(8) + ',' + p[1].toFixed(8);
const T = (type, width, dir = 1, planting) => ({ ...S(type, width, dir), ...(planting ? { planting } : {}) });
const rbProf = () => [S('sidewalk', 2.5), S('drive', 3.5, -1), S('drive', 3.5, 1), S('sidewalk', 2.5)];
scenes.style = {
  version: 1, name: 'Stiltest', view: { center: ll(75, -35), zoom: 17.4 },
  junctions: {
    [key(ll(0, 0))]: { kind: 'cross', radius: 6, crossing: 'zebra', bikeCrossing: true, stopLines: true, rbRadius: 15, rbLane: 6.5 },
    [key(ll(160, 0))]: { kind: 'roundabout', radius: 8, crossing: 'zebra', bikeCrossing: false, stopLines: false, rbRadius: 16, rbLane: 6.5 },
  },
  roads: [
    road('haupt', [[-70, 0], [0, 0], [70, 0]], haupt()),
    road('wohn', [[0, -55], [0, 0], [0, 60]], wohn()),
    road('rb-w', [[90, 0], [160, 0]], rbProf()),
    road('rb-e', [[160, 0], [230, 0]], rbProf()),
    road('rb-n', [[160, 0], [160, 60]], rbProf()),
    road('rb-s', [[160, 0], [160, -55]], rbProf()),
    road('allee', [[-70, -95], [80, -100], [230, -95]], [S('sidewalk', 3), T('green', 3, 1, 'trees'), S('drive', 3.25, -1), S('tram', 3.2, -1), S('tram', 3.2, 1), S('drive', 3.25, 1), T('green', 2.5, 1, 'flowers'), S('sidewalk', 3)]),
  ],
};
scenes.trans = {
  version: 1, name: 'Verziehung', view: { center: ll(20, 0), zoom: 18.1 },
  roads: [
    road('A', [[-90, 0], [-20, 0]], [S('sidewalk', 2.5), S('parking', 2), S('drive', 3, -1), S('drive', 3, 1), S('bike', 2, 1), S('sidewalk', 2.5)]),
    road('B', [[-20, 0], [40, 6]], [S('sidewalk', 2.5), T('green', 2.5, 1, 'trees'), S('drive', 3.25, -1), S('drive', 3.25, 1), S('bike', 2, 1), S('sidewalk', 2.5)]),
    road('C', [[40, 6], [120, 0]], [S('sidewalk', 2.5), S('drive', 3.25, -1), S('drive', 3.25, -1), S('drive', 3.25, 1), S('drive', 3.25, 1), S('sidewalk', 2.5)]),
  ],
};
scenes.user = {
  version: 1, name: 'Wie im Screenshot', view: { center: ll(0, 0), zoom: 18.6 },
  roads: [
    road('vorher', [[-80, -4], [0, 0]], [S('sidewalk', 2.5), S('parking', 2), S('drive', 3, -1), S('drive', 3, 1), S('sidewalk', 2.5), S('bike', 2, 1)]),
    road('nachher', [[0, 0], [80, 6]], [S('sidewalk', 2.5), T('green', 2.5, 1, 'trees'), S('drive', 3.25, -1), S('drive', 3.25, 1), S('bike', 2, 1), S('sidewalk', 2.5)]),
  ],
};
// Härtetest für Kreuzungen: versetzte Einmündungen, verschiedene Arme, Kurve, Abbiegespuren
scenes.stress = {
  version: 1, name: 'Kreuzungs-Härtetest', view: { center: ll(60, -40), zoom: 17.6 },
  junctions: {
    [key(ll(150, 0))]: { kind: 'cross', radius: 8, crossing: 'zebra', bikeCrossing: true, stopLines: true, control: 'signals', rbRadius: 15, rbLane: 6.5 },
  },
  roads: [
    // Hauptachse mit zwei versetzten Einmündungen 18 m auseinander
    road('achse', [[-60, 0], [0, 0], [18, 0], [150, 0], [230, 0]], haupt()),
    road('nord', [[0, 0], [0, 60]], wohn()),
    road('sued', [[18, 0], [18, -60]], wohn()),
    // Kreuzung mit Mittelinsel-Arm, Stadtbahn-Arm und gekrümmtem Arm
    road('allee-n', [[150, 0], [150, 70]], allee()),
    road('bahn-s', [[150, 0], [160, -40], [190, -80]], [S('sidewalk', 3), S('drive', 3.25, -1), S('tram', 3.2, -1), S('tram', 3.2, 1), S('drive', 3.25, 1), S('sidewalk', 3)]),
  ],
};
export { ll };
