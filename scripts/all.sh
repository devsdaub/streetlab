#!/usr/bin/env bash
# Alle Bedientests nacheinander (Dev-Server muss auf Port 5180 laufen). Aufruf: bash scripts/all.sh <ordner>
out="${1:-$TEMP}"
cd "$(dirname "$0")/.."
run() { echo "== $1"; node "scripts/$1" "$out" 2>&1 | grep -v "^\s*at " | tail -${2:-4}; }
echo "== symbols-test.mjs"; node scripts/symbols-test.mjs 2>&1 | tail -1
run chain.mjs 2
run snap.mjs 1
run snap-guides.mjs 15
run curve-tool.mjs 15
run section-brush.mjs 13
run roundabout-tool.mjs 10
run osm-import.mjs 13
run ui2.mjs 6
run sections.mjs 4
run junction-editor.mjs 2
run mapedit.mjs 4
run bike.mjs 3
run interact.mjs 4
run ui4.mjs 5
run storage.mjs 5
run perf.mjs 3
echo "== sim-test.mjs"; node scripts/sim-test.mjs 2>&1 | tail -5
echo "== sim-diag.mjs"; node scripts/sim-diag.mjs 2>&1 | grep -v notice | cut -c1-160
run sim.mjs 4
# SUMO-Prüfung nur mit Python-Umgebung (pip install eclipse-sumo): SUMO_VENV=<pfad> bash scripts/all.sh
if [ -n "$SUMO_VENV" ]; then echo "== sumo-test.mjs"; node scripts/sumo-test.mjs "$SUMO_VENV" "$out" 2>&1 | tail -6; fi
echo "== roundtrip.mjs"; node scripts/roundtrip.mjs fixtures/mein-stadtteil.json "$out" 2>&1 | grep -v "^ok" | tail -6
# OSM-Import an drei echten Gebieten: Stuttgart Mitte, Echterdingen (Wohngebiet), Wilhelma (B10 am Neckar)
for area in "osm-stuttgart.json 9.1650,48.7760,9.1760,48.7830" "osm-echterdingen.json 9.0090,48.6410,9.0230,48.6490" "osm-wilhelma.json 9.1990,48.8000,9.2120,48.8080"; do
  set -- $area
  echo "== osm-test.mjs $1"; NOSIM=1 node scripts/osm-test.mjs "scripts/fixtures/$1" "$2" 2>&1 | grep -v notice | sed -n '/Regelverstöße/,$p'
done
echo "== invariants.mjs"; node scripts/invariants.mjs 20 2>&1 | grep -v notice | sed -n '/Szenen ohne/,$p'
