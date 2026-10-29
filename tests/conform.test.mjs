// conform(): puts collector data into the shape the rules expect, so damaged
// or unusual data cannot crash them. Must be the identity on every real capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { conform, inferSchema } from '../modules/conform.js';
import { SCHEMAS } from '../modules/schemas.js';
import { buildSchemas } from '../scripts/build-schemas.mjs';

const dir = new URL('./fixtures/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, dir)));

test('conform: containers get the expected type, null stays null only where allowed', () => {
  const s = inferSchema([{ a: 'x', n: 1, list: ['p'], obj: { k: true }, maybe: null }, { a: 'y', n: 2, list: [], obj: { k: false }, maybe: { z: 1 } }]);
  assert.deepEqual(conform({ a: 5, n: '7', list: 'oops', obj: 'nope', maybe: 'bad' }, s), { a: '5', n: 7, list: [], obj: { k: false }, maybe: null });
  assert.deepEqual(conform({ a: null, n: NaN, list: [3, null], obj: null, maybe: null }, s), { a: '', n: 0, list: ['3', ''], obj: { k: false }, maybe: null });
  // required keys come back with a default; unknown keys pass through untouched
  assert.deepEqual(conform({ extra: [1] }, s), { a: '', n: 0, list: [], obj: { k: false }, maybe: null, extra: [1] });
  // wrong top-level type
  assert.deepEqual(conform('junk', s), { a: '', n: 0, list: [], obj: { k: false }, maybe: null });
});

test('conform: optional keys stay absent, objects/arrays inside arrays are fixed, __proto__ is dropped', () => {
  const s = inferSchema([{ items: [{ id: 'a', lazy: true }, { id: 'b' }] }]);
  assert.deepEqual(conform({ items: [{ id: 'c' }, 'x', null] }, s), { items: [{ id: 'c' }, { id: '' }, { id: '' }] });
  const evil = JSON.parse('{"items": [], "__proto__": {"polluted": 1}}');
  const out = conform(evil, s);
  assert.equal(({}).polluted, undefined);
  assert.equal(out.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});

test('conform: values seen with several types, or never seen, are left alone', () => {
  const s = inferSchema([{ v: 'a', empty: [] }, { v: 3, empty: [] }]);
  assert.deepEqual(conform({ v: { any: 1 }, empty: [{ odd: 1 }] }, s), { v: { any: 1 }, empty: [{ odd: 1 }] });
});

const SECTION = { head: 'head', body: 'body', health: 'health', signals: 'signals', network: 'network', rendering: 'rendering' };
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f, f])
  .concat(readdirSync(new URL('captured/', dir)).map((f) => [`captured/${f}`, f]));

test('conform is the identity on every real capture (real data is never changed)', () => {
  let checked = 0;
  fixtures.forEach(([path, file]) => {
    const section = Object.keys(SECTION).find((k) => file.endsWith(`-${k}.json`));
    if (!section) return;
    const data = read(path);
    assert.deepEqual(conform(data, SCHEMAS[section]), data, path);
    checked += 1;
  });
  assert.ok(checked >= 40, `checked ${checked} captures`);
});

test('modules/schemas.js is up to date with the fixtures (npm run build:schemas)', () => {
  assert.deepEqual(SCHEMAS, buildSchemas());
});
