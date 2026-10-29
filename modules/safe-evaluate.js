// Safety net for the rules layer. The side panel judges every section through
// safeEvaluate(): if a rules module meets page data it did not expect and
// throws (found by fuzz testing in v1.5.0), that one section shows a single
// "could not judge" finding and every other section still works.
// Pure function, no DOM.

import { finding } from './phase1-rules.js';

export function safeEvaluate(evaluate, data, ctx, extra) {
  try {
    const r = evaluate(data, ctx, extra);
    if (!r || !Array.isArray(r.groups) || !r.counts) throw new Error('the rules returned no result');
    return r;
  } catch (e) {
    const message = String((e && e.message) || e).slice(0, 160);
    const f = finding('rules-error', 'Checks could not run', 'Unexpected page data', 'info',
      `The rules for this section stopped on page data they did not expect (${message}). Other sections are still valid. Check this section by hand, and please report the page URL so the rule can be fixed.`,
      'Check by hand');
    return { groups: [{ id: 'error', title: 'Could not judge this section', findings: [f] }], counts: { critical: 0, warning: 0, good: 0, info: 1 }, error: message };
  }
}
