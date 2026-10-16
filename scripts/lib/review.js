import { readFileSync, readdirSync, lstatSync, appendFileSync, renameSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync, utimesSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { contentHash } from './hash.js';
import { passesFor, assertInsideReal } from './config.js';
import { loadLedger, saveLedger, makeEntry, validateEntry } from './ledger.js';
import { needsReview } from './evaluate.js';
import { rubricHashes, reviewByOf } from './files.js';
import { runReviewer } from './reviewer.js';
import { writeBlob, skipWorktreeFiles } from './git.js';

export const STATE_DIR = '.seal/.state';

// A path in the state directory (or the directory itself), refused if it goes through a symlink.
export const statePath = (root, name) => assertInsideReal(root, name ? `${STATE_DIR}/${name}` : STATE_DIR);

export const today = () => new Date().toISOString().slice(0, 10);

// Failed reviews back off so a broken reviewer is not rerun at the end of every turn. A record is keyed by
// file, pass and content hash, so changing the file starts over.
const FAILURES = 'failures.json';
const BACKOFF_MS = 10 * 60 * 1000;
export const MAX_FAILURES = 3;
const FAILURE_TTL_MS = 7 * 24 * 3600 * 1000;
export const failureKey = (job) => `${job.file}|${job.pass}|${job.contentHash}`;

export function readFailures(root) {
  try {
    const o = JSON.parse(readFileSync(statePath(root, FAILURES), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

function writeFailures(root, f) {
  ensureStateDir(root);
  const p = statePath(root, FAILURES);
  const tmp = `${p}.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(f));
  renameSync(tmp, p);
}

export function backedOff(failures, job, now = Date.now()) {
  const f = failures[failureKey(job)];
  if (!f) return false;
  if (f.failures >= MAX_FAILURES) return true;
  const t = Date.parse(f.lastAt);
  return Number.isFinite(t) && now - t < BACKOFF_MS;
}

// The ledger key of a review that reviewed exactly this text against this checklist for a file that no longer
// exists (the file was renamed or moved), or null. A file outside a sparse checkout is not on disk but still exists.
function renamedFrom(root, led, pass, contentHash, rubricHash, file, sparse) {
  for (const [k, passes] of Object.entries(led)) {
    const e = passes?.[pass];
    if (k === file || !e || e.contentHash !== contentHash || e.rubricHash !== rubricHash) continue;
    if (k.startsWith('/') || k.split(/[\\/]/).includes('..')) continue; // a ledger key is not trusted to name a path outside the repo
    if (validateEntry(k, pass, e).length) continue;
    if (lstatSync(join(root, k), { throwIfNoEntry: false })) continue;
    if ((sparse.value ??= skipWorktreeFiles(root)).has(k)) continue;
    return k;
  }
  return null;
}

// With onReuse (reviewFiles, under the lock), a file that needs review but whose exact text and checklist were
// reviewed under a name that no longer exists takes that review over instead of paying for a new one. The entry
// moves to the new name with the same fields: it is the same text, read against the same checklist.
// save: false (a dry run) reports reuses without writing the ledger.
export function pendingJobs(root, cfg, files, { backoff = false, expiry = true, onReuse = null, save = true } = {}) {
  const led = loadLedger(root, cfg);
  let moved = false;
  const rh = rubricHashes(root, cfg);
  const failures = backoff ? readFailures(root) : {};
  const jobs = [];
  const sparse = {};
  for (const file of files) {
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    const bytes = readFileSync(abs);
    const ch = contentHash(bytes);
    const text = bytes.toString('utf8');
    // Reviews past their shelf life are due too, unless the caller ignores shelf life (review --all).
    const opts = expiry ? { today: today(), reviewBy: reviewByOf(text) } : {};
    for (const pass of passesFor(file, cfg)) {
      const want = { contentHash: ch, rubricHash: rh[pass] };
      if (onReuse && needsReview(file, pass, led, want, cfg, opts)) {
        const from = renamedFrom(root, led, pass, ch, rh[pass], file, sparse);
        if (from) {
          const { token, ...fields } = led[from][pass];
          const e = makeEntry(file, pass, fields);
          if (!needsReview(file, pass, { [file]: { [pass]: e } }, want, cfg, opts)) {
            led[file] = { ...(led[file] || {}), [pass]: e };
            const { [pass]: _, ...rest } = led[from];
            if (Object.keys(rest).length) led[from] = rest; else delete led[from];
            moved = true;
            onReuse({ file, pass, from, verdict: e.verdict, findings: e.findings });
            continue;
          }
        }
      }
      if (needsReview(file, pass, led, want, cfg, opts)) {
        const job = { file, pass, rubricPath: cfg.passes[pass].rubric, contentHash: ch, rubricHash: rh[pass], tools: [...(cfg.passes[pass].tools || [])], fetchDomains: [...(cfg.passes[pass].fetchDomains || [])] };
        if (!backedOff(failures, job)) jobs.push(job);
      }
    }
  }
  if (moved && save) saveLedger(root, cfg, led);
  return jobs;
}

function holderAlive(p) {
  let pid;
  try {
    const raw = readFileSync(p, 'utf8').trim();
    try { const j = JSON.parse(raw); pid = typeof j === 'number' ? j : j?.pid; } catch { /* not JSON */ }
  } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const LOCK_STALE_MS = (1800 + 60) * 1000;

// Is a review running now: the lock is there, recent, and its holder alive?
export function reviewRunning(root) {
  try {
    const p = statePath(root, 'review.lock');
    return Date.now() - statSync(p).mtimeMs < LOCK_STALE_MS && holderAlive(p);
  } catch { return false; }
}

function acquireLock(root) {
  ensureStateDir(root);
  const p = statePath(root, 'review.lock');
  const me = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(p, me, { flag: 'wx' });
      return {
        touch: () => {
          try {
            if (readFileSync(p, 'utf8') !== me) return false;
            const n = new Date();
            utimesSync(p, n, n);
            return true;
          } catch { return false; }
        },
        release: () => { try { if (readFileSync(p, 'utf8') === me) unlinkSync(p); } catch { /* already gone */ } },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let judged = null;
      try { judged = readFileSync(p, 'utf8'); } catch { /* vanished */ }
      let fresh = false;
      try { fresh = Date.now() - statSync(p).mtimeMs < LOCK_STALE_MS; } catch { /* vanished */ }
      if (fresh && holderAlive(p)) return null;
      try {
        if (readFileSync(p, 'utf8') === judged) unlinkSync(p);
      } catch { /* raced */ }
    }
  }
  return null;
}

// The reviewed bytes as a git object, so the commit check can measure later edits against them. Without one
// (the object store is read-only, say) the entry is still recorded, and any later edit counts as substantive.
export function storeReviewed(root, file, bytes) {
  try { return writeBlob(root, file, bytes); } catch { return undefined; }
}

// review.log for review --auto. Past LOG_MAX it keeps the last LOG_KEEP bytes, from the first whole line.
const LOG_MAX = 256 * 1024;
const LOG_KEEP = 128 * 1024;
export function appendLog(root, line) {
  const p = statePath(root, 'review.log');
  try {
    if (statSync(p).size > LOG_MAX) {
      const buf = readFileSync(p);
      let tail = buf.subarray(buf.length - LOG_KEEP);
      const nl = tail.indexOf(0x0a);
      tail = nl === -1 ? Buffer.alloc(0) : tail.subarray(nl + 1);
      const tmp = `${p}.${process.pid}.${randomUUID()}`;
      writeFileSync(tmp, tail);
      renameSync(tmp, p);
    }
  } catch { /* no log yet */ }
  appendFileSync(p, line);
}

export function ensureStateDir(root) {
  const dir = statePath(root);
  mkdirSync(dir, { recursive: true });
  statePath(root); // mkdir could have raced a symlink into place
  const g = statePath(root, '.gitignore');
  if (!existsSync(g)) writeFileSync(g, '*\n');
}

// A drain hands over at most INBOX_MAX items; past that the oldest clean results go first, then the oldest others.
// Appending never rewrites the live inbox, so nothing appended alongside it can be overwritten.
export const INBOX_MAX = 500;
export function trimInbox(items) {
  let excess = items.length - INBOX_MAX;
  if (excess <= 0) return items;
  const drop = new Set();
  for (let i = 0; i < items.length && excess > 0; i++) if (items[i]?.type === 'clean') { drop.add(i); excess--; }
  for (let i = 0; i < items.length && excess > 0; i++) if (!drop.has(i)) { drop.add(i); excess--; }
  return items.filter((_, i) => !drop.has(i));
}

// A writer leaves a marker while it appends, so a drain that renames the inbox away can wait for writes that
// opened the old file to land before reading it. A marker created after the drain lists them belongs to a
// writer that opens the new inbox. A marker whose mtime is more than WRITER_STALE_MS away from now, either way,
// is from a writer that died (or a clock that jumped), and the drain removes it.
const WRITER_PREFIX = 'inbox-writing.';
const WRITER_STALE_MS = 10_000;
const WRITER_WAIT_MS = 2_000;

// With no session draining it, the inbox could grow without end. Past INBOX_FULL_BYTES an append drops clean
// results and, for the rest, leaves one { type: 'full' } note until the next drain. The marker
// inbox-full.<inode> says that inbox already has its note, so a marker left from an inbox that has since gone
// cannot silence the note for a new one. Appends stay appends: nothing rewrites the live inbox.
export const INBOX_FULL_BYTES = 1024 * 1024;
const FULL_PREFIX = 'inbox-full.';

export function appendInbox(root, items) {
  if (!items.length) return;
  ensureStateDir(root);
  const p = statePath(root, 'inbox.jsonl');
  let st = null;
  try { st = statSync(p); } catch { /* no inbox yet */ }
  if (st && st.size > INBOX_FULL_BYTES) {
    if (!items.some((i) => i?.type !== 'clean')) return;
    try { writeFileSync(statePath(root, `${FULL_PREFIX}${st.ino}`), '', { flag: 'wx' }); } catch { return; } // the note is already there
    items = [{ type: 'full', at: new Date().toISOString() }];
  }
  const marker = statePath(root, `${WRITER_PREFIX}${process.pid}.${randomUUID()}`);
  writeFileSync(marker, '', { flag: 'wx' });
  try {
    appendFileSync(p, items.map((i) => JSON.stringify(i) + '\n').join(''));
  } finally {
    try { unlinkSync(marker); } catch { /* gone */ }
  }
}

function waitForWriters(dir) {
  let pending;
  try { pending = readdirSync(dir).filter((f) => f.startsWith(WRITER_PREFIX)).map((f) => join(dir, f)); } catch { return; }
  const deadline = Date.now() + WRITER_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (pending.length && Date.now() < deadline) {
    pending = pending.filter((fp) => {
      let mtime;
      try { mtime = lstatSync(fp).mtimeMs; } catch { return false; }
      if (Math.abs(Date.now() - mtime) <= WRITER_STALE_MS) return true;
      try { unlinkSync(fp); } catch { /* gone */ }
      return false;
    });
    if (pending.length) Atomics.wait(pause, 0, 0, 2);
  }
}

// With a session id, a drain takes that session's items, untagged items and items over a day old (their
// session has likely ended); the rest go back into the inbox for their own session.
// A drain claims the inbox by renaming it to inbox.jsonl.<claim time>.<pid>.<uuid>. A claim over a minute old
// belongs to a drain that died; another drain takes it over by renaming it to a claim of its own, so only one
// drain reads it. Age comes from the name, since a rename keeps the old file's mtime. A name whose first part is
// not a finite number (an older version's pid-only name parses as a time long past) counts as abandoned too.
const INBOX_ORPHAN_MS = 24 * 3600 * 1000;
const CLAIM_ORPHAN_MS = 60_000;
export function drainInbox(root, sessionId) {
  const dir = statePath(root);
  const p = statePath(root, 'inbox.jsonl');
  const claimName = () => `${p}.${Date.now()}.${process.pid}.${randomUUID()}`;
  const files = [];
  // Orphans first: they are older than what is in the inbox now.
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('inbox.jsonl.')) continue;
      const fp = join(dir, f);
      if (lstatSync(fp).isSymbolicLink()) continue;
      const born = Number(f.slice('inbox.jsonl.'.length).split('.')[0]);
      if (Number.isFinite(born) && Date.now() - born <= CLAIM_ORPHAN_MS) continue; // claimed under a minute ago: its drain is still working
      try { const claim = claimName(); renameSync(fp, claim); files.push(claim); } catch { /* another drain won */ }
    }
  } catch { /* no state dir */ }
  const mine = claimName();
  try {
    renameSync(p, mine);
    files.push(mine);
    try {
      for (const f of readdirSync(dir)) if (f.startsWith(FULL_PREFIX)) try { unlinkSync(join(dir, f)); } catch { /* gone */ }
    } catch { /* no state dir */ }
    waitForWriters(dir);
  } catch { /* nothing queued */ }
  let out = [];
  for (const fp of files) {
    try {
      if (lstatSync(fp).isSymbolicLink()) throw new Error('symlink');
      for (const line of readFileSync(fp, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* torn line */ }
      }
    } catch { /* claimed by another drain */ }
    try { unlinkSync(fp); } catch { /* gone */ }
  }
  out = trimInbox(out);
  if (sessionId === undefined || sessionId === null) return out;
  const now = Date.now();
  const forMe = (i) => !i || !i.session || i.session === String(sessionId) || !(now - Date.parse(i.at) < INBOX_ORPHAN_MS);
  appendInbox(root, out.filter((i) => !forMe(i)));
  return out.filter(forMe);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// lockWait { ms, pollMs }: wait that long for another run to finish (review --auto, so a second Stop queues
// behind the first instead of dropping its files). Still locked at the deadline, the session is told in its inbox
// what to run. Without lockWait a held lock skips the run at once.
// The raw output of the last reviewer whose verdict could not be read, for debugging. Local state, capped.
export const RAW_OUTPUT = 'last-reviewer-output.txt';
const RAW_MAX = 1024 * 1024;
function saveRaw(root, raw) {
  try {
    ensureStateDir(root);
    const p = statePath(root, RAW_OUTPUT);
    const tmp = `${p}.${process.pid}.${randomUUID()}`;
    writeFileSync(tmp, String(raw).slice(-RAW_MAX));
    renameSync(tmp, p);
    return true;
  } catch { return false; }
}

// quietResults: leave verdicts and reused reviews out of the log (a caller that prints them itself).
export async function reviewFiles(root, cfg, files, { log = () => {}, run = runReviewer, max = cfg.maxFilesPerRun, backoff = false, session, expiry = true, lockWait = null, quietResults = false, onStart = null } = {}) {
  let lock = acquireLock(root);
  if (!lock && lockWait) {
    log('another review is running; waiting for it to finish');
    const deadline = Date.now() + lockWait.ms;
    while (!lock && Date.now() < deadline) {
      await sleep(Math.max(1, Math.min(lockWait.pollMs, deadline - Date.now())));
      lock = acquireLock(root);
    }
  }
  if (!lock) {
    let pending = [];
    try { pending = pendingJobs(root, cfg, files, { backoff, expiry }); } catch { /* nothing to report */ }
    const names = [...new Set(pending.map((j) => j.file))];
    if (lockWait) {
      log('another review was still running; skipped');
      const error = `review skipped because another review was still running; run review-seal review ${names.join(' ')}`;
      const tag = { ...(session ? { session: String(session) } : {}), at: new Date().toISOString() };
      appendInbox(root, pending.map(({ file, pass }) => ({ file, pass, error, ...tag })));
    } else {
      log(`another review is already running; run review-seal review ${(names.length ? names : files).join(' ')} when it finishes`);
    }
    return { reviewed: [], failed: [], remaining: null, skipped: 'locked' };
  }
  try {
    const reused = [];
    const all = pendingJobs(root, cfg, files, { backoff, expiry, onReuse: (x) => { reused.push(x); if (!quietResults) log(`reused the review of ${x.from} for ${x.file} [${x.pass}]: same text, same checklist`); } });
    const keep = new Set([...new Set(all.map((j) => j.file))].slice(0, max));
    const jobs = all.filter((j) => keep.has(j.file));
    if (onStart && jobs.length) onStart({ files: keep.size, passes: new Set(jobs.map((j) => j.pass)).size });
    const reviewed = [];
    const failed = [];
    try {
      for (const job of jobs) {
        try {
          if (!lock.touch()) { log('lost the review lock; stopping'); break; }
          log(`reviewing ${job.file} [${job.pass}]`);
          const r = await run(job, { root, model: cfg.model, timeoutSeconds: cfg.timeoutSeconds });
          if (!r.ok) {
            const error = r.raw !== undefined && saveRaw(root, r.raw) ? `${r.error}; raw output saved to ${STATE_DIR}/${RAW_OUTPUT}` : r.error;
            failed.push({ ...job, error });
            log(`  not reviewed: ${error}`);
            continue;
          }
          const v = r.verdict;
          if (v.file !== job.file || v.pass !== job.pass || v.contentHash !== job.contentHash || v.rubricHash !== job.rubricHash) {
            failed.push({ ...job, error: 'the reviewer reported on a different version or file' });
            continue;
          }
          const abs = join(root, job.file);
          if (!existsSync(abs)) {
            failed.push({ ...job, error: 'the file was removed during review' });
            continue;
          }
          const bytes = readFileSync(abs);
          if (contentHash(bytes) !== job.contentHash) {
            failed.push({ ...job, error: 'the file changed during review; it will be reviewed again next time' });
            continue;
          }
          const reviewedBlob = storeReviewed(root, job.file, bytes);
          const led = loadLedger(root, cfg);
          led[job.file] = {
            ...(led[job.file] || {}),
            [job.pass]: makeEntry(job.file, job.pass, { at: today(), contentHash: job.contentHash, rubricHash: job.rubricHash, verdict: v.verdict, findings: v.findings, reviewer: 'independent', via: 'agent', reviewedBlob }),
          };
          saveLedger(root, cfg, led);
          reviewed.push({ ...job, verdict: v.verdict, findings: v.findings });
          if (!quietResults) log(`  ${v.verdict}${v.findings.length ? ` (${v.findings.length} finding${v.findings.length === 1 ? '' : 's'})` : ''}`);
        } catch (e) {
          failed.push({ ...job, error: e.message });
          log(`  not reviewed: ${e.message}`);
        }
      }
    } finally {
      const fl = readFailures(root);
      const now = Date.now();
      for (const k of Object.keys(fl)) if (!(now - Date.parse(fl[k]?.lastAt) < FAILURE_TTL_MS)) delete fl[k];
      for (const j of reviewed) delete fl[failureKey(j)];
      for (const j of failed) {
        const k = failureKey(j);
        fl[k] = { failures: (Number(fl[k]?.failures) || 0) + 1, lastAt: new Date(now).toISOString() };
      }
      try { writeFailures(root, fl); } catch (e) { log(`could not record review failures: ${e.message}`); }
      const tag = { ...(session ? { session: String(session) } : {}), at: new Date().toISOString() };
      appendInbox(root, [
        ...reviewed.filter((x) => x.verdict === 'findings').map(({ file, pass, findings }) => ({ file, pass, findings, ...tag })),
        // Clean results too, so the session hears that the review it waited for came back clean. A run with no
        // session (by hand, cron) has no one waiting.
        ...(session ? reviewed.filter((x) => x.verdict === 'clean').map(({ file, pass }) => ({ file, pass, type: 'clean', ...tag })) : []),
        ...failed.map(({ file, pass, error, contentHash }) => ({ file, pass, error, contentHash, ...tag })),
      ]);
    }
    return { reviewed, failed, reused, remaining: new Set(all.map((j) => j.file)).size - keep.size };
  } finally {
    lock.release();
  }
}
