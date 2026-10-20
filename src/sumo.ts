/**
 * Export als SUMO-„plain XML“ (Knoten, Kanten, Verbindungen) samt netconvert-Konfiguration.
 * Erzeugen des Netzes:  netconvert -c <name>.netccfg   →  <name>.net.xml
 */
import type { Vec } from './geometry';
import type { LaneClass, Network } from './network';

const ALLOW: Record<LaneClass, string> = {
  car: 'passenger taxi bus coach delivery truck motorcycle emergency',
  bike: 'bicycle',
  tram: 'tram rail_urban',
  ped: 'pedestrian',
};

const NODE_TYPE = {
  none: 'right_before_left',
  stoplines: 'priority',
  priority: 'priority',
  signals: 'traffic_light',
  allstop: 'allway_stop',
} as const;

const xy = (p: Vec) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export interface SumoFiles {
  nodes: string;
  edges: string;
  connections: string;
  config: string;
}

export function sumoFiles(net: Network, name: string): SumoFiles {
  const nodes = [...net.nodes.values()]
    .map((n) => {
      const type = n.kind === 'end' ? 'dead_end' : n.kind === 'pass' ? 'priority' : n.junctionKind !== 'cross' ? 'priority' : NODE_TYPE[n.control];
      return `  <node id="${n.id}" x="${n.pos[0].toFixed(2)}" y="${n.pos[1].toFixed(2)}" type="${type}"/>`;
    })
    .join('\n');

  const edges = net.edges
    .map((e) => {
      const cars = e.lanes.filter((l) => l.cls === 'car').length;
      const lanes = e.lanes
        .map((l) => {
          const speed = l.cls === 'bike' ? 5.5 : l.cls === 'ped' ? 1.4 : e.speed;
          return `    <lane index="${l.index}" width="${l.width.toFixed(2)}" allow="${ALLOW[l.cls]}" speed="${speed.toFixed(2)}"/>`;
        })
        .join('\n');
      return (
        `  <edge id="${e.id}" from="${e.from}" to="${e.to}" priority="${Math.max(1, cars)}" numLanes="${e.lanes.length}" ` +
        `speed="${e.speed.toFixed(2)}" spreadType="right" shape="${e.shape.map(xy).join(' ')}" name="${esc(e.roadId)}">\n${lanes}\n  </edge>`
      );
    })
    .join('\n');

  const connections = net.conns
    .filter((c) => c.explicit)
    .map((c) => `  <connection from="${c.from}" to="${c.to}" fromLane="${c.fromLane}" toLane="${c.toLane}"/>`)
    .join('\n');

  const config = `<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <input>
    <node-files value="${name}.nod.xml"/>
    <edge-files value="${name}.edg.xml"/>
    <connection-files value="${name}.con.xml"/>
  </input>
  <output>
    <output-file value="${name}.net.xml"/>
  </output>
  <processing>
    <no-turnarounds value="true"/>
  </processing>
</configuration>
`;
  const wrap = (tag: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Streetlab-Export -->\n<${tag}>\n${body}\n</${tag}>\n`;
  return { nodes: wrap('nodes', nodes), edges: wrap('edges', edges), connections: wrap('connections', connections), config };
}

/** Alle Dateien nacheinander herunterladen */
export function downloadSumo(files: SumoFiles, name: string) {
  const list: [string, string][] = [
    [`${name}.nod.xml`, files.nodes],
    [`${name}.edg.xml`, files.edges],
    [`${name}.con.xml`, files.connections],
    [`${name}.netccfg`, files.config],
  ];
  list.forEach(([file, text], i) =>
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/xml' }));
      a.download = file;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, i * 250),
  );
}
