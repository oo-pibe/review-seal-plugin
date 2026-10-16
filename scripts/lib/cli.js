import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, chmodSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute, basename, dirname, delimiter, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from './hash.js';
import { loadConfig, loadStagedConfig, parseConfig, passesFor, assertInsideReal, configWarnings, ConfigError, CONFIG_PATH } from './config.js';
import { matchAny } from './glob.js';
import { loadLedger, parseLedger, serializeLedger, saveLedger, makeEntry, validateEntry, LedgerError } from './ledger.js';
import { classifyChange } from './classify.js';
import { evaluate, needsReview, expiryReason } from './evaluate.js';
import { repoRoot, stagedFiles, stagedBytes, changedSince, gitPath, gitCommonDir, stagedFileOrNull, stagedBytesOrNull, stageBlob, indexPath, objectIdOrNull, blobExists, blobBytes, diffBlobs, stagedPathsAll, changedSinceAll, mergeBase, commitOrNull, fileAtOrNull, gitConfig, mergeHeads, octopusBase, changedBetween, commitsBetween, stagedChangesAgainst, gitConfigGet } from './git.js';
import { coveredFiles, rubricHashes, reviewByOf } from './files.js';
import { reviewFiles, pendingJobs, today, ensureStateDir, statePath, storeReviewed, appendLog, readFailures, backedOff, reviewRunning } from './review.js';
import { readVerdict, extractVerdict } from './reviewer.js';
import { runHook } from './hook.js';
import { sanitizeText, ciSafe, ghData, ghProp } from './text.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const BIN_PATH = fileURLToPath(new URL('../bin/review-seal.js', import.meta.url));
const HOOK_MARKER = '# review-seal pre-commit hook';

class UsageError extends Error {}
class RefusedError extends Error {}

// Everything the CLI prints goes through ciSafe line by line, so no file name, finding or reviewer error can
// become a workflow command on GitHub Actions. The one deliberate command, the findings annotation, is written
// with annotate().
const safe = (s) => String(s).split('\n').map((l) => ciSafe(l)).join('\n');
const out = (s) => process.stdout.write(safe(s));
const err = (s) => process.stderr.write(safe(s));
const annotate = (s) => process.stdout.write(s);

const USAGE = `review-seal ${VERSION}: prove each version of a file got an independent review

  review-seal init                        set up .seal/ in this repo
  review-seal review <files…> | --changed-since <ref>
                                          run the independent reviewer on those files if they need it
                                          (never reviewed, changed since, or past their shelf life)
  review-seal review --all                every covered file that changed or was never reviewed; ignores shelf life
  review-seal review --due                like --all, and also renews reviews past their shelf life
  review-seal review … --json <file>      also write what the run did (verdicts, failures) as JSON
  review-seal review … --dry-run          list what would be reviewed, and review nothing
  review-seal check [--staged | --changed-since <ref> | <files…>]
                                          exit 1 if a covered file lacks a fresh review
  review-seal list                        every covered file and its review status
  review-seal prune                       remove ledger entries for files that are gone or no longer covered
  review-seal seal <file> --pass <p> --reviewer builder --verdict clean|findings [--finding "…"]
  review-seal seal <file> --pass <p> --reviewer independent --evidence <verdict.json>
                                          record a review by hand
  review-seal install-hook [--force]      add the git pre-commit and pre-merge-commit hooks
  review-seal hash <file>                 print a file's content hash
  review-seal ledger-path                 print the ledger's path from the config
`;

const BOOL = new Set(['staged', 'all', 'due', 'auto', 'force', 'dry-run']);
const FLAGS = {
  init: [], hash: [], list: [], prune: [], 'ledger-path': [], 'merge-ledger': [], 'merge-driver': [],
  check: ['staged', 'changed-since'],
  review: ['all', 'due', 'changed-since', 'auto', 'session', 'json', 'dry-run'],
  seal: ['pass', 'reviewer', 'verdict', 'finding', 'evidence'],
  'install-hook': ['force'],
};
function parseArgs(argv, allowed) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (/^-[^-]/.test(a)) throw new UsageError(`unknown flag ${a} (try --help)`);
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const k = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!allowed.includes(k)) throw new UsageError(`unknown flag --${k} (try --help)`);
    if (BOOL.has(k)) {
      if (eq !== -1) throw new UsageError(`--${k} does not take a value`);
      flags[k] = [true];
      continue;
    }
    let v;
    if (eq !== -1) v = a.slice(eq + 1);
    else {
      v = argv[i + 1];
      if (v !== undefined && v.startsWith('--')) v = undefined;
      else i++;
    }
    if (v === undefined || v === '') throw new UsageError(`--${k} needs a value`);
    (flags[k] ??= []).push(v);
  }
  return { pos, has: (k) => k in flags, one: (k) => flags[k]?.at(-1), all: (k) => flags[k] || [] };
}

function rootOrDie() {
  const r = repoRoot(process.cwd());
  if (!r) throw new UsageError('not inside a git repository');
  return r;
}
// warn: false for plumbing commands (ledger-path, prune, merge-ledger), whose output scripts read.
function configOrDie(root, { warn = true } = {}) {
  const c = loadConfig(root);
  if (!c) throw new UsageError(`no ${CONFIG_PATH} here; run "review-seal init" first`);
  return warn ? warnConfig(c) : c;
}
// Config warnings go to stderr once per run.
let configWarned = false;
function warnConfig(c) {
  if (c && !configWarned) {
    configWarned = true;
    for (const w of configWarnings(c)) err(`review-seal: ${sanitizeText(w)}\n`);
  }
  return c;
}
// git.js refuses refs that look like options, and git fails on unknown refs; both are bad usage.
function changedSinceOrDie(root, ref) {
  try { return changedSince(root, ref); } catch (e) {
    if (e.message === 'invalid ref' || e.status === 128) throw new UsageError(`"${ref}" is not a valid git ref`);
    throw e;
  }
}
function readUserFile(p, encoding = 'utf8') {
  try { return readFileSync(resolve(process.cwd(), p), encoding); } catch (e) { throw new UsageError(`cannot read ${p}: ${e.code || e.message}`); }
}
const toRepoPath = (root, p) => relative(root, resolve(process.cwd(), p)).split(sep).join('/');
function repoPathOrDie(root, p) {
  const f = toRepoPath(root, p);
  if (!f || isAbsolute(f) || f === '..' || f.startsWith('../')) throw new UsageError(`${p} is outside the repository`);
  return f;
}
// Globs are matched against repository paths, so a glob written from a subdirectory (a package in a monorepo)
// matches nothing. These say so instead of passing silently.
const notCovered = (p, root) => `${p} is not covered by any pass (globs are relative to the repository root, ${root})`;
function warnEmptyPasses(cfg, files) {
  for (const [name, p] of Object.entries(cfg.passes)) {
    if (!files.some((f) => passesFor(f, cfg).includes(name))) {
      err(`review-seal: pass ${name}: its globs match no files (globs are relative to the repository root)\n`);
      continue;
    }
    for (const g of p.files) {
      if (!files.some((f) => matchAny(f, [g]))) err(`review-seal: pass ${name}: glob ${JSON.stringify(sanitizeText(g))} matches no files (globs are relative to the repository root)\n`);
    }
  }
}
// A checklist under .seal/rubrics that no pass names is most likely a pass that lost its config entry.
function warnUnusedRubrics(root, cfg) {
  const norm = (p) => posix.normalize(p.replace(/\\/g, '/'));
  const used = new Set(Object.values(cfg.passes).map((p) => norm(p.rubric)));
  const walk = (dir) => {
    let names = [];
    try { names = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const d of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (d.name.startsWith('.')) continue;
      const rel = `${dir}/${d.name}`;
      if (d.isDirectory()) walk(rel);
      else if (d.isFile() && /\.md$/i.test(d.name) && !used.has(norm(rel))) err(`review-seal: ${sanitizeText(rel)} is not used by any pass\n`);
    }
  };
  try { assertInsideReal(root, '.seal/rubrics'); } catch { return; }
  walk('.seal/rubrics');
}
// Hints are for the person at the prompt: paths from their current directory, and the command as they can
// run it there (npx when review-seal is only in node_modules/.bin).
const fromCwd = (root, f) => relative(real(process.cwd()), join(root, f)).split(sep).join('/') || '.';
function cliName(root) {
  const exe = process.platform === 'win32' ? ['review-seal.cmd', 'review-seal.exe', 'review-seal'] : ['review-seal'];
  // Hook managers (husky, lefthook) and npm scripts put node_modules/.bin on PATH, where a person's shell has none.
  const onPath = (process.env.PATH || '').split(delimiter).filter((d) => d && !/[\\/]node_modules[\\/]\.bin[\\/]*$/.test(d));
  if (onPath.some((d) => exe.some((x) => existsSync(join(d, x))))) return 'review-seal';
  for (let d = real(process.cwd()); ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', '.bin', 'review-seal'))) return 'npx review-seal';
    if (d === root || dirname(d) === d) return 'review-seal';
  }
}
const isSymlink = (root, f) => Boolean(lstatSync(join(root, f), { throwIfNoEntry: false })?.isSymbolicLink());
// A repo file's bytes (a Buffer): contents are hashed as bytes; decode for anything that reads them as text.
const readRepo = (root, f) => readFileSync(join(root, f));

