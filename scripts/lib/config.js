import { readFileSync, existsSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, sep, isAbsolute } from 'node:path';
import { matchAny } from './glob.js';

export const CONFIG_PATH = '.seal/config.json';

export const DEFAULTS = {
  substantive: { lines: 8, patterns: [] },
  independentFrom: null,
  ledger: '.seal/ledger.json',
  autoReview: 'stop', // "stop": review when Claude finishes a turn; "commit": also at pre-commit; "off"
  maxFilesPerRun: 5,
  blockOnFindings: false,
  model: 'sonnet',
  timeoutSeconds: 600,
};

// kind says what sort of problem it is without repeating repository text: 'json', 'unknown-key' (with nearKey,
// a valid key the unknown one is close to, when there is one), 'rubric', or undefined for anything else.
export class ConfigError extends Error {
  constructor(message, { kind, nearKey } = {}) {
    super(message);
    this.kind = kind;
    this.nearKey = nearKey;
  }
}

// Control characters (and bidi controls) in a path could drive a terminal or a CI log wherever it is printed.
const CONTROL = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/;
const safeRelative = (x) => typeof x === 'string' && x.trim() !== '' && !CONTROL.test(x) && !isAbsolute(x) && !/^[A-Za-z]:/.test(x) && !x.split(/[\\/]/).includes('..');
const realDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const inside = (root, x) => (resolve(root, x) + sep).startsWith(resolve(root) + sep) && resolve(root, x) !== resolve(root);

// The absolute path of rel under root, refusing any path that goes through a symlink (or otherwise resolves
// outside root). The checks above are about how a path is written; this one is about where it leads, so a
// symlink committed into a repository cannot make review-seal read or write outside it.
export function assertInsideReal(root, rel, attempt = 0) {
  const refuse = () => new ConfigError(`${rel} goes through a symlink; review-seal refuses to follow it`);
  if (!safeRelative(rel) || !inside(root, rel)) throw new ConfigError(`${rel} must stay inside the repo`);
  const realRoot = realpathSync(root);
  let cur = resolve(root);
  let last = realRoot;
  for (const part of rel.split(/[\\/]/).filter((x) => x && x !== '.')) {
    cur = join(cur, part);
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) break; // the rest does not exist yet
    if (st.isSymbolicLink()) throw refuse();
    last = cur;
  }
  let r;
  try { r = realpathSync(last); } catch (e) {
    // Renamed or removed between the lstat and here (a drain claiming the inbox, an atomic ledger save):
    // walk again, so a concurrent rename is not an error.
    if (e.code !== 'ENOENT' || attempt >= 5) throw e;
    return assertInsideReal(root, rel, attempt + 1);
  }
  if (r !== realRoot && !r.startsWith(realRoot + sep)) throw refuse();
  return join(root, rel);
}

// The reviewer is always read-only. A pass may add live-source lookups, nothing else.
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];

// The keys a config may use. Anything else is most likely a typo ("maxAgedays") that would otherwise be ignored.
const TOP_KEYS = ['passes', ...Object.keys(DEFAULTS)];
const PASS_KEYS = ['rubric', 'files', 'maxAgeDays', 'tools', 'fetchDomains', 'blockOnFindings'];
const SUBSTANTIVE_KEYS = Object.keys(DEFAULTS.substantive);

