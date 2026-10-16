import { validateEntry } from './ledger.js';
import { sanitizeText } from './text.js';

// The body of the scheduled re-review pull request: every review the scheduled branch renews against the base
// (so findings from earlier runs stay visible when a later run edits the body), then the latest run's log.
// Everything is shown inside fences, as text: a finding cannot ping anyone or add links.
const MAX = 60000;
const SUMMARY_MAX = 30000;

const fenceFor = (text) => '~'.repeat(Math.max(3, Math.max(0, ...(text.match(/~+/g) || []).map((r) => r.length)) + 1));
const fenced = (text) => {
  const f = fenceFor(text);
  return `${f}\n${text}${text.endsWith('\n') || !text ? '' : '\n'}${f}\n`;
};
const parse = (t) => {
  try {
    const o = JSON.parse(t);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
};

export function renewedEntries(baseText, newText) {
  const base = parse(baseText);
  const next = parse(newText);
  const out = [];
  for (const file of Object.keys(next).sort()) {
    const passes = next[file];
    if (!passes || typeof passes !== 'object') continue;
    for (const pass of Object.keys(passes).sort()) {
      const e = passes[pass];
      if (!e || typeof e !== 'object' || validateEntry(file, pass, e).length) continue;
      if (base[file]?.[pass]?.token === e.token) continue;
      out.push({ file, pass, verdict: e.verdict, at: e.at, findings: Array.isArray(e.findings) ? e.findings : [] });
    }
  }
  return out;
}

// Each finding and each log line is capped, so no one line (and no fence, which must be longer than any run of
// tildes inside it) can take the body over GitHub's limit.
const LINE_MAX = 1000;
const capLine = (s) => (s.length > LINE_MAX ? s.slice(0, LINE_MAX - 1) + '…' : s);

export function dueBody({ baseLedger = '', newLedger = '', log = '' }) {
  const renewed = renewedEntries(baseLedger, newLedger);
  let summary = renewed.map((r) => [
    capLine(`${sanitizeText(r.file)} [${sanitizeText(r.pass)}] ${sanitizeText(r.verdict)} (reviewed ${sanitizeText(r.at)})`),
    ...r.findings.map((f) => `    ${capLine(sanitizeText(f))}`),
  ].join('\n')).join('\n');
  const summaryCut = summary.length > SUMMARY_MAX;
  if (summaryCut) summary = summary.slice(0, summary.lastIndexOf('\n', SUMMARY_MAX) + 1 || SUMMARY_MAX);
  const intro = 'Scheduled re-review of files that were stale or past their shelf life.\n\n';
  const renewedPart = renewed.length
    ? `Reviews this pull request renews (${renewed.length}):\n\n${fenced(summary)}${summaryCut ? '\nlist truncated; see the ledger diff\n' : ''}\n`
    : '';
  const logHead = 'Log of the latest run:\n\n';
  const logCut = '\nlog truncated; see the workflow run\n';
  // Each line of the log is shown as text, never as terminal control sequences.
  let text = String(log).split(/\r?\n/).map((l) => capLine(sanitizeText(l))).join('\n');
  // What is left for the log, less its fences (counted at their length before cutting, which can only shrink them).
  const fence = fenceFor(text).length;
  const room = MAX - intro.length - renewedPart.length - logHead.length - logCut.length - 2 * (fence + 1) - 1;
  const cut = text.length > room;
  if (cut) text = text.slice(0, Math.max(0, room));
  return `${intro}${renewedPart}${logHead}${fenced(text)}${cut ? logCut : ''}`;
}
