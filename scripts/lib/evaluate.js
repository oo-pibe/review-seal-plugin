import { passesFor } from './config.js';
import { validateEntry } from './ledger.js';

const selfReviewAfterCutoff = (e, cfg) => Boolean(cfg.independentFrom) && e.at >= cfg.independentFrom && e.reviewer !== 'independent';

const DAY_MS = 86_400_000;

// Do open findings block for this pass? Its own setting, else the top-level one.
export const blocksOnFindings = (pass, cfg) => cfg.passes[pass]?.blockOnFindings ?? cfg.blockOnFindings;

// Why a review has expired with time, or null. Without `today` nothing expires, so callers that
// only care about content (the edit hook) are unaffected.
export function expiryReason(e, pass, cfg, { today, reviewBy } = {}) {
  if (!today) return null;
  const max = cfg.passes[pass]?.maxAgeDays;
  if (max && (Date.parse(today) - Date.parse(e.at)) / DAY_MS > max) return `reviewed ${e.at}, older than ${max} days`;
  if (reviewBy && today >= reviewBy && e.at < reviewBy) return `reviewed ${e.at}, before the file's review-by date ${reviewBy}`;
  return null;
}

// Does this (file, pass) need a new independent review? Used by the auto-reviewer and the hook.
// opts.today (and opts.reviewBy, the file's review-by date) also count reviews that have expired with time.
export function needsReview(file, pass, ledger, { contentHash, rubricHash }, cfg, opts = {}) {
  const e = (ledger[file] || {})[pass];
  if (!e) return true;
  if (validateEntry(file, pass, e).length) return true;
  if (e.contentHash !== contentHash || e.rubricHash !== rubricHash) return true;
  return selfReviewAfterCutoff(e, cfg) || Boolean(expiryReason(e, pass, cfg, opts));
}

// items: [{ file, contentHash, rubricHashes: { pass: hash }, reviewBy?, change }]. change is { substantive, why, sample? },
// or a function from a ledger entry to one (how far the file has moved from the version that entry reviewed).
// With `today` (YYYY-MM-DD), reviews past the pass's maxAgeDays or the file's review-by date block as 'expired'.
// opts.expiredSoft (the pre-commit check): an expired review only warns when the staged change is trivial, like 'stale'.
export function evaluate(items, ledger, cfg, today = null, { expiredSoft = false } = {}) {
  const blocks = [];
  const warnings = [];
  const counts = { independent: 0, builder: 0 };
  for (const it of items) {
    for (const pass of passesFor(it.file, cfg)) {
      const e = (ledger[it.file] || {})[pass];
      const at = { file: it.file, pass };
      // A version with no review at all is never let through: the trivial/substantive softening below is about
      // how far a reviewed file has moved since its review, and there is nothing to measure from here.
      if (!e) {
        blocks.push({ ...at, reason: 'never-reviewed', message: 'never reviewed' });
        continue;
      }
      const problems = validateEntry(it.file, pass, e);
      if (problems.length) {
        blocks.push({ ...at, reason: 'invalid', message: problems.join('; ') });
        continue;
      }
      counts[e.reviewer]++;
      let change;
      const measure = () => (change ??= typeof it.change === 'function' ? it.change(e) : it.change);
      const soft = () => !measure().substantive;
      const why = () => measure().why + (measure().sample ? `: "${measure().sample}"` : '');
      const because = () => (why() ? ` (${why()})` : '');
      // Every rule is checked on its own so a soft result never hides a hard one.
      if (e.contentHash !== it.contentHash) {
        (soft() ? warnings : blocks).push({ ...at, reason: 'stale', message: `reviewed ${e.at}, then the file changed${because()}` });
      }
      if (e.rubricHash !== it.rubricHashes[pass]) {
        blocks.push({ ...at, reason: 'rubric-changed', message: `reviewed ${e.at} against an older version of the ${pass} checklist` });
      }
      if (selfReviewAfterCutoff(e, cfg)) {
        blocks.push({ ...at, reason: 'self-review', message: `sealed by the builder on ${e.at}; from ${cfg.independentFrom} only an independent review counts` });
      }
      const expired = expiryReason(e, pass, cfg, { today, reviewBy: it.reviewBy });
      if (expired) (expiredSoft && soft() ? warnings : blocks).push({ ...at, reason: 'expired', message: `${expired}; due for a fresh review` });
      if (e.verdict === 'findings') {
        // Findings never block by default: they are flagged at every save until the file is fixed and re-reviewed.
        (blocksOnFindings(pass, cfg) ? blocks : warnings).push({ ...at, reason: 'findings', findings: e.findings, message: `open finding${e.findings.length === 1 ? '' : 's'} from the ${e.at} review: ${e.findings.join(' | ')}` });
      }
    }
  }
  return { blocks, warnings, counts };
}