export async function main(argv) {
  const [cmd, ...rest] = argv;
  // review and check can run reviewers; reviewer.js kills them from an 'exit' handler,
  // which only runs if a signal ends the process through process.exit.
  if (cmd === 'review' || cmd === 'check') {
    process.once('SIGINT', () => process.exit(130));
    process.once('SIGTERM', () => process.exit(143));
  }
  try {
    const opts = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
    if (cmd in FLAGS && (opts.includes('--help') || opts.includes('-h'))) { out(USAGE); return 0; }
    const args = () => parseArgs(rest, FLAGS[cmd]);
    switch (cmd) {
      case 'init': args(); return cmdInit();
      case 'hash': return cmdHash(args());
      case 'check': return await cmdCheck(args());
      case 'list': args(); return cmdList();
      case 'prune': args(); return cmdPrune();
      case 'ledger-path': args(); out(sanitizeText(configOrDie(rootOrDie(), { warn: false }).ledger) + '\n'); return 0;
      case 'merge-ledger': return cmdMergeLedger(args());
      case 'merge-driver': return cmdMergeDriver(args());
      case 'seal': return cmdSeal(args());
      case 'review': return await cmdReview(args());
      case 'install-hook': return cmdInstallHook(args());
      case 'hook': return await cmdHook(rest[0]);
      case '--version': case '-v': out(VERSION + '\n'); return 0;
      case 'help': case '--help': case '-h': out(USAGE); return 0;
      case undefined: err(USAGE); return 2;
      default: throw new UsageError(`unknown command "${cmd}" (try --help)`);
    }
  } catch (e) {
    if (e instanceof RefusedError) { err(`review-seal: refused: ${sanitizeText(e.message)}\n`); return 3; }
    if (e instanceof UsageError || e instanceof ConfigError || e instanceof LedgerError) { err(`review-seal: ${sanitizeText(e.message)}\n`); return 2; }
    throw e;
  }
}

const STARTER_CONFIG = { passes: { review: { rubric: '.seal/rubrics/review.md', files: ['docs/**/*.md'] } }, autoReview: 'stop' };
const STARTER_RUBRIC = `# Review checklist

You are reading this file cold. Report a finding for each of these:

- A sentence that contradicts another sentence in the same file.
- A claim that contradicts another file in this repository.
- A step a newcomer could not follow as written.

Do not report style preferences.
`;

function cmdInit() {
  const root = rootOrDie();
  const cfgPath = assertInsideReal(root, CONFIG_PATH);
  if (lstatSync(cfgPath, { throwIfNoEntry: false })) throw new UsageError(`${CONFIG_PATH} already exists; not overwriting`);
  for (const p of ['.seal/rubrics/review.md', '.seal/ledger.json', '.gitignore']) assertInsideReal(root, p);
  mkdirSync(join(root, '.seal/rubrics'), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(STARTER_CONFIG, null, 2) + '\n');
  const rubric = join(root, '.seal/rubrics/review.md');
  if (!existsSync(rubric)) writeFileSync(rubric, STARTER_RUBRIC);
  const ledger = join(root, '.seal/ledger.json');
  if (!existsSync(ledger)) writeFileSync(ledger, '{}\n');
  const gi = join(root, '.gitignore');
  const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  // Appended in the file's own line ending, so a CRLF .gitignore stays CRLF.
  const eol = cur.includes('\r\n') ? '\r\n' : '\n';
  if (!cur.split(/\r?\n/).includes('.seal/.state/')) appendFileSync(gi, (cur && !cur.endsWith('\n') ? eol : '') + '.seal/.state/' + eol);
  out(`Created ${CONFIG_PATH}, .seal/rubrics/review.md and .seal/ledger.json in ${sanitizeText(root)}.\n`
    + 'Point "files" at what needs review (globs are relative to the repository root), then run: review-seal install-hook\n'
    + 'Commit .seal/ (the ledger is your review history).\n');
  return 0;
}

function cmdHash(a) {
  const [p] = a.pos;
  if (!p) throw new UsageError('usage: review-seal hash <file>');
  out(contentHash(readUserFile(p, null)) + '\n');
  return 0;
}

// The indexes a staged ledger must be written to. For `git commit <paths>` git runs the hook against a temporary
// next-index-*.lock in the git dir; the repository's own index is then held as index.lock and becomes the index
// after the commit, so it gets the same reviews or the next commit would record them being undone.
// Any other GIT_INDEX_FILE (plain commit, commit -a, a caller's own index) is the only index touched.
function ledgerIndexes(root) {
  const envs = [process.env];
  const cur = process.env.GIT_INDEX_FILE;
  if (!cur) return envs;
  const { GIT_INDEX_FILE, ...base } = process.env;
  const own = real(indexPath(root, base));
  const here = real(resolve(process.cwd(), cur));
  if (!basename(here).startsWith('next-index-') || dirname(here) !== dirname(own)) return envs;
  envs.push({ ...base, GIT_INDEX_FILE: existsSync(own + '.lock') ? own + '.lock' : own });
  return envs;
}

