// Report builder: turns a summary (with the auditor's edits) into Markdown and CSV.
// Pure functions, no DOM. Page data is untrusted, so both formats escape it.

import { VERDICTS } from './summary.js';

const ORDER = ['fix-now', 'fix-launch', 'manual', 'fix', 'later', 'review', 'ignore', 'ok'];
const PAGE_TYPE = { product: 'Product', service: 'Service', location: 'City / location', category: 'Category', homepage: 'Homepage', article: 'Blog / article', other: 'Other' };
const STATUS = { live: 'Live', prelaunch: 'Pre-launch' };
const MODEL = { d2c: 'D2C / ecommerce', b2b: 'B2B / lead gen', local: 'Local business', content: 'Content / media' };

// Markdown: neutralise characters that would turn page text into links, HTML,
// tables or formatting in the reader's Markdown viewer.
export function mdEscape(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/([\\`*_[\]{}<>|#!~])/g, '\\$1')
    .trim();
}

// CSV: quote every field, double inner quotes, and stop spreadsheet formula
// injection (a cell starting with = + - @ or a tab/CR runs as a formula in Excel/Sheets).
export function csvCell(value) {
  let s = String(value ?? '').replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function header(meta, summary) {
  const ctx = meta.context || {};
  const lines = [
    `# ${mdEscape(meta.title || 'SEO page audit')}`,
    '',
    `- **URL:** ${mdEscape(meta.url)}`,
    `- **Date:** ${mdEscape(meta.date)}`,
    `- **Page context:** ${PAGE_TYPE[ctx.pageType] || mdEscape(ctx.pageType)} · ${STATUS[ctx.status] || mdEscape(ctx.status)} · ${MODEL[ctx.model] || mdEscape(ctx.model)}`,
  ];
  if (meta.auditor) lines.push(`- **Auditor:** ${mdEscape(meta.auditor)}`);
  lines.push(`- **Tool:** Page Audit Lens v${mdEscape(meta.version)}`, '');
  lines.push('## Verdict', '', `**${mdEscape(summary.overall.title)}.** ${mdEscape(summary.overall.line)}`, '');
  const t = countByVerdict(summary.all);
  lines.push(ORDER.filter((v) => t[v]).map((v) => `${VERDICTS[v].label}: ${t[v]}`).join(' · '), '');
  return lines;
}

function countByVerdict(all) {
  const t = {};
  all.forEach((f) => { t[f.verdict] = (t[f.verdict] || 0) + 1; });
  return t;
}

function findingLines(f) {
  const edited = f.edited ? ` _(changed from: ${VERDICTS[f.suggested].label})_` : '';
  const lines = [`- **${mdEscape(f.check)}** (${f.sectionName}): ${mdEscape(f.value)}${edited}`, `  ${mdEscape(f.why)}`];
  if (f.note) lines.push(`  > Note: ${mdEscape(f.note)}`);
  if (f.items && f.items.length && f.verdict !== 'ignore' && f.verdict !== 'ok') {
    f.items.slice(0, 10).forEach((item) => lines.push(`  - ${mdEscape(item)}`));
    if (f.items.length > 10) lines.push(`  - …and ${f.items.length - 10} more`);
  }
  return lines;
}

export function toMarkdown(summary, meta) {
  const lines = header(meta, summary);
  const groups = ORDER.map((v) => [v, summary.all.filter((f) => f.verdict === v)]).filter(([, list]) => list.length);

  groups.forEach(([v, list]) => {
    if (v === 'ok') return;
    lines.push(`## ${VERDICTS[v].label} (${list.length})`, '');
    if (v === 'ignore') {
      lines.push('Flagged by crawlers but not problems on this page:', '');
      list.forEach((f) => lines.push(`- ${mdEscape(f.check)} (${f.sectionName}): ${mdEscape(f.value)}`));
    } else {
      list.forEach((f) => lines.push(...findingLines(f)));
    }
    lines.push('');
  });

  const ok = summary.all.filter((f) => f.verdict === 'ok');
  if (ok.length) {
    lines.push(`## Passed (${ok.length})`, '', ok.map((f) => mdEscape(f.check)).join(' · '), '');
  }
  lines.push('---', '', '_Generated with Page Audit Lens. Suggested verdicts reviewed by the auditor._', '');
  return lines.join('\n');
}

export const CSV_COLUMNS = ['section', 'group', 'check', 'value', 'flag', 'suggested_verdict', 'final_verdict', 'note', 'why', 'details', 'id'];

export function toCsv(summary) {
  const rows = [CSV_COLUMNS.map(csvCell).join(',')];
  summary.all.forEach((f) => {
    rows.push([
      f.sectionName, f.group, f.check, f.value, f.flag,
      VERDICTS[f.suggested].label, VERDICTS[f.verdict].label, f.note, f.why,
      (f.items || []).slice(0, 20).join(' | '), f.id,
    ].map(csvCell).join(','));
  });
  // BOM so Excel opens UTF-8 (₹, —, Hindi) correctly
  return `﻿${rows.join('\r\n')}\r\n`;
}

// Safe file name from a URL: host + path, letters/digits/dashes only
export function fileStem(url, date) {
  let base = 'page';
  try {
    const u = new URL(url);
    base = `${u.hostname.replace(/^www\./, '')}${u.pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'page';
  } catch { /* keep default */ }
  return `audit-${base}-${date}`.toLowerCase();
}
