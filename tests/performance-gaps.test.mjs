// Phase 4 gaps found while teaching Day 4 Parts 3–4 (Nov 2026): the extension
// said "image too big" but not why, never said "too small", ignored the format,
// and missed fonts / preloads that are downloaded but never used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluatePerformance, imageCause } from '../modules/phase4-rules.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const byId = (result) => Object.fromEntries(result.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));
const LIVE = { pageType: 'product', status: 'live', model: 'd2c' };
const base = () => { const d = load('gheeshop-product-performance'); d.images = []; d.fonts = { files: [], preloaded: 0, faces: [], unreadableSheets: 0 }; d.preloads = []; return d; };
const img = (o) => ({ src: 'https://shop.example/cdn/a.png?width=832', selector: 'img.a', inViewport: false, positioned: false, lazy: false, hasSize: true, natural: 412, shown: 200, dpr: 2, bytes: 85000, ...o });

// ---------------- why an image is the wrong size ----------------

test('imageCause names a sizes slot that is wider than the image is shown', () => {
  assert.match(imageCause(img({ slot: 412, file: 832, widths: [240, 352, 832, 1200] })), /sizes says 412 px, shown at 200 px/);
});

test('imageCause names a gap in srcset when even the right slot lands on a far bigger file', () => {
  // needs 400; the next file up is 832
  assert.match(imageCause(img({ slot: 412, file: 832, widths: [240, 352, 832, 1200] })), /no file between 352 and 832/);
  // Olive Shop: srcset has 375w, so only sizes is wrong
  const oliveshop = imageCause(img({ shown: 178, slot: 412, file: 750, widths: [256, 300, 375, 512, 600, 750] }));
  assert.match(oliveshop, /sizes says 412 px/);
  assert.doesNotMatch(oliveshop, /no file between/);
});

test('imageCause says when there is no srcset at all', () => {
  assert.match(imageCause(img({ file: 1200, widths: [] })), /no srcset: one file for every screen/);
});

test('too big uses the true file width; old captures without file fall back to natural', () => {
  const d = base();
  d.images = [img({ slot: 412, file: 832, widths: [240, 352, 832, 1200] })];
  const f = byId(evaluatePerformance(d, LIVE))['perf-img-big'];
  assert.ok(f, 'flagged from file width (832 for 400 needed) although natural is 412');
  assert.match(f.items[0], /832 px file shown at 200 px · needs 400 px/);
  const old = base();
  old.images = [{ src: 'x.jpg', selector: 'img', natural: 1200, shown: 200, dpr: 2, hasSize: true }];
  assert.ok(byId(evaluatePerformance(old, LIVE))['perf-img-big']);
});

// ---------------- too small (blurry) ----------------

test('a visible image whose file is far smaller than needed is flagged as blurry, with the cause', () => {
  const d = base();
  d.images = [img({ src: 'katori-300x300.jpg', shown: 360, slot: 103, file: 300, widths: [300], bytes: 8000 })];
  const f = byId(evaluatePerformance(d, LIVE))['perf-img-blurry'];
  assert.equal(f.flag, 'info');
  assert.match(f.items[0], /300 px file shown at 360 px · needs 720 px/);
  assert.match(f.items[0], /sizes says 103 px/);
});

test('small icons and slightly soft images are not blurry noise', () => {
  const d = base();
  d.images = [img({ shown: 40, file: 32 }), img({ shown: 300, file: 500 })]; // icon; 500 of 600 needed
  assert.equal(byId(evaluatePerformance(d, LIVE))['perf-img-blurry'], undefined);
});

// ---------------- format ----------------

test('photos delivered as PNG/JPEG over 30 KB are flagged; WebP, AVIF, SVG and small files are not', () => {
  const d = base();
  d.images = [
    img({ src: 'photo.png', type: 'image/png', bytes: 270000 }),
    img({ src: 'jar.jpg', type: 'image/jpeg', bytes: 90000 }),
    img({ src: 'logo.png', type: 'image/png', bytes: 4000 }),
    img({ src: 'card.png?width=832', type: 'image/webp', bytes: 85000 }), // Shopify: .png name, WebP delivered
    img({ src: 'icon.svg', type: 'image/svg+xml', bytes: 50000 }),
    img({ src: 'old.jpg', bytes: 90000 }), // no type (older Chrome): not judged
  ];
  const f = byId(evaluatePerformance(d, LIVE))['perf-img-format'];
  assert.equal(f.flag, 'warning');
  assert.equal(f.items.length, 2);
  assert.ok(f.items.some((x) => /photo\.png · PNG · 270 KB/.test(x)));
  assert.ok(f.items.some((x) => /jar\.jpg · JPEG/.test(x)));
});

// ---------------- fonts downloaded but not used ----------------

