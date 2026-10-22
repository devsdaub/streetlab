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
- Bestand übernehmen (Taste B): Bereich mit dem Lasso umfahren, Straßen aus OpenStreetMap mit Spuren, Abbiegepfeilen, Parken, Radwegen, Gehwegen, Bäumen, Ampeln und Kreisverkehren nachbauen (`src/osm.ts`, Prüfung: `node scripts/osm-test.mjs`)
- Fang beim Zeichnen: Verlängerung, 90°/45°, parallel/rechtwinklig zu Nachbarstraßen, exakter Anschluss am Schnittpunkt, Länge in ganzen Metern; Zielstraße wird blau umrandet; G schaltet an/aus, Alt kehrt um
- Kurve (K): Kreisbogen mit festem Radius, tangential aus dem Straßenende, Anzeige Länge · Radius · Winkel zur Zielstraße
- Abschnitt ziehen (A): entlang einer Straße ziehen, dort gilt der gewählte Querschnitt, Verziehungen entstehen automatisch (`src/brush.ts`)
- Kreisverkehr aufziehen (R): auf eine Kreuzung drücken und den Radius ziehen, unter 10 m Mini-Kreisel (`src/roundabout.ts`)

Als Container (Docker Desktop):

```
docker compose up -d --build   # http://localhost:8080
docker compose down
```

Jeder Push auf `main` baut per GitHub Action ([docker-publish.yml](.github/workflows/docker-publish.yml)) das Image `ghcr.io/devsdaub/streetlab` (Tags `latest` und Commit-Hash). Statt lokal zu bauen:

```
STREETLAB_IMAGE=ghcr.io/devsdaub/streetlab docker compose pull
STREETLAB_IMAGE=ghcr.io/devsdaub/streetlab docker compose up -d
```

Tests mit Edge (Dev-Server auf Port 5180 starten: `npx vite --port 5180`; anderer Browser: `BROWSER=chrome`):

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
node scripts/snap-guides.mjs <ordner>          # Richtungsfang beim Zeichnen, Fang-Schalter
node scripts/curve-tool.mjs <ordner>           # Kurven-Werkzeug
node scripts/section-brush.mjs <ordner>        # Abschnitt entlang einer Straße ziehen
node scripts/roundabout-tool.mjs <ordner>      # Kreisverkehr aufziehen
node scripts/osm-import.mjs <ordner>           # Bestand übernehmen (Lasso, Fortschritt, Abbrechen)
```
