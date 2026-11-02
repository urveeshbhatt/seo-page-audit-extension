// Business-model rules (v1.1): what a page needs to earn money for THIS kind
// of business. Same finding shape as the other rule files. Pure functions.

import { finding, isPrelaunch } from './phase1-rules.js';
import { conform, contextOf } from './conform.js';
import { SCHEMAS } from './schemas.js';

export const MODELS = {
  d2c: 'D2C / ecommerce',
  b2b: 'B2B / lead gen',
  local: 'Local business',
  saas: 'SaaS / software',
  marketplace: 'Marketplace / listings',
  content: 'Content / affiliate / blog',
  other: 'Other / mixed',
};

const yesNo = (list) => list.filter(([, ok]) => ok).map(([name]) => name);
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);

// ---------------- common: can a visitor reach the business? ----------------

function contactFindings(s, ctx) {
  const c = s.contact;
  const ways = yesNo([
    ['call link', c.tel > 0], ['email', c.mail > 0], ['WhatsApp', c.whatsapp > 0],
    ['lead form', c.leadForms > 0], ['contact page link', c.contactLinks > 0],
  ]);
  if (ways.length) {
    return [finding('biz-contact', 'Ways to reach you', ways.join(', '), 'good', 'Visitors who are ready to act can reach the business from this page.')];
  }
  const strict = ['b2b', 'local', 'saas'].includes(ctx.model);
  return [finding('biz-contact', 'Ways to reach you', 'None found', strict ? 'warning' : 'info',
    'No phone, email, WhatsApp, form or contact link. Ready buyers have nowhere to go.')];
}

// ---------------- D2C / ecommerce ----------------

function d2cFindings(s, ctx) {
  const out = [];
  const buy = s.ctas.buy;
  if (ctx.pageType === 'product') {
    if (buy.visible) {
      out.push(finding('biz-buy', 'Buy button', `${buy.visible} visible ("${buy.sample}")`, 'good', 'A clear way to buy on the product page.'));
      if (!buy.aboveFold) {
        out.push(finding('biz-buy-fold', 'Buy button position', 'Not in the first screen', 'info',
          'At the current panel width the buy button sits below the first screen. On mobile, keep price and Add to cart visible without scrolling, or use a sticky bar.'));
      }
    } else {
      out.push(finding('biz-buy', 'Buy button', buy.count ? `${buy.count} found, none visible` : 'None found',
        isPrelaunch(ctx) ? 'warning' : 'critical', 'No visible Add to cart / Buy now on a product page. Every visit is a lost sale.',
        isPrelaunch(ctx) ? 'Launch blocker' : undefined));
    }
  }
  const p = s.policies;
  const missing = yesNo([['returns / refund', !p.refund], ['shipping', !p.shipping]]);
  if (missing.length) {
    out.push(finding('biz-policies', 'Store policies', `Missing: ${missing.join(', ')}`, 'warning',
      'Buyers look for returns and shipping before paying, and Google Merchant Center needs both pages. Link them in the footer.'));
  } else {
    out.push(finding('biz-policies', 'Store policies', 'Returns and shipping linked', 'good', 'Policy pages are one click away.'));
  }
  const proof = yesNo([['reviews / testimonials', s.trust.testimonials], ['certifications', s.trust.certifications]]);
  out.push(proof.length
    ? finding('biz-trust', 'Trust signals', proof.join(', '), 'good', 'Proof near the buy decision lifts conversion.')
    : finding('biz-trust', 'Trust signals', 'None found', 'warning', 'No reviews, ratings or certifications on the page. New D2C brands need proof more than anyone.'));
  return out;
}

// ---------------- B2B / lead gen ----------------

