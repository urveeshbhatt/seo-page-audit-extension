// conform(data, schema): put collector data into the shape the rules expect.
//
// Why: rules call string, array and object methods on collector data. A page
// that makes a collector return something odd (or a future collector change)
// must not crash the rules. Fuzz testing in v1.5.0 found ~180 places where a
// wrong type or a missing key crashed the older rules modules.
//
// Rules of conform (pure, no DOM):
//   - real data is never changed: on data with the expected shape it returns
//     an equal copy (tested on every real capture)
//   - a wrong container type becomes an empty one ([] / {} with defaults),
//     or null where the collector itself can send null
//   - strings / numbers / booleans of the wrong type get a safe default
//     ('' / 0 / false), or null where null is allowed; numbers sent as text
//     are converted; NaN and Infinity count as missing
//   - keys every capture has come back with a default when missing; keys
//     that only some captures have stay absent; unknown keys pass through
//   - "__proto__" keys are dropped (no prototype pollution)
//
// Schema node: { t: 'str'|'num'|'bool'|'any'|'arr'|'obj', n?: true (null allowed),
//                of?: node (arrays), keys?: { name: { s: node, req: bool } } (objects) }

export function conform(value, schema) {
  const s = schema;
  if (!s || s.t === 'any') return value;
  if (value === null || value === undefined) return s.n ? (value === undefined ? null : value) : dflt(s);
  switch (s.t) {
    case 'str':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return Number.isFinite(value) || typeof value === 'boolean' ? String(value) : (s.n ? null : '');
      return s.n ? null : '';
    case 'num': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : (s.n ? null : 0);
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      return Number.isFinite(n) ? n : (s.n ? null : 0);
    }
    case 'bool':
      return typeof value === 'boolean' ? value : (s.n ? null : false);
    case 'arr':
      return Array.isArray(value) ? value.map((x) => conform(x, s.of)) : (s.n ? null : []);
    case 'obj': {
      if (typeof value !== 'object' || Array.isArray(value)) return s.n ? null : dflt(s);
      const out = {};
      Object.keys(value).forEach((k) => {
        if (k === '__proto__') return;
        const spec = Object.prototype.hasOwnProperty.call(s.keys, k) ? s.keys[k] : null;
        out[k] = spec ? conform(value[k], spec.s) : value[k];
      });
      Object.entries(s.keys).forEach(([k, spec]) => {
        if (spec.req && !Object.prototype.hasOwnProperty.call(out, k)) out[k] = spec.s.n ? null : dflt(spec.s);
      });
      return out;
    }
    default:
      return value;
  }
}

function dflt(s) {
  switch (s.t) {
    case 'str': return '';
    case 'num': return 0;
    case 'bool': return false;
    case 'arr': return [];
    case 'obj': {
      const out = {};
      Object.entries(s.keys).forEach(([k, spec]) => { if (spec.req) out[k] = spec.s.n ? null : dflt(spec.s); });
      return out;
    }
    default: return undefined;
  }
}

const kind = (v) => (Array.isArray(v) ? 'arr' : v === null ? 'null' : typeof v === 'string' ? 'str' : typeof v === 'number' ? 'num' : typeof v === 'boolean' ? 'bool' : typeof v === 'object' ? 'obj' : 'other');

/** Infer a schema from example values (all real captures of one collector). */
export function inferSchema(values) {
  const n = values.some((v) => v === null);
  const real = values.filter((v) => v !== null && v !== undefined);
  if (!real.length) return { t: 'any' };
  const kinds = new Set(real.map(kind));
  if (kinds.size > 1 || kinds.has('other')) return { t: 'any' };
  const [k] = kinds;
  const node = { t: k };
  if (n) node.n = true;
  if (k === 'arr') {
    node.of = inferSchema(real.flat(1));
  } else if (k === 'obj') {
    const names = new Set(real.flatMap((o) => Object.keys(o)));
    node.keys = {};
    [...names].sort().forEach((name) => {
      if (name === '__proto__') return;
      const present = real.filter((o) => Object.prototype.hasOwnProperty.call(o, name));
      node.keys[name] = { s: inferSchema(present.map((o) => o[name])), req: present.length === real.length };
    });
  }
  return node;
}

/** Mark nodes as nullable: every number under a schema (collectors that round with a helper returning null). */
export function allowNull(schema, predicate) {
  const walk = (s, path) => {
    if (!s || typeof s !== 'object') return;
    if (predicate(s, path)) s.n = true;
    if (s.of) walk(s.of, `${path}[]`);
    if (s.keys) Object.entries(s.keys).forEach(([k, spec]) => walk(spec.s, path ? `${path}.${k}` : k));
  };
  walk(schema, '');
  return schema;
}

/** Page context from the setup form, always with the expected types. */
export function contextOf(ctx) {
  const c = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {};
  return {
    ...c,
    pageType: typeof c.pageType === 'string' ? c.pageType : '',
    status: typeof c.status === 'string' ? c.status : '',
    model: typeof c.model === 'string' ? c.model : '',
    ymyl: c.ymyl === true,
  };
}
