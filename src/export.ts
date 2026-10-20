import type { FeatureCollection, Polygon } from 'geojson';

const M = 111320;

/**
 * Exportiert den Entwurf als SVG — reine Vektoren, beliebig skalierbar.
 * 1 SVG-Einheit = 1 m; die Bildgröße entspricht dem Maßstab 1:250 bei 96 dpi.
 */
export function exportSvg(
  surfaces: FeatureCollection,
  markings: FeatureCollection,
  decor: FeatureCollection,
  filename: string,
) {
  const byRank = (a: { properties: any }, b: { properties: any }) => (a.properties?.rank ?? 0) - (b.properties?.rank ?? 0);
  const polys = [...surfaces.features]
    .sort(byRank)
    .concat(markings.features, [...decor.features].sort(byRank))
    .filter((f) => f.geometry.type === 'Polygon');
  if (!polys.length) return false;

  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const f of polys) {
    for (const [lng, lat] of (f.geometry as Polygon).coordinates[0]) {
      minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
  }
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const x = (lng: number) => ((lng - minLng) * M * k).toFixed(2);
  const y = (lat: number) => ((maxLat - lat) * M).toFixed(2);
  const w = (maxLng - minLng) * M * k, h = (maxLat - minLat) * M;

  // aufeinanderfolgende Flächen gleicher Farbe zu einem Pfad zusammenfassen
  const paths: { color: string; d: string[] }[] = [];
  for (const f of polys) {
    const color = f.properties?.color ?? '#888';
    const ring = (f.geometry as Polygon).coordinates[0];
    const d = 'M' + ring.map(([lng, lat]) => `${x(lng)} ${y(lat)}`).join('L') + 'Z';
    const last = paths[paths.length - 1];
    if (last?.color === color) last.d.push(d);
    else paths.push({ color, d: [d] });
  }

  const px = 96 / 0.0254 / 250; // Pixel pro Meter bei 1:250
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" ` +
    `width="${Math.round(w * px)}" height="${Math.round(h * px)}">\n` +
    paths.map((p) => `<path fill="${p.color}" d="${p.d.join('')}"/>`).join('\n') +
    '\n</svg>\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return true;
}
