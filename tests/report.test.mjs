import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateHead } from '../modules/phase1-rules.js';
import { evaluateBody } from '../modules/phase1-body-rules.js';
import { evaluateHealth } from '../modules/phase1-health-rules.js';
import { buildSummary } from '../modules/summary.js';
import { toMarkdown, toCsv, csvCell, mdEscape, fileStem } from '../modules/report.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const CTX = { pageType: 'product', status: 'prelaunch', model: 'd2c' };
const results = () => ({
  head: evaluateHead(load('buranshvalley-product-head'), CTX),
  body: evaluateBody(load('buranshvalley-product-body'), CTX),
  health: evaluateHealth(load('buranshvalley-product-health'), CTX),
});
const META = { title: 'SEO page audit: A2 Ghee', url: 'https://buranshvalley.com/shop/a2-desi-cow-bilona-ghee/', date: '2026-10-06', context: CTX, auditor: 'Urvish', version: '1.0.0' };

test('Markdown report has verdict, grouped findings and passed list', () => {
  const md = toMarkdown(buildSummary(results(), CTX), META);
  assert.match(md, /^# SEO page audit: A2 Ghee/);
  assert.match(md, /\*\*Page context:\*\* Product · Pre-launch · D2C \/ ecommerce/);
  assert.match(md, /## Verdict\n\n\*\*Not ready to launch: 6 blockers\.\*\*/);
  assert.match(md, /## Fix before launch \(6\)/);
  assert.match(md, /## Ignore \(known trap\)/);
  assert.match(md, /## Passed \(\d+\)/);
  assert.match(md, /\\\[Manju bhatt\\\]/); // page text escaped, not turned into a Markdown link
});

test('Auditor overrides and notes flow into summary and exports', () => {
  const overrides = { 'body:links-phones': { verdict: 'fix-launch', note: 'Use 6397529948 everywhere' }, 'health:res-css': { verdict: 'review' } };
  const s = buildSummary(results(), CTX, overrides);
  const phones = s.all.find((f) => f.key === 'body:links-phones');
  assert.equal(phones.verdict, 'fix-launch');
  assert.equal(phones.suggested, 'fix');
  assert.equal(phones.edited, true);
  assert.match(s.overall.title, /7 blockers/);
  const md = toMarkdown(s, META);
  assert.match(md, /changed from: Fix\)/);
  assert.match(md, /> Note: Use 6397529948 everywhere/);
  const csv = toCsv(s);
  assert.ok(csv.startsWith('﻿"section","group","check"'));
  assert.match(csv, /"Fix","Fix before launch","Use 6397529948 everywhere"/);
});

test('CSV blocks spreadsheet formula injection and escapes quotes', () => {
  assert.equal(csvCell('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
  assert.equal(csvCell('+91 98'), '"\'+91 98"');
  assert.equal(csvCell('@SUM(A1)'), '"\'@SUM(A1)"');
  assert.equal(csvCell('plain, text'), '"plain, text"');
});

test('Markdown escaping neutralises links, HTML and tables', () => {
  assert.equal(mdEscape('[click](http://x) <img src=x> a|b'), '\\[click\\](http://x) \\<img src=x\\> a\\|b');
  assert.equal(mdEscape('line1\nline2'), 'line1 line2');
});

test('File names are safe', () => {
  assert.equal(fileStem('https://www.regus.com/en/in/mumbai?x=<script>', '2026-10-06'), 'audit-regus-com-en-in-mumbai-2026-10-06');
  assert.equal(fileStem('not a url', '2026-10-06'), 'audit-page-2026-10-06');
});