test('a font file downloaded for a face no text uses is flagged, with preload noted', () => {
  const d = base();
  d.fonts.files = [{ url: 'https://s.example/f/anonymouspro_n4.woff2', host: 's.example', bytes: 22000 }, { url: 'https://s.example/f/poppins_n3.woff2', host: 's.example', bytes: 9000 }];
  d.fonts.faces = [
    { family: 'Anonymous Pro', display: 'swap', inline: false, status: 'unloaded', urls: ['https://s.example/f/anonymouspro_n4.woff2'] },
    { family: 'Anonymous Pro', display: 'swap', inline: false, status: 'unloaded', urls: ['https://s.example/f/anonymouspro_n7.woff2'] }, // never downloaded: fine
    { family: 'Poppins', display: 'swap', inline: false, status: 'loaded', urls: ['https://s.example/f/poppins_n3.woff2'] },
  ];
  d.preloads = [{ url: 'https://s.example/f/anonymouspro_n4.woff2', as: 'font', used: null }];
  const f = byId(evaluatePerformance(d, LIVE))['perf-font-unused'];
  assert.equal(f.flag, 'warning');
  assert.match(f.value, /Anonymous Pro/);
  assert.equal(f.items.length, 1);
  assert.match(f.items[0], /anonymouspro_n4\.woff2 · 22 KB · preloaded/);
});

test('fonts from old captures without status are not judged', () => {
  const d = base();
  d.fonts.files = [{ url: 'https://s.example/f/a.woff2', bytes: 9000 }];
  d.fonts.faces = [{ family: 'A', display: 'swap', inline: false }];
  assert.equal(byId(evaluatePerformance(d, LIVE))['perf-font-unused'], undefined);
});

// ---------------- preloads not used ----------------

test('preloads nothing on the page used are listed; font preloads are left to the font check', () => {
  const d = base();
  d.preloads = [
    { url: 'https://s.example/a.png', as: 'image', used: false },
    { url: 'https://s.example/b.css', as: 'style', used: false },
    { url: 'https://s.example/c.js', as: 'script', used: true },
    { url: 'https://s.example/f.woff2', as: 'font', used: null },
  ];
  const f = byId(evaluatePerformance(d, LIVE))['perf-preload-unused'];
  assert.equal(f.flag, 'info');
  assert.deepEqual(f.items, ['image · a.png', 'style · b.css']);
});

test('broken shapes in the new fields never crash the rules', () => {
  for (const junk of [null, 5, 'x', [null], [{}], [{ url: 5, as: {}, used: 'yes' }]]) {
    const d = base();
    d.preloads = junk;
    d.images = [img({ widths: junk, slot: 'x', file: {} , type: 7 })];
    d.fonts.faces = [{ family: 'A', status: junk, urls: junk }];
    assert.doesNotThrow(() => evaluatePerformance(d, LIVE));
  }
});

// ---------------- live test round, 2 Nov 2026 (hillshoporganics, Olive Shop, Groom Shop, Buranshvalley) ----------------

test('imageCause explains a sizes slot only a little wider than shown that tips the browser to the next file (Hill Shop footer logo)', () => {
  // shown 175 at 2x needs 350, and the 352 file would fit; but sizes says 207 → 414 px needed → 832
  const why = imageCause(img({ shown: 175, slot: 207, file: 832, widths: [240, 352, 832, 1200, 1600] }));
  assert.match(why, /sizes says 207 px/);
  assert.match(why, /414 px/);
  assert.match(why, /352/);
  assert.match(why, /832/);
  // Chrome reports DPR 2.0000000298 under emulation: print it short
  assert.match(imageCause(img({ shown: 175, dpr: 2.0000000298023224, slot: 207, file: 832, widths: [240, 352, 832] })), /at 2x/);
});

test('imageCause says a cached larger file was reused when the file is bigger than what sizes asks for', () => {
  // sizes asks 200 → 400 px → 832 would be picked by the gap rule, but the file is 1600 (cache)
  const why = imageCause(img({ shown: 200, slot: 200, file: 1600, widths: [400, 832, 1600] }));
  assert.match(why, /cache/);
});

test('a font file shared by a used weight and an unused weight is not "unused" (Buranshvalley Hanken Grotesk)', () => {
  const d = base();
  const url = 'https://shop.example/fonts/hanken-latin.woff2';
  d.fonts.files = [{ url, host: 'shop.example', bytes: 35000 }];
  d.fonts.faces = [
    { family: 'Hanken Grotesk', weight: '400', display: 'swap', inline: false, status: 'unloaded', urls: [url] },
    { family: 'Hanken Grotesk', weight: '600', display: 'swap', inline: false, status: 'loaded', urls: [url] },
  ];
  assert.equal(byId(evaluatePerformance(d, LIVE))['perf-font-unused'], undefined);
});

test('images hidden behind a pop-up are reported instead of silently missing (Olive Shop discount pop-up)', () => {
  const d = base();
  d.imageScan = { total: 82, measured: 0, hidden: 43, pageHidden: 'BODY opacity 0' };
  const f = byId(evaluatePerformance(d, LIVE))['perf-img-hidden'];
  assert.ok(f, 'finding raised');
  assert.equal(f.flag, 'info');
  assert.match(f.value, /43 images/);
  assert.match(f.items.join(' '), /BODY opacity 0/);
  // a normal page with a few hidden slides says nothing
  const ok = base();
  ok.images = [img({})];
  ok.imageScan = { total: 30, measured: 25, hidden: 5, pageHidden: '' };
  assert.equal(byId(evaluatePerformance(ok, LIVE))['perf-img-hidden'], undefined);
});
