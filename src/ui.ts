/** Kleine UI-Bausteine: DOM-Helfer, Linien-Icons und Bedienelemente im einheitlichen Stil. */

type Child = Node | string | null | false | undefined;
export type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = String(v);
    else if (typeof v === 'boolean') (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export const val = (e: Event) => (e.target as HTMLInputElement).value;
export const fmtM = (m: number) => `${m.toFixed(2).replace('.', ',')} m`;

// ---- Icons (16 px, 1,6 px Linie, im Stil gängiger Linien-Icon-Sets) ----------

const PATHS: Record<string, string> = {
  select: 'M4 3l11 5-4.5 1.5L9 14z',
  draw: 'M3 13.5l1-4L11.5 2a1.4 1.4 0 012 2L6 11.5zM9.5 4l2.5 2.5',
  split: 'M5 4.5a1.5 1.5 0 110 .01M5 11.5a1.5 1.5 0 110 .01M6.3 5.5L13 12M6.3 10.5L13 4',
  undo: 'M5.5 3.5L2.5 6.5l3 3M2.5 6.5H10a3.5 3.5 0 010 7H7',
  redo: 'M10.5 3.5l3 3-3 3M13.5 6.5H6a3.5 3.5 0 000 7h3',
  search: 'M7 2.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9zM10.5 10.5L14 14',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
  left: 'M10 3.5L5.5 8l4.5 4.5',
  right: 'M6 3.5L10.5 8 6 12.5',
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5',
  close: 'M4 4l8 8M12 4l-8 8',
  focus: 'M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3',
  swap: 'M5 2.5v11M2.5 5L5 2.5 7.5 5M11 13.5v-11M8.5 11l2.5 2.5 2.5-2.5',
  lanes: 'M4 13.5c0-4 8-4 8-11M4 2.5v11M12 13.5',
  chevron: 'M4 6l4 4 4-4',
  file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
  folder: 'M2.5 4.5h4l1.5 1.5h5.5v7.5h-11z',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 2.5 2.5M10.5 6a.5.5 0 110 .01',
  layers: 'M8 2.5l5.5 3L8 8.5l-5.5-3zM2.5 8L8 11l5.5-3M2.5 10.5L8 13.5l5.5-3',
};

export function icon(name: keyof typeof PATHS | string, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'ico');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', PATHS[name] ?? '');
  svg.append(p);
  return svg;
}

// ---- Bedienelemente ----------------------------------------------------------

export function button(label: Child, onclick: () => void, opts: { kind?: 'primary' | 'ghost' | 'danger'; title?: string; icon?: string; active?: boolean; disabled?: boolean; action?: string } = {}) {
  return h(
    'button',
    {
      class: ['btn', opts.kind ?? '', opts.active ? 'active' : '', label ? '' : 'icon-only'].filter(Boolean).join(' '),
      title: opts.title,
      disabled: !!opts.disabled,
      'data-action': opts.action,
      onclick,
    },
    opts.icon ? icon(opts.icon) : null,
    label,
  );
}

/** Segment-Umschalter: eine von mehreren Optionen */
export function segmented<T extends string | number>(options: { value: T; label: string; title?: string }[], value: T, onChange: (v: T) => void, action?: string) {
  return h(
    'div',
    { class: 'segmented', 'data-action': action },
    ...options.map((o) =>
      h('button', { class: o.value === value ? 'on' : '', title: o.title, 'data-value': String(o.value), onclick: () => o.value !== value && onChange(o.value) }, o.label),
    ),
  );
}

/** Schalter (an/aus) mit Beschriftung */
export function toggle(label: string, value: boolean, onChange: (v: boolean) => void, action?: string) {
  return h(
    'label',
    { class: 'toggle', 'data-action': action },
    h('input', { type: 'checkbox', checked: value, onchange: (e) => onChange((e.target as HTMLInputElement).checked) }),
    h('span', { class: 'track' }, h('span', { class: 'thumb' })),
    h('span', { class: 'toggle-label' }, label),
  );
}

/** Auswahlliste */
export function select<T extends string>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void, action?: string) {
  return h(
    'div',
    { class: 'select' },
    h(
      'select',
      { onchange: (e) => onChange(val(e) as T), 'data-action': action },
      ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
    ),
    icon('chevron', 14),
  );
}

/** Zahlenfeld mit − / + (Meter) */
export function stepper(value: number, onChange: (v: number) => void, opts: { step?: number; min?: number; max?: number; action?: string } = {}) {
  const step = opts.step ?? 0.25, min = opts.min ?? 0.25, max = opts.max ?? 30;
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const input = h('input', {
    type: 'number',
    step,
    min,
    max,
    value: Number(value.toFixed(2)),
    onchange: (e) => {
      const v = parseFloat(val(e).replace(',', '.'));
      if (Number.isFinite(v)) onChange(clamp(v));
    },
  });
  return h(
    'div',
    { class: 'stepper', 'data-action': opts.action },
    h('button', { title: 'kleiner', onclick: () => onChange(clamp(value - step)) }, icon('minus', 14)),
    input,
    h('span', { class: 'unit' }, 'm'),
    h('button', { title: 'größer', onclick: () => onChange(clamp(value + step)) }, icon('plus', 14)),
  );
}

/** Schieberegler mit Wertanzeige */
export function slider(value: number, min: number, max: number, step: number, onChange: (v: number) => void, format = fmtM) {
  const out = h('span', { class: 'slider-value' }, format(value));
  return h(
    'div',
    { class: 'slider' },
    h('input', {
      type: 'range',
      min,
      max,
      step,
      value,
      oninput: (e) => (out.textContent = format(+val(e))),
      onchange: (e) => onChange(+val(e)),
    }),
    out,
  );
}

/** Beschriftete Zeile: Label links, Bedienelement rechts */
export const field = (label: string, control: Node, hint?: string) =>
  h('div', { class: 'field' }, h('label', {}, label), control, hint ? h('div', { class: 'hint' }, hint) : null);

/** Abschnitt im Inspektor */
export const group = (title: string | null, ...children: Child[]) =>
  h('section', { class: 'group' }, title ? h('h3', {}, title) : null, ...children);

/** Farbfeld für Streifentypen */
export const chip = (color: string) => h('span', { class: 'chip', style: `background:${color}` });

/** Einklappbarer Abschnitt; der Zustand bleibt im Browser gespeichert */
export function foldGroup(id: string, title: string, defaultOpen: boolean, ...children: Child[]) {
  const key = `streetlab.fold.${id}`;
  let open = defaultOpen;
  try {
    const v = localStorage.getItem(key);
    if (v !== null) open = v === '1';
  } catch {
    /* ohne Speicher: Standard */
  }
  const el = h(
    'details',
    { class: 'group fold', open, 'data-fold': id },
    h('summary', {}, h('h3', {}, title), icon('chevron', 14)),
    h('div', { class: 'fold-body' }, ...children),
  );
  el.addEventListener('toggle', () => {
    try {
      localStorage.setItem(key, el.open ? '1' : '0');
    } catch {
      /* egal */
    }
  });
  return el;
}
