import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateBusiness, MODELS } from '../modules/business-rules.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}-signals.json`, import.meta.url)));
const byId = (r) => Object.fromEntries(r.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));

test('Seven business models are offered', () => {
  assert.deepEqual(Object.keys(MODELS), ['d2c', 'b2b', 'local', 'saas', 'marketplace', 'content', 'other']);
});

test('Buranshvalley as D2C: buy button, policies and trust pass; affiliate false alarm gone', () => {
  const f = byId(evaluateBusiness(load('buranshvalley-product'), { pageType: 'product', status: 'prelaunch', model: 'd2c' }));
  assert.equal(f['biz-contact'].flag, 'good');
  assert.equal(f['biz-buy'].flag, 'good');
  assert.equal(f['biz-buy-fold'].flag, 'info');
  assert.equal(f['biz-policies'].flag, 'good');
  assert.equal(f['biz-trust'].flag, 'good');
  assert.equal(f['biz-aff-rel'], undefined);
});

test('Buranshvalley with YMYL on: author and expert review needed, schema-only date flagged', () => {
  const f = byId(evaluateBusiness(load('buranshvalley-product'), { pageType: 'product', status: 'prelaunch', model: 'd2c', ymyl: true }));
  assert.equal(f['ymyl-author'].flag, 'warning');
  assert.equal(f['ymyl-review'].flag, 'warning');
  assert.equal(f['ymyl-date'].flag, 'warning');
  assert.match(f['ymyl-date'].value, /Only in schema/);
});

test('Regus as B2B: lead capture good, proof missing', () => {
  const f = byId(evaluateBusiness(load('regus-mumbai'), { pageType: 'location', status: 'live', model: 'b2b' }));
  assert.equal(f['biz-lead'].flag, 'good');
  assert.equal(f['biz-call'].flag, 'good');
  assert.equal(f['biz-trust'].flag, 'warning');
});

test('Same page, different model: Regus judged as local business needs NAP and LocalBusiness schema', () => {
  const f = byId(evaluateBusiness(load('regus-mumbai'), { pageType: 'location', status: 'live', model: 'local' }));
  assert.equal(f['biz-nap'].flag, 'warning');
  assert.equal(f['biz-schema'].flag, 'warning');
});

test('Local dentist (synthetic): complete NAP and schema; YMYL author with credentials passes', () => {
  const f = byId(evaluateBusiness(load('synthetic-local-dentist'), { pageType: 'service', status: 'live', model: 'local', ymyl: true }));
  assert.equal(f['biz-nap'].flag, 'good');
  assert.equal(f['biz-phone-text'].flag, 'info');
  assert.match(f['biz-schema'].value, /Dentist · missing geo/);
  assert.equal(f['biz-map'].flag, 'good');
  assert.equal(f['ymyl-author'].flag, 'good');
});

test('Local page with nothing: contact, NAP, schema and call action all flagged', () => {
  const f = byId(evaluateBusiness(load('synthetic-local-missing'), { pageType: 'service', status: 'live', model: 'local' }));
  ['biz-contact', 'biz-nap', 'biz-schema', 'biz-local-cta'].forEach((id) => assert.equal(f[id].flag, 'warning', id));
});

test('SaaS (synthetic): pricing, trial and schema found', () => {
  const f = byId(evaluateBusiness(load('synthetic-saas'), { pageType: 'homepage', status: 'live', model: 'saas' }));
  assert.equal(f['biz-pricing'].flag, 'good');
  assert.equal(f['biz-signup'].flag, 'good');
  assert.equal(f['biz-schema'].flag, 'good');
});

test('Affiliate article (synthetic): unlabelled affiliate links and missing author flagged', () => {
  const f = byId(evaluateBusiness(load('synthetic-affiliate-ymyl'), { pageType: 'article', status: 'live', model: 'content', ymyl: true }));
  assert.equal(f['biz-aff-rel'].flag, 'warning');
  assert.match(f['biz-aff-rel'].value, /2 of 3/);
  assert.equal(f['biz-author'].flag, 'warning');
  assert.match(f['biz-date'].value, /Only in schema/);
});

test('Other / mixed runs only the common checks', () => {
  const r = evaluateBusiness(load('regus-mumbai'), { pageType: 'location', status: 'live', model: 'other' });
  assert.deepEqual(r.groups.map((g) => g.id), ['biz-contact']);
});