async function cmdCheck(a) {
  const root = rootOrDie();
  const staged = a.has('staged');
  // At commit time the config and checklists are the ones being committed, read from the index, so a change
  // left unstaged in the working tree cannot loosen the check.
  const cfg = staged ? warnConfig(loadStagedConfig(root, (p) => stagedFileOrNull(root, p))) : configOrDie(root);
  const since = a.one('changed-since');
  let files;
  if (staged) files = stagedFiles(root);
  else if (since) files = changedSinceOrDie(root, since);
  else if (a.pos.length) {
    files = a.pos.map((p) => [p, repoPathOrDie(root, p)]).filter(([p, f]) => {
      if (!passesFor(f, cfg).length) { err(`review-seal: ${sanitizeText(notCovered(p, root))}\n`); return false; }
      if (!isSymlink(root, f)) return true;
      err(`review-seal: skipping ${sanitizeText(p)}: review-seal skips symlinks\n`);
      return false;
    }).map(([, f]) => f);
  } else {
    files = coveredFiles(root, cfg);
    warnEmptyPasses(cfg, files);
  }
  if (staged || since) {
    const { edited, content, side, commit } = settingsEditedWithContent(root, since, cfg);
    if (side) {
      if (commit) err(`\n  BLOCK  ${side} (${commit.slice(0, 12)}) edits review settings (${sanitizeText(edited.join(', '))}) together with content; split that commit, settings first and content after, then merge again\n\n`);
      else err(`\n  BLOCK  ${side} edits review settings (${sanitizeText(edited.join(', '))}) together with content; keep the merge to what the branches bring, and commit settings changes on their own\n\n`);
      return 1;
    }
    if (edited.length) {
      err(`\n  BLOCK  this change edits review settings (${sanitizeText(edited.join(', '))}) together with content; commit the settings change on its own\n`);
      if (staged) err(`         split it: git restore --staged ${content.map((f) => shellWord(sanitizeText(fromCwd(root, f)))).join(' ')}, commit .seal/ alone, then commit the rest\n`);
      err('\n');
      return 1;
    }
  }
  // The pre-commit hook may outlive the setup (or run in a clone without it): no config, nothing to check.
  if (!cfg) return 0;
  hookHint(root);
  if (!staged) warnUnusedRubrics(root, cfg);
  files = files.filter((f) => passesFor(f, cfg).length && (staged || existsSync(join(root, f))));
  if (!files.length) return 0;

  const texts = new Map(files.map((f) => [f, staged ? stagedBytes(root, f) : readRepo(root, f)]));
  const hashes = new Map(files.map((f) => [f, contentHash(texts.get(f))]));
  // Reviews run on the working copy, so a file staged only in part cannot be reviewed for this commit.
  const partial = new Set(staged ? files.filter((f) => !existsSync(join(root, f)) || contentHash(readRepo(root, f)) !== hashes.get(f)) : []);

  if (staged && cfg.autoReview === 'commit') {
    const whole = files.filter((f) => !partial.has(f));
    // New reviews land in the working-tree ledger; the staged check below carries them into the commit.
    if (whole.length) await reviewFiles(root, cfg, whole, { log: (m) => err(`review-seal: ${sanitizeText(m)}\n`) });
  }

  const rh = staged ? rubricHashes(root, cfg, (p) => stagedBytesOrNull(root, p) ?? readFileSync(assertInsideReal(root, p))) : rubricHashes(root, cfg);
  const now = today();
  const items = files.map((f) => ({
    file: f,
    rubricHashes: rh,
    contentHash: hashes.get(f),
    reviewBy: reviewByOf(texts.get(f).toString('utf8')),
    change: staged ? changeSinceReview(root, f, cfg) : { substantive: true, why: '' },
  }));
  let r;
  let work = {};
  let judged = {};
  if (staged) {
    // Judge the commit as it will land: the ledger in the index, not the one on disk.
    const indexLedger = (env) => { const t = stagedFileOrNull(root, cfg.ledger, env); return t === null ? {} : parseLedger(t, cfg); };
    work = loadLedger(root, cfg);
    // Reviews move from the working-tree ledger into the index for the files in this commit only, and only
    // where they reviewed exactly the staged version against the staged checklist. That happens before judging
    // and whatever else blocks, so a blocked commit never reports a file as stale that is in fact reviewed.
    const fits = (f, pass, e) => e && !validateEntry(f, pass, e).length && e.contentHash === hashes.get(f) && e.rubricHash === rh[pass];
    const take = [];
    const idx = indexLedger();
    // Where neither the working tree nor the index has a review that fits, the commit being merged, cherry-picked
    // or rebased may have one: a merge driver that kept a same-day review of the older text, say.
    let others = null;
    const elsewhere = (f, pass) => {
      others ??= otherLedgers(root, cfg);
      for (const led of others) if (fits(f, pass, own(led[f], pass))) return led[f][pass];
      return null;
    };
    let fromElsewhere = false;
    for (const f of files) {
      for (const pass of passesFor(f, cfg)) {
        if (fits(f, pass, work[f]?.[pass])) take.push([f, pass, work[f][pass]]);
        else if (!fits(f, pass, idx[f]?.[pass])) {
          const e = elsewhere(f, pass);
          if (e) { take.push([f, pass, e]); fromElsewhere = true; }
        }
      }
    }
    const merged = (led) => {
      const out = { ...led };
      for (const [f, pass, e] of take) out[f] = { ...(out[f] || {}), [pass]: e };
      return out;
    };
    if (take.some(([f, pass, e]) => idx[f]?.[pass]?.token !== e.token)) {
      // The working-tree ledger gets the same reviews when it matched the index, so it does not undo them later.
      const ledgerPath = assertInsideReal(root, cfg.ledger);
      const workText = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : null;
      const sync = fromElsewhere && workText !== null && workText === stagedFileOrNull(root, cfg.ledger);
      try {
        for (const env of ledgerIndexes(root)) stageBlob(root, cfg.ledger, serializeLedger(merged(indexLedger(env))), env);
      } catch {
        err(`review-seal: could not stage ${sanitizeText(cfg.ledger)} into the index; run git add ${sanitizeText(cfg.ledger)} and commit again\n`);
        return 1;
      }
      if (sync) {
        try { saveLedger(root, cfg, merged(work)); work = loadLedger(root, cfg); } catch { /* the index has them; the working tree can catch up */ }
      }
      err(`review-seal: staged ${sanitizeText(cfg.ledger)} so this commit carries its reviews\n`);
      // A clean "git merge" writes its tree before pre-merge-commit runs, so what the hook stages misses this
      // merge commit. Stopping leaves the merge in progress with the reviews staged; "git commit" finishes it.
      if (!existsSync(gitPath(root, 'MERGE_HEAD')) && mergeHeads(root).length) {
        err('review-seal: git merge cannot take the reviews staged during its own hook; run git commit to finish the merge with them\n');
        return 1;
      }
    }
    judged = indexLedger();
    r = evaluate(items, judged, cfg, now, { expiredSoft: true });
  } else {
    judged = loadLedger(root, cfg);
    r = evaluate(items, judged, cfg, now);
  }
  for (const w of r.warnings) {
    err(`  ${w.reason === 'findings' ? 'FLAG' : 'WARN'}   ${sanitizeText(w.file)} [${w.pass}] ${sanitizeText(w.message)}\n`);
    if (w.reason === 'findings') annotateFindings('warning', w);
  }
  // Under blockOnFindings, findings are blocks and show as errors.
  for (const b of r.blocks) if (b.reason === 'findings') annotateFindings('error', b);
  if (r.counts.builder) err(`  Reviews on record: ${r.counts.independent} independent, ${r.counts.builder} by the builder\n`);
  if (!r.blocks.length) return 0;
  const ci = process.env.GITHUB_ACTIONS === 'true';
  const cli = cliName(root);
  const here = (f) => sanitizeText(fromCwd(root, f));
  // A file and pass whose only block is its open findings has a current review: the fix is to change the file,
  // which a review then checks. Findings on a version that also needs a review go with that review.
  const key = (b) => `${b.file}\0${b.pass}`;
  const otherBlocked = new Set(r.blocks.filter((b) => b.reason !== 'findings').map(key));
  const findingsOnly = r.blocks.filter((b) => b.reason === 'findings' && !otherBlocked.has(key(b)));
  const reviewBlocks = r.blocks.filter((b) => !findingsOnly.includes(b));
  const needsReviewNow = (b) => b.reason === 'stale' || b.reason === 'never-reviewed';
  const partialNames = [...new Set(reviewBlocks.filter((b) => partial.has(b.file) && needsReviewNow(b)).map((b) => b.file))];
  const names = [...new Set(reviewBlocks.filter((b) => !partialNames.includes(b.file)).map((b) => b.file))];
  if (reviewBlocks.length) {
    err(`\nreview-seal: these files need a fresh independent review${staged ? ' before this commit' : ''}:\n\n`);
    for (const b of reviewBlocks) {
      // The review on record for another version of the file: on disk, or else in the commit's ledger.
      const e = [work[b.file]?.[b.pass], judged[b.file]?.[b.pass]].find((x) => x && !validateEntry(b.file, b.pass, x).length && x.contentHash !== hashes.get(b.file));
      // A file with a review of another version was reviewed, then changed; "never reviewed" would be wrong.
      const message = staged && b.reason === 'never-reviewed' && e ? `reviewed ${e.at}, then the file changed` : b.message;
      err(`  BLOCK  ${sanitizeText(b.file)} [${b.pass}] ${sanitizeText(message)}\n`);
      // When the staged file differs from the reviewed one only in whitespace, a formatter (lint-staged, a
      // pre-commit hook) most likely rewrote it after the review.
      if (staged && needsReviewNow(b) && !partial.has(b.file) && e && whitespaceOnly(root, e, texts.get(b.file))) {
        err('         reviewed version differs from the staged version only in whitespace (a formatter may have changed it after the review; run your formatter before reviewing, and run review-seal last in your hooks)\n');
      }
    }
    err('\n');
    for (const f of partialNames) {
      err(`  ${here(f)}: the staged version differs from your working copy, and reviews run on the working copy. Stage the whole file (git add ${here(f)}) or stash the rest, then commit again.\n`);
    }
    if (names.length && ci && process.env.REVIEW_SEAL_COMMIT === 'false') {
      err(`${partialNames.length ? '\n' : ''}  Fix: this run's reviews were not kept (commit: false); record them locally with npx review-seal review ${names.map(here).join(' ')} and push the ledger\n`);
    } else if (names.length && ci) {
      err(`${partialNames.length ? '\n' : ''}  Fix: the review step above shows why these weren't reviewed; fix and re-run the job\n`);
    } else if (names.length) {
      // A file whose automatic review failed is held back (review.js), so waiting for Claude would not help.
      const failures = readFailures(root);
      const isPaused = (f) => reviewBlocks.some((b) => b.file === f && backedOff(failures, { file: f, pass: b.pass, contentHash: hashes.get(f) }));
      // The automatic review renews what changed, not what only aged, so an expired review needs a command.
      // Any expired review and nothing changed since (open findings or a newer checklist may block it too).
      const onlyExpired = (f) => {
        const bs = reviewBlocks.filter((b) => b.file === f);
        return bs.some((b) => b.reason === 'expired') && !bs.some(needsReviewNow);
      };
      const paused = names.filter(isPaused);
      const expiredNames = names.filter((f) => !isPaused(f) && onlyExpired(f));
      const rest = names.filter((f) => !isPaused(f) && !onlyExpired(f));
      if (partialNames.length) err('\n');
      if (rest.length && reviewRunning(root)) {
        err(`  Fix: a review is running now; when it finishes, ${staged ? 'commit' : 'check'} again (or run ${cli} review ${rest.map(here).join(' ')})\n`);
      } else if (rest.length) {
        const how = cfg.autoReview === 'off' ? 'Fix: run:' : 'Fix: let Claude finish its turn (reviews run automatically), or run:';
        err(`  ${how}\n       ${cli} review ${rest.map(here).join(' ')}\n`);
      }
      if (paused.length) err(`  Fix: automatic review is paused after a failure; run:\n       ${cli} review ${paused.map(here).join(' ')}\n`);
      if (expiredNames.length) err(`  Fix: past its shelf life; run:\n       ${cli} review ${expiredNames.map(here).join(' ')}\n`);
      if (reviewBlocks.some((b) => b.reason === 'expired')) err(`       (or ${cli} review --due for everything past its shelf life)\n`);
    }
  }
  if (findingsOnly.length) {
    err(`\nreview-seal: open findings block ${staged ? 'this commit' : 'these files'}:\n\n`);
    for (const b of findingsOnly) err(`  BLOCK  ${sanitizeText(b.file)} [${b.pass}] ${sanitizeText(b.message)}\n`);
    const fixed = [...new Set(findingsOnly.map((b) => b.file))].map(here).join(' ');
    err('\n');
    if (ci) err('  Fix: fix the findings and push; the review re-runs\n');
    else if (cfg.autoReview === 'off') err(`  Fix: edit the file to address the findings, then run:\n       ${cli} review ${fixed}\n`);
    else err('  Fix: edit the file to address the findings; it will be re-reviewed automatically\n');
  }
  // pre-commit stashes unstaged changes before hooks run, so a review recorded but not staged is invisible here.
  if (process.env.PRE_COMMIT === '1' && r.blocks.some(needsReviewNow)) {
    err(`\n  Under pre-commit, reviews you have not staged are hidden from this check. If the review already ran,\n  stage ${sanitizeText(cfg.ledger)} with your change (git add ${here(cfg.ledger)}) and commit again.\n`);
  }
  err('\n');
  return 1;
}