function b2bFindings(s) {
  const out = [];
  const lead = s.ctas.lead;
  const demo = s.ctas.demo;
  const visibleCtas = lead.visible + demo.visible;
  if (visibleCtas || s.contact.leadFormVisible) {
    const parts = [];
    if (visibleCtas) parts.push(`${visibleCtas} CTA${visibleCtas === 1 ? '' : 's'} ("${lead.sample || demo.sample}")`);
    if (s.contact.leadFormVisible) parts.push('lead form');
    out.push(finding('biz-lead', 'Lead capture', parts.join(' + '), 'good', 'Visitors can ask for a quote or a call from this page.'));
    if (!lead.aboveFold && !demo.aboveFold) {
      out.push(finding('biz-lead-fold', 'CTA position', 'No CTA in the first screen', 'info', 'Put the main call to action (quote, call, tour) in the first screen as well as lower down.'));
    }
  } else {
    out.push(finding('biz-lead', 'Lead capture', 'No visible CTA or form', 'warning', 'No "Get a quote", "Contact us" or form visible. Traffic to this page cannot turn into leads.'));
  }
  out.push(s.contact.telVisible
    ? finding('biz-call', 'Click to call', s.contact.telSample.replace(/^tel:/, ''), 'good', 'Mobile visitors can call in one tap.')
    : finding('biz-call', 'Click to call', 'None', 'info', 'Add a tel: link. Many B2B buyers in India prefer to call first.'));
  const proof = yesNo([['case studies', s.trust.caseStudies], ['client names / logos', s.trust.clients], ['testimonials', s.trust.testimonials], ['certifications', s.trust.certifications]]);
  out.push(proof.length
    ? finding('biz-trust', 'Proof', proof.join(', '), 'good', 'Proof answers "have they done this for someone like me?"')
    : finding('biz-trust', 'Proof', 'None found on this page', 'warning', 'No case studies, client logos or testimonials. B2B buyers shortlist on proof. Add one strong example near the CTA.'));
  return out;
}

// ---------------- Local business ----------------

function localFindings(s) {
  const out = [];
  const l = s.local;
  const hasPhone = s.contact.tel > 0 || !!s.contact.phoneText;
  const hasAddress = l.addressEl || l.addressText || s.schema.hasAddress;
  const missing = yesNo([['phone', !hasPhone], ['address', !hasAddress]]);
  if (missing.length) {
    out.push(finding('biz-nap', 'Name, address, phone (NAP)', `Missing: ${missing.join(', ')}`, 'warning',
      'Local rankings and Google Business Profile trust depend on the same name, address and phone everywhere. Show them as text on the page.'));
  } else {
    out.push(finding('biz-nap', 'Name, address, phone (NAP)', 'Phone and address on the page', 'good', 'Visitors and Google can match this page to the business listing.'));
  }
  if (s.contact.tel && !s.contact.phoneText) {
    out.push(finding('biz-phone-text', 'Phone as text', 'Only behind a Call button', 'info', 'Show the number as text too. Google reads it for NAP matching and desktop users cannot tap a call button.'));
  }

  const sc = s.schema;
  if (!sc.localBusiness) {
    out.push(finding('biz-schema', 'LocalBusiness schema', 'Not found', 'warning',
      'Add LocalBusiness (or a subtype like Dentist, Restaurant) with name, address, telephone, geo and openingHours. Rank Math: Titles & Meta → Local SEO.'));
  } else {
    const gaps = yesNo([['address', !sc.hasAddress], ['telephone', !sc.telephone], ['openingHours', !sc.openingHours], ['geo', !sc.geo]]);
    out.push(gaps.length
      ? finding('biz-schema', 'LocalBusiness schema', `${sc.localBusiness} · missing ${gaps.join(', ')}`, gaps.includes('address') || gaps.includes('telephone') ? 'warning' : 'info', 'Fill the missing fields so the schema matches the Google Business Profile.')
      : finding('biz-schema', 'LocalBusiness schema', sc.localBusiness, 'good', 'Complete local business markup.'));
  }
  if (sc.telephone && s.contact.phoneText && digits(sc.telephone) !== digits(s.contact.phoneText)) {
    out.push(finding('biz-phone-match', 'Phone consistency', `Schema ${sc.telephone} vs page ${s.contact.phoneText}`, 'warning', 'Different numbers in schema and on the page. Use one number everywhere (page, schema, Google Business Profile).'));
  }
  out.push(l.mapEmbed || l.mapLink
    ? finding('biz-map', 'Map / directions', l.mapEmbed ? 'Map embedded' : 'Directions link', 'good', 'Visitors can find the location in one tap.')
    : finding('biz-map', 'Map / directions', 'None', 'info', 'Add a Google Maps link or embed for the exact location.'));
  out.push(l.hoursText || sc.openingHours
    ? finding('biz-hours', 'Opening hours', 'Shown', 'good', 'Hours answer the most common local question.')
    : finding('biz-hours', 'Opening hours', 'Not found', 'info', 'Show opening hours on the page and in schema.'));
  const act = s.ctas.appointment.visible + s.contact.telVisible;
  if (!act) {
    out.push(finding('biz-local-cta', 'Booking or call action', 'None visible', 'warning', 'No visible "Call now", "Book appointment" or "Get directions". Local visitors decide in seconds.'));
  }
  return out;
}

