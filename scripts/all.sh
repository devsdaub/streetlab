#!/usr/bin/env bash
# Alle Bedientests nacheinander (Dev-Server muss auf Port 5180 laufen). Aufruf: bash scripts/all.sh <ordner>
out="${1:-$TEMP}"
cd "$(dirname "$0")/.."
run() { echo "== $1"; node "scripts/$1" "$out" 2>&1 | grep -v "^\s*at " | tail -${2:-4}; }
echo "== symbols-test.mjs"; node scripts/symbols-test.mjs 2>&1 | tail -1
run chain.mjs 2
run snap.mjs 1
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