// On GitHub Actions, open findings also show as annotations on the pull request (level: warning or error).
function annotateFindings(level, x) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  for (const f of x.findings) {
    // A finding that starts "L12:" points at its line on the pull request.
    const line = String(f).match(/^L(\d+)\b/)?.[1];
    annotate(`::${level} file=${ghProp(ciSafe(sanitizeText(x.file)))}${line ? `,line=${line}` : ''},title=${ghProp(`review-seal ${x.pass}`)}::${ghData(ciSafe(sanitizeText(f)))}\n`);
  }
}

// Ledgers in the commits an operation in progress is bringing in: the merge heads, then CHERRY_PICK_HEAD,
// REBASE_HEAD and ORIG_HEAD. Unreadable or missing ones are skipped. Entries are still checked one by one.
function otherLedgers(root, cfg) {
  const out = [];
  for (const rev of [...mergeHeads(root), 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'ORIG_HEAD']) {
    if (!commitOrNull(root, rev)) continue;
    const t = fileAtOrNull(root, rev, cfg.ledger);
    if (t === null) continue;
    try { out.push(parseLedger(t, cfg)); } catch { /* not a ledger */ }
  }
  return out;
}

// Does the staged text differ from the text entry e reviewed only in whitespace? False when the reviewed bytes
// are not in this repository to compare with.
function whitespaceOnly(root, e, staged) {
  if (!e.reviewedBlob || !blobExists(root, e.reviewedBlob)) return false;
  const squeeze = (b) => b.toString('utf8').replace(/\s+/g, '');
  return squeeze(blobBytes(root, e.reviewedBlob)) === squeeze(staged);
}

