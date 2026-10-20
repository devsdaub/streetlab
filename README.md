# Streetlab

Straßen im Browser neu gestalten — Querschnitte, Kreuzungen, Vorher/Nachher über Luftbild.

```
npm install
npm run dev        # http://localhost:5173
```

- Daten: Straßen als Mittellinie + Querschnitt in echten Koordinaten (`src/model.ts`)
- Geometrie: Streifen, Markierungen (`src/render.ts`), Knotenpunkte (`src/junction.ts`)
- Netz-Topologie: automatische Knoten beim Kreuzen/Anschließen (`src/topology.ts`)
- Export: PNG gekachelt bis 100 MP, SVG (1 Einheit = 1 m)

Tests mit Edge (Dev-Server auf Port 5180 starten: `npx vite --port 5180`):

```
node scripts/shot.mjs all out.png [zoom x y]   # Kreuzungs-Testszenen
node scripts/interact.mjs <ordner>             # Bedienung + Export
node scripts/chain.mjs <ordner>                # Straßen aneinanderhängen, Kurven ziehen
node scripts/sections.mjs <ordner>             # Abschnitte + Abbiegespuren
node scripts/junction-editor.mjs <ordner>      # Kreuzungseditor (Spurverbindungen, Vorfahrt, Mini-Kreisel)
node scripts/mapedit.mjs <ordner>              # Bearbeiten direkt in der Karte
node scripts/bike.mjs <ordner>                 # Radwege an Kreuzungen und Übergängen verbinden
node scripts/ui-shots.mjs <ordner>             # Screenshots der Oberfläche
node scripts/snap.mjs <ordner>                 # Fangen an Straßenenden + Verziehung
```
