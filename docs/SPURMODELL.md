# Spurmodell — Neubau des Kerns

Warum: Bisher entstehen Kreuzungen dadurch, dass zwei Straßen zufällig dieselbe Koordinate haben
(`nodeKey`), und Querschnitte hängen an Stützpunkt-Nummern. Verschieben, Ersetzen oder Importieren
erzeugt dadurch ungewollt Knoten, fügt Punkte in fremde Straßen ein und zerlegt Straßen in viele
kurze Stücke mit eigenen Verziehungen. Das Ergebnis: ausgefranste Kanten, Splitter, „Chaos“ beim
Nachbearbeiten.

## Grundsätze

1. **Graph mit Identitäten.** Knoten und Straßenzüge haben feste IDs. Ein Straßenzug verbindet
   Knoten A mit Knoten B; seine Enden liegen *immer* auf der Position dieser Knoten. Topologie
   ändert sich nur durch ausdrückliche Operationen (anhängen, teilen, lösen) — nie durch Zufall.
2. **Querschnitt entlang der Lage.** Ein Straßenzug hat Querschnitts-Ereignisse an einer Lage
   (Anteil 0…1 der Länge), nicht an Stützpunkten. Geometrie ändern verschiebt keine Ereignisse
   ins Leere; Querschnitt ändern fügt keine Stützpunkte ein.
3. **Operationen statt Mutationen.** Jede Bearbeitung ist eine Funktion `Netz → Netz` mit
   geprüften Invarianten (siehe unten). Rückgängig = vorheriges Netz.
4. **Ableitung.** Aus dem Netz werden die bisherigen `Road`-Objekte berechnet; Darstellung,
   Kreuzungsbau, Spurnetz, Simulation und SUMO-Export bleiben vorerst unverändert.
5. **Import formt ein Netz.** OSM wird zu Straßenzügen verdichtet (gleiche Straße durchgehend),
   Knoten-Cluster werden zusammengefasst, Querschnittswechsel bekommen Mindestlängen.

## Invarianten (werden nach jeder Operation geprüft)

- Jeder Straßenzug verweist auf zwei existierende Knoten; seine Endpunkte = Knotenpositionen.
- Kein Knoten ohne Straßenzug.
- Ereignisse aufsteigend, das erste bei 0, alle in [0, 1].
- Keine zwei Knoten an derselben Position.

## Stufen

1. **Kern** (`src/core/`): Datentypen, Operationen, Invarianten, Umrechnung altes Projekt → Netz
   und Netz → `Road[]`. Eigene Tests ohne Browser.
2. **Speicher und Editor** auf das Netz umstellen: Zeichnen hängt an Knoten an oder teilt
   Straßen ausdrücklich; Punkt- und Straßenziehen, Teilen, Abschnitt ziehen, Kurve, Kreisverkehr.
3. **Import** erzeugt das Netz direkt: Straßenzüge verdichten, Richtungsfahrbahn-Paare zu einer
   Straße mit Mittelstreifen, Spurwechsel als Ereignisse mit Mindestlänge.
4. **Kreuzungsbereiche**: nahe Knoten als eine Kreuzung bauen (Richtungsfahrbahnen, versetzte
   Einmündungen).
5. **Aufräumen**: alte koordinatenbasierte Verknüpfung (`topology.ts`, `nodeKey`-Logik im Editor)
   entfernen.

Jede Stufe endet mit grüner Testsuite (`scripts/all.sh`) und den Qualitätsregeln aus
`scripts/checks.mjs` an den OSM-Testdaten.