// How far the staged version of f has moved from the version a ledger entry reviewed: the entry's reviewedBlob,
// or HEAD's version when it is the reviewed text and the entry has no blob (or the blob was garbage collected).
// Measuring from the review, not from HEAD, stops a run of small commits drifting a file away from what was read.
function changeSinceReview(root, f, cfg) {
  const memo = new Map();
  return (e) => {
    let from = e.reviewedBlob && blobExists(root, e.reviewedBlob) ? e.reviewedBlob : null;
    if (!from) {
      const head = objectIdOrNull(root, `HEAD:${f}`);
      if (head && blobExists(root, head) && contentHash(blobBytes(root, head)) === e.contentHash) from = head;
    }
    if (!from) return { substantive: true, why: 'the reviewed version is not in this repository to compare with' };
    if (!memo.has(from)) {
      const to = objectIdOrNull(root, `:0:${f}`);
      memo.set(from, to ? classifyChange(diffBlobs(root, from, to), cfg.substantive) : { substantive: true, why: 'not in the index' });
    }
    return memo.get(from);
  };
}

// The review settings (the config and the checklists) this change edits, when it also changes content: a change
// is never judged by rules it rewrites, so settings go in on their own, where people can review them as such.
// The base is HEAD for a commit (since is unset) and the merge base for --changed-since. Content is any path
// outside .seal/ that is not a checklist or the ledger. A repository with no config at the base is exempt.
// Returns { edited, content }: both empty unless the change mixes them.
function settingsEditedWithContent(root, since, next) {
  let rev;
  try { rev = since ? mergeBase(root, since) : commitOrNull(root, 'HEAD'); } catch { throw new UsageError(`"${since}" is not a valid git ref`); }
  if (!rev) return NO_MIX;
  // A merge (pre-merge-commit, or a commit that concludes one) is judged per side, as --changed-since judges a
  // branch: each side's own changes since the merge base. Settings that came in alone on one side and content
  // that came in alone on the other do not mix. A side that mixes them across several commits (a settings commit,
  // then a content commit, each let through on its own) is judged commit by commit, as its commits were.
  const heads = since ? [] : mergeHeads(root);
  const mb = heads.length ? octopusBase(root, [rev, ...heads]) : null;
  if (mb) {
    const configAt = (c) => {
      const t = fileAtOrNull(root, c, CONFIG_PATH);
      try { return t === null ? null : parseConfig(t); } catch { return null; }
    };
    for (const [i, side] of [rev, ...heads].entries()) {
      const baseRaw = fileAtOrNull(root, mb, CONFIG_PATH);
      if (baseRaw === null || !settingsMix([baseRaw], configAt(side), changedBetween(root, mb, side)).edited.length) continue;
      for (const c of commitsBetween(root, mb, side)) {
        const parent = commitOrNull(root, `${c}^`);
        const parentRaw = parent && fileAtOrNull(root, parent, CONFIG_PATH);
        if (!parentRaw) continue;
        const r = settingsMix([parentRaw], configAt(c), changedBetween(root, parent, c));
        if (r.edited.length) return { ...r, side: i === 0 ? 'a commit on this branch' : 'a commit being merged', commit: c };
      }
    }
    // What the resolution adds itself: staged paths that differ from HEAD and from every merge head. Exemptions
    // come from the configs the sides already had, so the resolution cannot name a new ledger or checklist either.
    const sides = [rev, ...heads];
    const fromSide = sides.map((c) => new Set(stagedChangesAgainst(root, c)));
    const added = [...fromSide[0]].filter((f) => fromSide.every((set) => set.has(f)));
    const resolved = stagedFileOrNull(root, CONFIG_PATH) === null ? null : next;
    const sideConfigs = sides.map((c) => fileAtOrNull(root, c, CONFIG_PATH));
    if (sideConfigs.every((x) => x === null)) return NO_MIX;
    const r = settingsMix(sideConfigs, resolved, added);
    return r.edited.length ? { ...r, side: 'the merge resolution', commit: null } : NO_MIX;
  }
  const raw = fileAtOrNull(root, rev, CONFIG_PATH);
  if (raw === null) return NO_MIX;
  // A config taken out of the index is removed by this commit, whatever is still in the working tree.
  if (!since && stagedFileOrNull(root, CONFIG_PATH) === null) next = null;
  return settingsMix([raw], next, since ? changedSinceAll(root, since) : stagedPathsAll(root));
}
const NO_MIX = { edited: [], content: [] };

// baseRaws: the config texts at the base (one, or each side of a merge; null where there is none). next: the
// config the change brings (null when it removes it). Which checklists and ledger are exempt from "content" comes
// from the base only: a path that only the new config names (say, a covered page made the ledger or a checklist)
// is both a settings change and content. A config with no base at all is exempt (the caller checks that).
function settingsMix(baseRaws, next, changed) {
  const bases = [];
  for (const raw of baseRaws) {
    if (raw === null) continue;
    try { bases.push(parseConfig(raw)); } catch { /* a broken base config: the config path alone counts as settings */ }
  }
  const rubrics = (c) => (c ? Object.values(c.passes).map((p) => p.rubric) : []);
  const baseRubrics = bases.flatMap(rubrics);
  const exempt = new Set([CONFIG_PATH, ...baseRubrics, ...bases.map((b) => b.ledger)]);
  const newlyNamed = [...rubrics(next), ...(next ? [next.ledger] : [])].filter((p) => !exempt.has(p));
  const settings = new Set([CONFIG_PATH, ...baseRubrics, ...newlyNamed]);
  const edited = [...new Set(changed.filter((f) => settings.has(f)))].sort();
  const content = [...new Set(changed.filter((f) => !f.startsWith('.seal/') && !exempt.has(f)))].sort();
  return edited.length && content.length ? { edited, content } : NO_MIX;
}

