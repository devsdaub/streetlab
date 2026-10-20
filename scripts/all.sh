#!/usr/bin/env bash
# Alle Bedientests nacheinander (Dev-Server muss auf Port 5180 laufen). Aufruf: bash scripts/all.sh <ordner>
out="${1:-$TEMP}"
cd "$(dirname "$0")/.."
run() { echo "== $1"; node "scripts/$1" "$out" 2>&1 | grep -v "^\s*at " | tail -${2:-4}; }
run chain.mjs 2
run snap.mjs 1
run ui2.mjs 6
run sections.mjs 4
run junction-editor.mjs 2
run mapedit.mjs 4
run bike.mjs 3
run interact.mjs 4
run storage.mjs 5
run perf.mjs 3