// Edit distance between two strings (case-insensitive): insertions, deletions and substitutions.
function distance(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function unknownKeys(obj, valid, where, misplaced = () => null) {
  for (const k of Object.keys(obj)) {
    if (valid.includes(k)) continue;
    const m = misplaced(k);
    if (m) throw new ConfigError(m, { kind: 'unknown-key', nearKey: k });
    const [best] = valid.map((v) => [v, distance(k, v)]).sort((x, y) => x[1] - y[1]);
    const near = best && best[1] <= Math.max(2, Math.floor(k.length / 3)) ? best[0] : undefined;
    const hint = near ? `did you mean "${near}"?` : `valid keys: ${valid.join(', ')}`;
    throw new ConfigError(`${where(JSON.stringify(k))}; ${hint}`, { kind: 'unknown-key', nearKey: near });
  }
}

const hostRule = (d) => typeof d === 'string' && d.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(d);

export function parseConfig(raw) {
  let c;
  try { c = JSON.parse(raw); } catch (e) { throw new ConfigError(`${CONFIG_PATH} is not valid JSON: ${e.message}`, { kind: 'json' }); }
  if (!c || typeof c !== 'object' || !c.passes || typeof c.passes !== 'object' || Array.isArray(c.passes) || !Object.keys(c.passes).length) {
    throw new ConfigError(`${CONFIG_PATH} needs a "passes" object with at least one pass`);
  }
  unknownKeys(c, TOP_KEYS, (k) => `unknown key ${k} in ${CONFIG_PATH}`, (k) => (PASS_KEYS.includes(k) ? `${JSON.stringify(k)} belongs inside a pass, in "passes"` : null));
  for (const [name, p] of Object.entries(c.passes)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new ConfigError(`pass name "${name}" must be lowercase letters, digits and dashes`);
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new ConfigError(`pass "${name}" needs a "rubric" path`, { kind: 'rubric' });
    unknownKeys(p, PASS_KEYS, (k) => `pass "${name}": unknown key ${k}`, (k) => (TOP_KEYS.includes(k) ? `pass "${name}": ${JSON.stringify(k)} is a top-level setting; move it out of the pass` : null));
    if (typeof p.rubric !== 'string' || !p.rubric) throw new ConfigError(`pass "${name}" needs a "rubric" path`, { kind: 'rubric' });
    if (!safeRelative(p.rubric)) throw new ConfigError(`pass "${name}": "rubric" must be a non-empty relative path inside the repo`, { kind: 'rubric' });
    if (!Array.isArray(p.files) || !p.files.length || !p.files.every((f) => typeof f === 'string' && f.trim() !== '')) {
      throw new ConfigError(`pass "${name}" needs a non-empty "files" list of globs`);
    }
    if (p.maxAgeDays !== undefined && p.maxAgeDays !== null && !(Number.isInteger(p.maxAgeDays) && p.maxAgeDays > 0)) {
      throw new ConfigError(`pass "${name}": "maxAgeDays" must be a positive whole number or null`);
    }
    if (p.tools !== undefined && (!Array.isArray(p.tools) || !p.tools.every((t) => WEB_TOOLS.includes(t)) || new Set(p.tools).size !== p.tools.length)) {
      throw new ConfigError(`pass "${name}": "tools" may list only WebSearch and WebFetch, each at most once`);
    }
    // WebFetch is allowed only for listed hosts (Claude Code rules "WebFetch(domain:x)"), so a reviewer that
    // read something sensitive cannot send it to an arbitrary URL. Exact hosts only: a wildcard could reach names anyone can register.
    const fetches = Array.isArray(p.tools) && p.tools.includes('WebFetch');
    if (Array.isArray(p.fetchDomains) && p.fetchDomains.some((d) => typeof d === 'string' && d.includes('*'))) {
      throw new ConfigError(`pass "${name}": fetchDomains lists exact hostnames; wildcards are not allowed`);
    }
    if (p.fetchDomains !== undefined && (!Array.isArray(p.fetchDomains) || !p.fetchDomains.every(hostRule))) {
      throw new ConfigError(`pass "${name}": "fetchDomains" must be a list of exact host names such as "www.example.com"`);
    }
    if (fetches && !(p.fetchDomains || []).length) throw new ConfigError(`pass "${name}": WebFetch needs "fetchDomains", the hosts the reviewer may fetch from`);
    if (!fetches && (p.fetchDomains || []).length) throw new ConfigError(`pass "${name}": "fetchDomains" needs WebFetch in "tools"`);
    // A pass's own blockOnFindings overrides the top-level one for that pass.
    if (p.blockOnFindings !== undefined && typeof p.blockOnFindings !== 'boolean') throw new ConfigError(`pass "${name}": "blockOnFindings" must be true or false`);
    p.maxAgeDays ??= null;
    p.tools ??= [];
    p.fetchDomains ??= [];
  }
  if ('substantive' in c && (!c.substantive || typeof c.substantive !== 'object' || Array.isArray(c.substantive))) throw new ConfigError('"substantive" must be an object');
  if (c.substantive) unknownKeys(c.substantive, SUBSTANTIVE_KEYS, (k) => `"substantive": unknown key ${k}`);
  const cfg = { ...DEFAULTS, ...c, substantive: { ...DEFAULTS.substantive, ...(c.substantive || {}) } };
  if (!safeRelative(cfg.ledger) || /[\\/]$/.test(cfg.ledger)) throw new ConfigError('"ledger" must be a non-empty relative path inside the repo');
  if (!Number.isInteger(cfg.maxFilesPerRun) || cfg.maxFilesPerRun < 1) throw new ConfigError('"maxFilesPerRun" must be a whole number of 1 or more');
  if (typeof cfg.timeoutSeconds !== 'number' || !(cfg.timeoutSeconds >= 1) || cfg.timeoutSeconds > 1800) throw new ConfigError('"timeoutSeconds" must be a number between 1 and 1800');
  if (typeof cfg.blockOnFindings !== 'boolean') throw new ConfigError('"blockOnFindings" must be true or false');
  if (typeof cfg.model !== 'string' || !/^[A-Za-z0-9._:@\/\[\]-]+$/.test(cfg.model) || cfg.model.startsWith('-')) throw new ConfigError('"model" must be a plain model name such as "sonnet"');
  if (!cfg.substantive || typeof cfg.substantive !== 'object' || Array.isArray(cfg.substantive)) throw new ConfigError('"substantive" must be an object');
  if (!Number.isInteger(cfg.substantive.lines) || cfg.substantive.lines < 0) throw new ConfigError('"substantive.lines" must be a whole number of 0 or more');
  if (!Array.isArray(cfg.substantive.patterns) || !cfg.substantive.patterns.every((x) => typeof x === 'string')) throw new ConfigError('"substantive.patterns" must be a list of strings');
  if (!['stop', 'commit', 'off'].includes(cfg.autoReview)) throw new ConfigError('"autoReview" must be "stop", "commit" or "off"');
  if (cfg.independentFrom !== null && !realDate(String(cfg.independentFrom))) {
    throw new ConfigError('"independentFrom" must be a YYYY-MM-DD date or null');
  }
  for (const s of cfg.substantive.patterns) {
    let re;
    try { re = new RegExp(s, 'i'); } catch (e) { throw new ConfigError(`bad substantive pattern ${JSON.stringify(s)}: ${e.message}`); }
    if (re.test('')) throw new ConfigError(`pattern ${JSON.stringify(s)} matches empty text`);
  }
  return cfg;
}

export function loadConfig(root) {
  const p = join(root, CONFIG_PATH);
  if (!lstatSync(p, { throwIfNoEntry: false })) return null;
  assertInsideReal(root, CONFIG_PATH);
  return checkPaths(root, parseConfig(readFileSync(p, 'utf8')));
}

// The config as it will be committed: read from the git index (readIndex returns a path's staged text, or null),
// and from the working tree only when the index has no config yet. Checklists in the index count as present.
export function loadStagedConfig(root, readIndex) {
  const raw = readIndex(CONFIG_PATH);
  if (raw === null) return loadConfig(root);
  return checkPaths(root, parseConfig(raw), (p) => readIndex(p) !== null);
}

function checkPaths(root, cfg, inIndex = () => false) {
  if (!inside(root, cfg.ledger)) throw new ConfigError('"ledger" must stay inside the repo');
  assertInsideReal(root, cfg.ledger);
  for (const [name, pass] of Object.entries(cfg.passes)) {
    if (!inside(root, pass.rubric)) throw new ConfigError(`pass "${name}": rubric ${pass.rubric} must stay inside the repo`, { kind: 'rubric' });
    if (inIndex(pass.rubric)) continue;
    let rp;
    try { rp = assertInsideReal(root, pass.rubric); } catch (e) {
      if (e instanceof ConfigError) e.kind = 'rubric';
      throw e;
    }
    if (!existsSync(rp)) throw new ConfigError(`pass "${name}": rubric ${pass.rubric} does not exist`, { kind: 'rubric' });
    if (!statSync(rp).isFile()) throw new ConfigError(`pass "${name}": rubric ${pass.rubric} is not a file`, { kind: 'rubric' });
  }
  return cfg;
}

// Mistakes that are allowed but almost certainly unintended, as plain sentences.
const PLACEHOLDER_HOST = /(^|\.)example\.(com|org|net)$/i;
export function configWarnings(cfg) {
  const out = [];
  for (const [name, p] of Object.entries(cfg.passes)) {
    const bad = (p.fetchDomains || []).filter((d) => PLACEHOLDER_HOST.test(d));
    if (bad.length) out.push(`pass ${name}: fetchDomains lists placeholder host${bad.length === 1 ? '' : 's'} (${bad.join(', ')}); put the sites the reviewer should check against there`);
  }
  return out;
}

export function passesFor(file, cfg) {
  return Object.entries(cfg.passes).filter(([, p]) => matchAny(file, p.files)).map(([name]) => name);
}