function cmdList() {
  const root = rootOrDie();
  const cfg = configOrDie(root);
  const led = loadLedger(root, cfg);
  const rh = rubricHashes(root, cfg);
  const files = coveredFiles(root, cfg);
  warnEmptyPasses(cfg, files);
  warnUnusedRubrics(root, cfg);
  const now = today();
  const counts = { independent: 0, builder: 0 };
  for (const f of files) {
    out(`${sanitizeText(f)}\n`);
    const bytes = readRepo(root, f);
    const ch = contentHash(bytes);
    const opts = { today: now, reviewBy: reviewByOf(bytes.toString('utf8')) };
    for (const pass of passesFor(f, cfg)) {
      const e = (led[f] || {})[pass];
      if (!e) { out(`    ${pass.padEnd(14)} never reviewed\n`); continue; }
      const state = needsReview(f, pass, led, { contentHash: ch, rubricHash: rh[pass] }, cfg) ? 'STALE'
        : expiryReason(e, pass, cfg, opts) ? 'EXPIRED' : 'fresh';
      if (e.reviewer in counts) counts[e.reviewer]++;
      const n = Array.isArray(e.findings) && e.findings.length ? ` (${e.findings.length})` : '';
      out(`    ${pass.padEnd(14)} ${state.padEnd(7)} ${sanitizeText(e.at)}  ${sanitizeText(e.verdict)}${n}  ${sanitizeText(e.reviewer)}\n`);
    }
  }
  for (const f of Object.keys(led).filter((f) => !files.includes(f))) out(`${sanitizeText(f)}\n    orphaned: no longer exists or no longer covered\n`);
  out(`\n${counts.independent} independent, ${counts.builder} builder\n`);
  return 0;
}

function cmdPrune() {
  const root = rootOrDie();
  const cfg = configOrDie(root, { warn: false });
  const led = loadLedger(root, cfg);
  const covered = new Set(coveredFiles(root, cfg));
  const removed = [];
  for (const [file, passes] of Object.entries(led)) {
    const safePath = !isAbsolute(file) && !file.split(/[\\/]/).includes('..');
    const exists = covered.has(file) || (safePath && Boolean(lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile()));
    const keep = exists ? passesFor(file, cfg) : [];
    for (const pass of Object.keys(passes)) {
      if (keep.includes(pass)) continue;
      removed.push(`${file} [${pass}]: ${exists ? 'no longer covered' : 'no longer exists'}`);
      delete passes[pass];
    }
    if (!Object.keys(passes).length) delete led[file];
  }
  if (!removed.length) { out('nothing to prune\n'); return 0; }
  saveLedger(root, cfg, led);
  for (const x of removed) out(`removed ${sanitizeText(x)}\n`);
  return 0;
}

// Hidden, for the Action's scheduled mode: take reviews from another ledger (the scheduled branch's) where they
// still fit this checkout: the file is covered by that pass, the entry is intact, it reviewed the current file
// and checklist, and it is newer than what is here (or what is here no longer fits).
function cmdMergeLedger(a) {
  const root = rootOrDie();
  const cfg = configOrDie(root, { warn: false });
  const [p] = a.pos;
  if (!p || a.pos.length > 1) throw new UsageError('usage: review-seal merge-ledger <ledger.json>');
  const theirs = parseLedger(readUserFile(p), { ...cfg, ledger: p });
  const led = loadLedger(root, cfg);
  const rh = rubricHashes(root, cfg);
  const covered = new Set(coveredFiles(root, cfg));
  let taken = 0;
  for (const [file, passes] of Object.entries(theirs)) {
    if (!covered.has(file)) continue;
    const ch = contentHash(readRepo(root, file));
    const fits = (e, pass) => e && !validateEntry(file, pass, e).length && e.contentHash === ch && e.rubricHash === rh[pass];
    for (const pass of passesFor(file, cfg)) {
      const e = passes[pass];
      if (!fits(e, pass)) continue;
      const cur = (led[file] || {})[pass];
      if (fits(cur, pass) && !(e.at > cur.at)) continue;
      led[file] = { ...(led[file] || {}), [pass]: e };
      taken++;
    }
  }
  if (taken) saveLedger(root, cfg, led);
  out(`merged ${taken} review${taken === 1 ? '' : 's'} from ${sanitizeText(p)}\n`);
  return 0;
}