// ---------------- SaaS ----------------

function saasFindings(s) {
  const out = [];
  out.push(s.saas.pricingLink
    ? finding('biz-pricing', 'Pricing page link', 'Linked', 'good', 'Buyers can check pricing without talking to sales.')
    : finding('biz-pricing', 'Pricing page link', 'Not found', 'warning', 'No link to pricing. "Pricing" is one of the most searched and clicked pages on SaaS sites.'));
  const t = s.ctas.trial;
  const d = s.ctas.demo;
  if (t.visible || d.visible) {
    out.push(finding('biz-signup', 'Sign-up / demo CTA', [t.visible && `"${t.sample}"`, d.visible && `"${d.sample}"`].filter(Boolean).join(' + '), 'good', 'Clear next step for a ready buyer.'));
    if (!t.aboveFold && !d.aboveFold) out.push(finding('biz-signup-fold', 'CTA position', 'Not in the first screen', 'info', 'Repeat the trial or demo button in the first screen.'));
  } else {
    out.push(finding('biz-signup', 'Sign-up / demo CTA', 'None visible', 'warning', 'No "Start free trial" or "Book a demo". The page explains but does not convert.'));
  }
  out.push(s.schema.software
    ? finding('biz-schema', 'SoftwareApplication schema', 'Found', 'good', 'Eligible for software rich results (price, rating).')
    : finding('biz-schema', 'SoftwareApplication schema', 'Not found', 'info', 'Add SoftwareApplication with offers and aggregateRating on product and pricing pages.'));
  const proof = yesNo([['case studies', s.trust.caseStudies], ['customer logos', s.trust.clients], ['reviews', s.trust.testimonials]]);
  out.push(proof.length
    ? finding('biz-trust', 'Proof', proof.join(', '), 'good', 'Social proof near the CTA.')
    : finding('biz-trust', 'Proof', 'None found', 'info', 'Add customer logos, a case study or G2/Capterra reviews.'));
  return out;
}

// ---------------- Marketplace / listings ----------------

function marketplaceFindings(s, ctx) {
  const out = [];
  const l = s.listing;
  const isList = ['category', 'location', 'homepage', 'other'].includes(ctx.pageType);
  if (isList) {
    out.push(l.relNext || l.pageLinks
      ? finding('biz-paging', 'Pagination', `${l.pageLinks} page links${l.relNext ? ' · rel=next' : ''}`, 'info', 'Check page 2+ is indexable with a self-referencing canonical (not pointing to page 1), and listings are real <a href> links.')
      : finding('biz-paging', 'Pagination', 'None found', 'info', 'If this list has more items than shown, make sure deeper pages are reachable with crawlable links, not only "Load more" buttons.'));
    out.push(s.schema.itemList
      ? finding('biz-itemlist', 'ItemList schema', 'Found', 'good', 'Listings are described for Google.')
      : finding('biz-itemlist', 'ItemList schema', 'Not found', 'info', 'Consider ItemList schema on listing pages.'));
  }
  if (l.paramLinks) {
    out.push(finding('biz-facets', 'Filter and sort links', `${l.paramLinks} links with sort/filter parameters`, l.paramLinks > 20 ? 'warning' : 'info',
      'Each filter combination is a new URL. Without canonical or noindex rules they create thousands of thin duplicates and waste crawl budget.'));
  }
  return out;
}

// ---------------- Content / affiliate ----------------

function contentFindings(s, ctx) {
  const out = [];
  const o = s.outbound;
  if (o.affiliate) {
    out.push(o.affiliateNoRel
      ? finding('biz-aff-rel', 'Affiliate link labels', `${o.affiliateNoRel} of ${o.affiliate} without rel="sponsored"`, 'warning',
        'Google requires paid and affiliate links to carry rel="sponsored" (or nofollow). Unlabelled ones risk a manual action.', null, o.affiliateSamples)
      : finding('biz-aff-rel', 'Affiliate link labels', `${o.affiliate} labelled`, 'good', 'Affiliate links are marked sponsored/nofollow.'));
  }
  const isArticle = ctx.pageType === 'article';
  const a = s.authorship;
  const hasAuthor = a.authorEl || a.authorText || s.schema.author;
  if (isArticle) {
    out.push(hasAuthor
      ? finding('biz-author', 'Author byline', s.schema.authorName || 'Found', 'good', 'A named author supports E-E-A-T.')
      : finding('biz-author', 'Author byline', 'Not found', 'warning', 'No visible author. Add a byline linked to an author page with real experience.'));
    const schemaDate = s.schema.dateModified || s.schema.datePublished;
    if (a.dateEl || a.updatedText) {
      out.push(finding('biz-date', 'Published / updated date', 'Shown on page', 'good', 'Readers and Google can see how fresh this is.'));
    } else {
      out.push(finding('biz-date', 'Published / updated date', schemaDate ? `Only in schema (${schemaDate.slice(0, 10)})` : 'Not found', 'info',
        'Show a visible "Last updated" date, especially on "best X (year)" pages.'));
    }
    out.push(s.schema.article
      ? finding('biz-article', 'Article schema', 'Found', 'good', 'Article markup present.')
      : finding('biz-article', 'Article schema', 'Not found', 'info', 'Add Article or BlogPosting schema with author and dates.'));
  }
  return out;
}

