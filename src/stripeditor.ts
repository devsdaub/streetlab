/** Bedienelemente für einen Streifen — gemeinsam für Inspektor und Kartenfenster. */
import { stripColor } from './decor';
import { profileSvg } from './presets';
import {
  LINE_LABELS,
  PLANTING_LABELS,
  STRIP_TYPES,
  TURN_LABELS,
  makeStrip,
  type LineStyle,
  type Planting,
  type Strip,
  type StripType,
  type Turn,
} from './model';
import { button, chip, field, h, icon, segmented, select, stepper } from './ui';

export interface StripContext {
  profile: Strip[];
  index: number;
  /** Änderung mit Undo-Punkt ausführen */
  change: (fn: () => void) => void;
  /** anderen Streifen auswählen (z. B. nach Einfügen) */
  selectStrip: (id: string | null) => void;
  /** kompakte Darstellung (Kartenfenster) */
  compact?: boolean;
}

export const TYPE_OPTIONS = (Object.keys(STRIP_TYPES) as StripType[]).map((k) => ({ value: k, label: STRIP_TYPES[k].label }));

/** Kurzbeschreibung eines Streifens, z. B. „Fahrstreifen · 3,25 m“ */
export const stripLabel = (s: Strip) => `${STRIP_TYPES[s.type].label} · ${s.width.toFixed(2).replace('.', ',')} m`;

export function stripDetails(ctx: StripContext): HTMLElement {
  const { profile, index, change } = ctx;
  const s = profile[index];
  const info = STRIP_TYPES[s.type];
  const last = index === profile.length - 1;

  const typeRow = h(
    'div',
    { class: 'type-row' },
    chip(stripColor(s)),
    select(TYPE_OPTIONS, s.type, (t) =>
      change(() => {
        s.type = t;
        s.width = STRIP_TYPES[t].width;
      }),
      'strip-type',
    ),
  );

  const dir = info.directional
    ? segmented(
        [
          { value: 1, label: 'Vorwärts', title: 'In Zeichenrichtung der Straße' },
          { value: -1, label: 'Rückwärts', title: 'Entgegen der Zeichenrichtung' },
        ],
        s.dir,
        (d) => change(() => (s.dir = d as 1 | -1)),
        'strip-dir',
      )
    : null;

  const extras: Node[] = [];
  if (s.type === 'drive' || s.type === 'bus') {
    extras.push(
      field(
        'Pfeile',
        select(
          [{ value: '', label: 'Automatisch' }, ...Object.entries(TURN_LABELS).map(([value, label]) => ({ value, label }))],
          s.turn ?? '',
          (v) => change(() => (s.turn = (v || undefined) as Turn | undefined)),
        ),
      ),
    );
  }
  if (s.type === 'parking') {
    extras.push(
      field(
        'Aufstellung',
        segmented(
          [
            { value: 0, label: 'Längs' },
            { value: 45, label: 'Schräg' },
            { value: 90, label: 'Senkrecht' },
          ],
          s.parkAngle ?? 0,
          (v) =>
            change(() => {
              s.parkAngle = v === 0 ? undefined : (v as 45 | 90);
              s.width = v === 0 ? 2.0 : v === 45 ? 4.6 : 5.0;
            }),
          'park-angle',
        ),
      ),
    );
  }
  if (s.type === 'drive' || s.type === 'bus' || s.type === 'bike') {
    extras.push(
      field(
        'Schrift',
        h('input', {
          class: 'text-input',
          value: s.text ?? '',
          placeholder: s.type === 'bus' ? 'BUS' : 'z. B. 30, TAXI',
          maxlength: 8,
          'data-action': 'strip-text',
          onchange: (e) => change(() => (s.text = (e.target as HTMLInputElement).value.trim().toUpperCase() || undefined)),
        }),
      ),
    );
  }
  if (info.planted) {
    const current = s.planting ?? (s.type === 'green' ? 'trees' : '');
    extras.push(
      field(
        'Bepflanzung',
        select(
          [...(s.type === 'median' ? [{ value: '', label: 'Keine (Pflaster)' }] : []), ...Object.entries(PLANTING_LABELS).map(([value, label]) => ({ value, label }))],
          current,
          (v) => change(() => (s.planting = (v || undefined) as Planting | undefined)),
        ),
      ),
    );
  }
  if (!last && !ctx.compact) {
    extras.push(
      field(
        'Markierung rechts',
        select(
          Object.entries(LINE_LABELS).map(([value, label]) => ({ value: value as LineStyle, label })),
          s.lineRight,
          (v) => change(() => (s.lineRight = v)),
        ),
      ),
    );
  }

  const insert = (offset: 0 | 1) => {
    const n = makeStrip(s.type, s.width, s.dir);
    change(() => profile.splice(index + offset, 0, n));
    ctx.selectStrip(n.id);
  };
  const actions = h(
    'div',
    { class: 'actions' },
    button(null, () => change(() => profile.splice(index - 1, 0, ...profile.splice(index, 1))), { icon: 'left', title: 'Nach links verschieben', disabled: index === 0, kind: 'ghost' }),
    button(null, () => change(() => profile.splice(index + 1, 0, ...profile.splice(index, 1))), { icon: 'right', title: 'Nach rechts verschieben', disabled: last, kind: 'ghost' }),
    h('span', { class: 'sep' }),
    button('Links', () => insert(0), { icon: 'plus', title: 'Neuen Streifen links einfügen', kind: 'ghost' }),
    button('Rechts', () => insert(1), { icon: 'plus', title: 'Neuen Streifen rechts einfügen', kind: 'ghost' }),
    h('span', { class: 'grow' }),
    button(
      null,
      () => {
        change(() => profile.splice(index, 1));
        ctx.selectStrip(null);
      },
      { icon: 'trash', title: 'Streifen entfernen', disabled: profile.length <= 1, kind: 'danger', action: 'strip-delete' },
    ),
  );

  return h(
    'div',
    { class: 'strip-details' },
    typeRow,
    field('Breite', stepper(s.width, (w) => change(() => (s.width = w)), { action: 'strip-width' })),
    dir ? field('Fahrtrichtung', dir) : null,
    ...extras,
    actions,
  );
}

/** Querschnitt als maßstäbliche Grafik; Klick wählt einen Streifen */
export function profileBar(profile: Strip[], selected: string | null, onSelect: (id: string) => void): HTMLElement {
  const total = profile.reduce((s, x) => s + x.width, 0);
  const preview = h('div', { class: 'profile-preview', title: 'Vorschau des Querschnitts' });
  preview.innerHTML = profileSvg(profile, 3.6);
  return h(
    'div',
    { class: 'profile' },
    preview,
    h(
      'div',
      { class: 'profile-bar' },
      ...profile.map((s) =>
        h(
          'button',
          {
            class: 'cell' + (s.id === selected ? ' on' : ''),
            style: `flex:${s.width};background:${stripColor(s)}`,
            title: stripLabel(s),
            onclick: () => onSelect(s.id),
          },
          STRIP_TYPES[s.type].directional ? icon(s.dir === 1 ? 'up' : 'down', 12) : null,
        ),
      ),
    ),
    h('div', { class: 'profile-scale' }, h('span', {}, 'links'), h('span', {}, `${total.toFixed(2).replace('.', ',')} m`), h('span', {}, 'rechts')),
  );
}