// Hidden; git calls it as the ledger's merge driver (install-hook sets it up): merge-driver %O %A %B.
// A three-way merge per file and pass: a side whose entry is as it was at the base takes the other side's (a new
// review, or a removal by prune); where both sides changed it, the later review wins and a tie keeps ours.
// Entries that fail validation are dropped. The result is written to %A. A side that is not a ledger exits 1,
// which leaves git's own conflict in place.
function cmdMergeDriver(a) {
  const [o, ours, theirs] = a.pos;
  if (!o || !ours || !theirs || a.pos.length > 3) throw new UsageError('usage: review-seal merge-driver %O %A %B');
  const read = (p, emptyOk) => {
    const t = readUserFile(p);
    if (emptyOk && !t.trim()) return {};
    try { return parseLedger(t, { ledger: p }); } catch { return null; }
  };
  const B = read(o, true) || {};
  const A = read(ours, false);
  const T = read(theirs, false);
  if (!A || !T || !looksLikeLedger(A) || !looksLikeLedger(T)) { err('review-seal: a side of the ledger merge is not a valid ledger; resolve it by hand\n'); return 1; }
  const valid = (file, pass, e) => (e && !validateEntry(file, pass, e).length ? e : null);
  const out = {};
  for (const file of new Set([...Object.keys(A), ...Object.keys(T)])) {
    for (const pass of new Set([...Object.keys(A[file] || {}), ...Object.keys(T[file] || {})])) {
      const ra = own(A[file], pass);
      const rt = own(T[file], pass);
      const rb = own(B[file], pass);
      const x = valid(file, pass, ra);
      const y = valid(file, pass, rt);
      let keep;
      if (sameEntry(ra, rb)) keep = rt === undefined ? null : y || x;
      else if (sameEntry(rt, rb)) keep = ra === undefined ? null : x || y;
      else if (x && y) keep = String(y.at) > String(x.at) ? y : x;
      else keep = x || y;
      if (keep) out[file] = { ...(out[file] || {}), [pass]: keep };
    }
  }
  writeFileSync(resolve(process.cwd(), ours), serializeLedger(out));
  return 0;
}
// Every file maps to passes whose entries carry a review's fields. A JSON file that is something else (git
// pointed the driver at the wrong path) is refused rather than merged into an empty ledger.
function looksLikeLedger(led) {
  const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  return Object.values(led).every((passes) => plain(passes)
    && Object.values(passes).every((e) => plain(e) && 'contentHash' in e && 'verdict' in e && 'token' in e));
}
// A pass's entry in a file's passes, own properties only (a ledger key such as "__proto__" names nothing inherited).
const own = (passes, pass) => (passes && Object.hasOwn(passes, pass) ? passes[pass] : undefined);
// Do two ledger entries hold the same fields and values? Both missing counts as the same.
function sameEntry(a, b) {
  const canon = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? v.map(canon) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))) : v);
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function cmdSeal(a) {
  const root = rootOrDie();
  const cfg = configOrDie(root);
  const [p] = a.pos;
  if (!p) throw new UsageError('usage: review-seal seal <file> --pass <name> --reviewer builder|independent …');
  const file = repoPathOrDie(root, p);
  if (!existsSync(join(root, file))) throw new UsageError(`${file} does not exist`);
  if (isSymlink(root, file)) throw new UsageError(`${p} is a symlink; review-seal skips symlinks`);
  const pass = a.one('pass');
  if (!pass) throw new UsageError('--pass <name> is required');
  const passes = passesFor(file, cfg);
  if (!passes.length) throw new UsageError(notCovered(p, root));
  if (!passes.includes(pass)) throw new UsageError(`${file} has no pass named "${pass}" (its passes: ${passes.join(', ') || 'none'})`);
  const reviewer = a.one('reviewer');
  if (!['builder', 'independent'].includes(reviewer)) throw new UsageError('--reviewer must be "builder" or "independent"');
  const bytes = readRepo(root, file);
  const ch = contentHash(bytes);
  const rh = rubricHashes(root, cfg)[pass];
  let verdict, findings, via;
  if (reviewer === 'independent') {
    const ev = a.one('evidence');
    if (!ev) throw new UsageError('--reviewer independent needs --evidence <file> with the reviewer\'s JSON verdict');
    const text = readUserFile(ev);
    const r = readVerdict(text, { file, pass, contentHash: ch, rubricHash: rh });
    if (r.error === 'mismatch') {
      // Say which field differs, from the last well-formed verdict in the evidence.
      const o = extractVerdict(text);
      if (o && (o.file !== file || o.pass !== pass)) throw new RefusedError(`the evidence is for ${o.file} [${o.pass}], not ${file} [${pass}]`);
      if (o && o.contentHash !== ch) throw new RefusedError(`the evidence was produced for a different version of ${file}`);
      if (o && o.rubricHash !== rh) throw new RefusedError(`the evidence was produced against a different version of the ${pass} checklist`);
      throw new RefusedError(`the evidence does not match ${file} [${pass}] at this version`);
    }
    if (!r.verdict) throw new RefusedError('could not read a verdict from the evidence file');
    ({ verdict, findings } = r.verdict);
    via = 'agent';
  } else {
    verdict = a.one('verdict');
    findings = a.all('finding');
    via = 'manual';
    if (!['clean', 'findings'].includes(verdict)) throw new UsageError('--verdict must be "clean" or "findings"');
    if (verdict === 'findings' && !findings.length) throw new UsageError('--verdict findings needs at least one --finding');
    if (verdict === 'clean' && findings.length) throw new UsageError('--verdict clean takes no --finding; use --verdict findings');
  }
  const led = loadLedger(root, cfg);
  led[file] = { ...(led[file] || {}), [pass]: makeEntry(file, pass, { at: today(), contentHash: ch, rubricHash: rh, verdict, findings, reviewer, via, reviewedBlob: storeReviewed(root, file, bytes) }) };
  saveLedger(root, cfg, led);
  out(`sealed ${sanitizeText(file)} [${pass}] ${verdict}${findings.length ? ` (${findings.length} findings)` : ''} by ${reviewer}\n`);
  return 0;
}

async function cmdReview(a) {
  const root = rootOrDie();
  const cfg = configOrDie(root);
  let files;
  const whole = a.has('due') ? 'due' : a.has('all') ? 'all' : null;
  if (whole && (a.pos.length || a.has('changed-since'))) throw new UsageError(`use --${whole} on its own, or name files`);
  // --due: every covered file; pendingJobs keeps those stale or past their shelf life.
  if (a.has('all') || a.has('due')) files = coveredFiles(root, cfg);
  else if (a.one('changed-since')) files = changedSinceOrDie(root, a.one('changed-since'));
  else if (a.pos.length) {
    files = a.pos.map((p) => {
      let f = repoPathOrDie(root, p);
      // From a subdirectory, a path written from the repository root (as the hints and the ledger show them).
      if (!existsSync(join(root, f)) && !isAbsolute(p)) {
        const alt = toRepoPath(root, join(root, p));
        if (alt && !alt.startsWith('../') && alt !== '..' && existsSync(join(root, alt))) f = alt;
      }
      if (!existsSync(join(root, f))) throw new UsageError(`${p} does not exist`);
      if (isSymlink(root, f)) throw new UsageError(`${p} is a symlink; review-seal skips symlinks`);
      if (!passesFor(f, cfg).length) throw new UsageError(notCovered(p, root));
      return f;
    });
  } else throw new UsageError('name the files to review, or pass --all, --due or --changed-since <ref>');
  files = files.filter((f) => passesFor(f, cfg).length);
  const auto = a.has('auto');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : w.endsWith('s') ? 'es' : 's'}`;
  const size = ({ files: n, passes: m }) => `${plural(n, 'file')} across ${plural(m, 'pass')}`;
  if (a.has('dry-run')) {
    if (auto) throw new UsageError('--dry-run does not go with --auto');
    if (a.has('json')) throw new UsageError('--dry-run does not write --json; drop one of them');
    const reused = [];
    const jobs = pendingJobs(root, cfg, files, { expiry: whole !== 'all', onReuse: (x) => reused.push(x), save: false });
    for (const x of reused) out(`would reuse ${sanitizeText(x.file)} [${x.pass}] (renamed from ${sanitizeText(x.from)})\n`);
    if (!jobs.length) { if (!reused.length) out('nothing needs review\n'); return 0; }
    for (const j of jobs) out(`would review ${sanitizeText(j.file)} [${j.pass}]\n`);
    out(`${size({ files: new Set(jobs.map((j) => j.file)).size, passes: new Set(jobs.map((j) => j.pass)).size })}\n`);
    return 0;
  }
  if (auto) ensureStateDir(root);
  const log = auto
    ? (m) => appendLog(root, `${new Date().toISOString()} ${sanitizeText(m)}\n`)
    : (m) => err(sanitizeText(m) + '\n');
  // --all is about content: a review past its shelf life is renewed by --due, named files or --changed-since.
  // By hand, results are printed once below, so the log carries only progress and failures.
  const r = await reviewFiles(root, cfg, files, { log, quietResults: !auto, max: auto ? cfg.maxFilesPerRun : Infinity, backoff: auto, session: a.one('session'), expiry: whole !== 'all', lockWait: auto ? { ms: (cfg.timeoutSeconds + 60) * 1000, pollMs: 2000 } : null, onStart: whole ? (n) => err(`Reviewing ${size(n)}…\n`) : null });
  if (!auto) {
    for (const x of r.reused || []) out(`${sanitizeText(x.file)} [${x.pass}] ${x.verdict} (the review of ${sanitizeText(x.from)}, same text)\n`);
    for (const x of r.reviewed) {
      out(`${sanitizeText(x.file)} [${x.pass}] ${x.verdict}\n`);
      for (const f of x.findings) out(`    ${sanitizeText(f)}\n`);
    }
    if (!r.reviewed.length && !r.failed.length && !r.skipped && !r.reused?.length) out('nothing needs review\n');
  }
  // --json <file>: what this run did, for the GitHub Action to annotate failures with. Text is sanitised here.
  if (a.one('json')) {
    const clean = (x) => ({ file: sanitizeText(x.file), pass: x.pass, ...(x.error !== undefined ? { error: sanitizeText(x.error) } : { verdict: x.verdict, findings: (x.findings || []).map(sanitizeText) }) });
    const summary = { reviewed: r.reviewed.map(clean), failed: r.failed.map(clean), reused: (r.reused || []).map(clean), skipped: r.skipped || null };
    writeFileSync(resolve(process.cwd(), a.one('json')), JSON.stringify(summary, null, 2) + '\n');
  }
  return r.failed.length || r.skipped ? 1 : 0;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// A path as one shell word: as it is when that is safe, quoted otherwise.
const shellWord = (s) => (/^[\w./@%+,:=-]+$/.test(s) && !s.startsWith('-') ? s : shq(s));
function hookScript() {
  return `#!/bin/sh
