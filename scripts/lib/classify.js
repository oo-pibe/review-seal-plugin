const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];

// How much of `a` survives in `b`, 0..1. Pairs a rewritten line with the line it replaced.
function overlap(a, b) {
  const bw = new Set(words(b));
  const aw = words(a);
  if (!aw.length) return 0;
  return aw.filter((w) => bw.has(w)).length / aw.length;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

const ABBREVIATIONS = new Set(['st', 'mr', 'mrs', 'ms', 'dr', 'no', 'vs', 'jr', 'sr']);

// Split a line into [start, end) sentence spans. A [.!?] (plus closing quotes or brackets) ends a
// sentence only before whitespace or the end of the line, and not after an abbreviation or initials.
function sentenceSpans(line) {
  const spans = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (!'.!?'.includes(line[i])) continue;
    let end = i + 1;
    while (end < line.length && '"\')]\u201d\u2019'.includes(line[end])) end++;
    if (end < line.length && !/\s/.test(line[end])) continue;
    if (line[i] === '.') {
      const token = (line.slice(Math.max(0, i - 32), i).match(/[\p{L}\p{N}.]*$/u) || [''])[0];
      if (/^(?:\p{L}\.)*\p{L}$/u.test(token) || ABBREVIATIONS.has(token.toLowerCase())) continue;
    }
    spans.push([start, end]);
    start = end;
    i = end - 1;
  }
  if (start < line.length) spans.push([start, line.length]);
  return spans;
}

const sentencesOf = (line) => sentenceSpans(line).map(([a, b]) => norm(line.slice(a, b)));

// The normalised sentence around each match of `re` in `line`.
function sentencesWithMatches(re, line) {
  const spans = sentenceSpans(line);
  const out = [];
  for (const m of line.matchAll(re)) {
    const span = spans.find(([a, b]) => m.index >= a && m.index < b) || [0, line.length];
    out.push(norm(line.slice(span[0], span[1])));
  }
  return out;
}

const count = (re, s) => (s.match(re) || []).length;

// A markdown paragraph is one long line, so appending a clause makes git report the whole
// paragraph as added. Testing the raw added line would flag every edit to a paragraph that
// already made a claim. So each pattern's matches in an added line are counted against the
// line it replaced: a change is substantive only when some pattern matches more often than before.
export function classifyChange(diffText, rule) {
  const text = String(diffText);
  if (/^(Binary files .* differ|GIT binary patch)$/m.test(text)) return { substantive: true, why: 'binary change' };

  // Only lines inside a hunk are content; file headers (---/+++) after each "diff --git" are skipped.
  const body = [];
  let inHunk = false;
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git ')) inHunk = false;
    else if (l.startsWith('@@')) inHunk = true;
    else if (inHunk && /^[+-]/.test(l)) body.push(l);
  }
  if (!body.length) return { substantive: false, why: 'no text changes' };

  if (body.some((l) => l[0] === '+' && l.length > 20000)) return { substantive: true, why: 'very long line' };

  const sources = rule.patterns || [];
  if (!sources.length) return { substantive: true, why: 'changes the text' };
  const patterns = sources.map((s) => new RegExp(s, 'gi'));

  const added = body.filter((l) => l[0] === '+').map((l) => l.slice(1));
  const removed = body.filter((l) => l[0] === '-').map((l) => l.slice(1));
  const touched = Math.max(added.length, removed.length);
  const n = (k) => `${k} line${k === 1 ? '' : 's'}`;
  if (touched >= rule.lines) return { substantive: true, why: `touches ${n(touched)}` };

  for (const line of added) {
    if (!patterns.some((re) => count(re, line))) continue;
    let best = null;
    let score = 0;
    for (const r of removed) {
      const s = overlap(line, r);
      if (s > score) { score = s; best = r; }
    }
    const paired = score >= 0.5 ? best : null;
    const old = new Set(paired === null ? [] : sentencesOf(paired));
    const grew = patterns.some((re) => count(re, line) > (paired === null ? 0 : count(re, paired)));
    // An edited claim keeps the match count but changes the sentence around it.
    const edited = patterns.some((re) => sentencesWithMatches(re, line).some((sen) => !old.has(sen)));
    if (grew || edited) {
      return { substantive: true, why: 'adds a line matching a claim pattern', sample: line.trim().slice(0, 80) };
    }
  }
  return { substantive: false, why: `small edit (${n(touched)}) with no new claim` };
}