// ---------------- YMYL topic (any model) ----------------

function ymylFindings(s) {
  const out = [];
  const a = s.authorship;
  const hasAuthor = a.authorEl || a.authorText || s.schema.author;
  out.push(hasAuthor && a.credentials
    ? finding('ymyl-author', 'Expert author', 'Named author with credentials', 'good', 'Health, money and legal content needs a qualified, named expert.')
    : finding('ymyl-author', 'Expert author', hasAuthor ? 'Author found, no credentials shown' : 'No author found', 'warning',
      'Google holds health, finance and legal pages to a higher bar. Show who wrote it and why they are qualified (doctor, CA, dietitian, lawyer).'));
  out.push(a.reviewedText || s.schema.reviewedBy
    ? finding('ymyl-review', 'Expert review', 'Reviewed-by shown', 'good', 'An expert review line adds trust.')
    : finding('ymyl-review', 'Expert review', 'Not found', 'warning', 'Add "Reviewed by <expert>, <qualification>" for claims about health, safety or money.'));
  const schemaDate = s.schema.dateModified || s.schema.datePublished;
  out.push(a.dateEl || a.updatedText
    ? finding('ymyl-date', 'Last updated', 'Shown on page', 'good', 'Freshness is visible.')
    : finding('ymyl-date', 'Last updated', schemaDate ? `Only in schema (${schemaDate.slice(0, 10)})` : 'Not shown', 'warning',
      'Show a visible "Last updated" or "Reviewed on" date. Readers of health, money and legal advice need to know it is current.'));
  out.push(s.outbound.citations
    ? finding('ymyl-sources', 'Authoritative sources', `${s.outbound.citations} links (gov, edu, journals)`, 'good', 'Claims are backed by trusted sources.')
    : finding('ymyl-sources', 'Authoritative sources', 'None linked', 'info', 'Link the studies or official sources behind your claims (ICMR, FSSAI, PubMed, RBI, government sites).'));
  return out;
}

// ---------------- public ----------------

const MODEL_RULES = {
  d2c: ['Selling (D2C)', d2cFindings],
  b2b: ['Lead generation (B2B)', b2bFindings],
  local: ['Local SEO', localFindings],
  saas: ['SaaS conversion', saasFindings],
  marketplace: ['Listings', marketplaceFindings],
  content: ['Content and affiliate', contentFindings],
};

export function evaluateBusiness(data, context) {
  const s = conform(data, SCHEMAS.signals);
  const ctx = contextOf(context);
  const groups = [{ id: 'biz-contact', title: 'Contact paths', findings: contactFindings(s, ctx) }];
  const rule = MODEL_RULES[ctx.model];
  if (rule) groups.push({ id: `biz-${ctx.model}`, title: rule[0], findings: rule[1](s, ctx) });
  if (ctx.model !== 'content' && s.outbound.affiliate && s.outbound.affiliateNoRel) {
    // Affiliate links matter for every model, not just content sites
    groups.push({ id: 'biz-aff', title: 'Affiliate links', findings: contentFindings(s, { ...ctx, pageType: 'none' }) });
  }
  if (ctx.ymyl) groups.push({ id: 'ymyl', title: 'YMYL trust (health, money, legal)', findings: ymylFindings(s) });
  const filtered = groups.filter((g) => g.findings.length);
  const counts = { critical: 0, warning: 0, good: 0, info: 0 };
  filtered.forEach((g) => g.findings.forEach((f) => { counts[f.flag] += 1; }));
  return { groups: filtered, counts };
}