${HOOK_MARKER}. Re-run \`review-seal install-hook\` to refresh.
# Both review-seal launchers start with "#!/usr/bin/env node", so they only work when node is on PATH.
if command -v node >/dev/null 2>&1; then
  if [ -x ./node_modules/.bin/review-seal ]; then exec ./node_modules/.bin/review-seal check --staged; fi
  if command -v review-seal >/dev/null 2>&1; then exec review-seal check --staged; fi
  if [ -f ${shq(BIN_PATH)} ]; then exec node ${shq(BIN_PATH)} check --staged; fi
fi
if [ -x ${shq(process.execPath)} ]; then exec ${shq(process.execPath)} ${shq(BIN_PATH)} check --staged; fi
echo "review-seal: could not find node or review-seal. Install review-seal (npm i -D review-seal) or re-run install-hook." >&2
exit 1
`;
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const within = (dir, p) => p === dir || p.startsWith(dir + sep);

// The ledger's merge driver: repo-local git config naming the command, and a .gitattributes line pointing the
// ledger at it. git runs drivers from the top of the work tree, through the shell.
function installMergeDriver(root) {
  let ledger = '.seal/ledger.json';
  try { ledger = loadConfig(root)?.ledger || ledger; } catch { /* a broken config: the default ledger */ }
  if (/\s/.test(ledger)) { out(`Not setting up the ledger merge driver: ${sanitizeText(ledger)} has whitespace, which .gitattributes cannot name\n`); return; }
  if (/[*?[\]\\]/.test(ledger)) { out(`Not setting up the ledger merge driver: ${sanitizeText(ledger)} has a pattern character (* ? [ ] or \\), which .gitattributes would read as a pattern\n`); return; }
  const args = 'merge-driver %O %A %B';
  const driver = `if [ -x ./node_modules/.bin/review-seal ]; then ./node_modules/.bin/review-seal ${args}; `
    + `elif command -v review-seal >/dev/null 2>&1; then review-seal ${args}; `
    + `else node ${shq(BIN_PATH)} ${args}; fi`;
  gitConfig(root, 'merge.review-seal.name', 'review-seal ledger merge');
  gitConfig(root, 'merge.review-seal.driver', driver);
  const ga = assertInsideReal(root, '.gitattributes');
  const cur = existsSync(ga) ? readFileSync(ga, 'utf8') : '';
  const line = `${ledger} merge=review-seal`;
  if (!cur.split(/\r?\n/).includes(line)) appendFileSync(ga, (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n');
  out(`Set up the ledger merge driver (git config merge.review-seal.*, .gitattributes: ${sanitizeText(line)}); commit .gitattributes\n`);
}

const HOOK_MANAGERS = [
  ['.husky', 'husky: add "review-seal check --staged" as the last line of .husky/pre-commit and .husky/pre-merge-commit, after any formatter'],
  ...['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml'].map((f) => [f, 'lefthook: add pre-commit and pre-merge-commit commands running "review-seal check --staged", after any formatter']),
  ['.pre-commit-config.yaml', 'pre-commit: add the review-seal hook for the pre-commit and pre-merge-commit stages, after any formatter (docs/reference.md, "pre-commit")'],
];

// A clone without the hook commits unchecked; check says so once per clone. Not in CI, not from a git hook (git
// sets GIT_INDEX_FILE for its hooks), and not where a hook manager or core.hooksPath runs the hooks instead.
const HOOK_HINT = 'hook-hint-shown';
const truthy = (v) => Boolean(v) && !/^(false|0|no)$/i.test(v);
const inCI = () => process.env.GITHUB_ACTIONS === 'true' || ['CI', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL'].some((k) => truthy(process.env[k]));
function hookHint(root) {
  try {
    if (inCI() || process.env.GIT_INDEX_FILE || process.env.PRE_COMMIT) return;
    if (HOOK_MANAGERS.some(([f]) => existsSync(join(root, f))) || gitConfigGet(root, 'core.hooksPath')) return;
    const hook = gitPath(root, 'hooks/pre-commit');
    if (existsSync(hook) && /review-seal/.test(readFileSync(hook, 'utf8'))) return;
    if (existsSync(statePath(root, HOOK_HINT))) return;
    ensureStateDir(root);
    writeFileSync(statePath(root, HOOK_HINT), '');
    const cli = cliName(root);
    err(`review-seal: this clone has no review-seal hook; run ${cli} install-hook (or add "prepare": "review-seal install-hook" to package.json)\n`);
  } catch { /* a hint is never worth failing the check */ }
}

function cmdInstallHook(a) {
  const root = rootOrDie();
  installMergeDriver(root);
  const managers = HOOK_MANAGERS.filter(([f]) => existsSync(join(root, f)));
  if (managers.length) {
    out('Found a hook manager, so not writing .git/hooks directly:\n');
    for (const m of new Set(managers.map(([, m]) => m))) out(`  ${m}\n`);
    return 0;
  }
  const hooksDir = gitPath(root, 'hooks');
  const h = real(hooksDir);
  if (!a.has('force') && !within(real(gitCommonDir(root)), h) && !within(real(root), h)) {
    throw new UsageError(`git runs hooks for this repository from ${hooksDir}, which is outside this repository; a pre-commit hook there would affect other repositories too. Re-run with --force to install it anyway.`);
  }
  // A clean `git merge` runs pre-merge-commit, never pre-commit, so the same check goes in both.
  mkdirSync(hooksDir, { recursive: true });
  for (const name of ['pre-commit', 'pre-merge-commit']) {
    const target = join(hooksDir, name);
    if (existsSync(target) && !readFileSync(target, 'utf8').includes(HOOK_MARKER)) {
      out(`${target} already exists. Add this line to it, after any formatter:\n  review-seal check --staged\n`);
      continue;
    }
    writeFileSync(target, hookScript());
    chmodSync(target, 0o755);
    out(`Installed ${target}\n`);
  }
  return 0;
}

async function cmdHook(event) {
  let input = '';
  try { input = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  const r = await runHook(event, BIN_PATH, input);
  if (r.out) process.stdout.write(r.out); // JSON for Claude Code, not a log line
  return 0;
}
