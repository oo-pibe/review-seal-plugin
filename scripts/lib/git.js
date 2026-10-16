import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// literal: false only for commands that reject pathspec magic (check-ignore takes plain paths anyway).
const git = (args, cwd, { env = process.env, input, literal = true, encoding = 'utf8' } = {}) => execFileSync('git', args, {
  cwd, env: literal ? { ...env, GIT_LITERAL_PATHSPECS: '1' } : env, encoding, maxBuffer: 64 * 1024 * 1024,
  input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
});
const list = (s) => s.split('\0').filter(Boolean);

export function repoRoot(cwd) {
  try { return git(['rev-parse', '--show-toplevel'], cwd).trim(); } catch { return null; }
}
// Paths from `diff --raw -z --no-renames` output (":old new oldsha newsha S\0path\0"), symlinks (mode 120000) and
// submodules (mode 160000) left out: neither is a file to review.
function rawPaths(out) {
  const parts = out.split('\0');
  const paths = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!['120000', '160000'].includes(parts[i].split(' ')[1])) paths.push(parts[i + 1]);
  }
  return paths;
}
export const stagedFiles = (root) => rawPaths(git(['diff', '--cached', '--raw', '--no-renames', '--diff-filter=ACMRT', '-z'], root));
export const stagedContent = (root, file) => git(['cat-file', 'blob', `:0:${file}`], root);
// The staged blob's bytes (a Buffer), for hashing.
export const stagedBytes = (root, file) => git(['cat-file', 'blob', `:0:${file}`], root, { encoding: 'buffer' });
export const stagedDiff = (root, file) => git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--', file], root);
// Paths in the index marked skip-worktree (outside a sparse checkout): tracked, though not on disk.
export function skipWorktreeFiles(root) {
  try { return new Set(list(git(['ls-files', '-t', '-z', '--cached'], root)).filter((x) => x.startsWith('S ')).map((x) => x.slice(2))); } catch { return new Set(); }
}
export const trackedAndUntracked = (root) => list(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root));
export function changedSince(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error('invalid ref');
  return rawPaths(git(['diff', '--raw', '--no-renames', '--diff-filter=ACMRT', '-z', '--end-of-options', `${ref}...HEAD`, '--'], root));
}
// Every path the index changes against HEAD, deletions included (renames as a deletion and an addition).
export const stagedPathsAll = (root) => list(git(['diff', '--cached', '--name-only', '--no-renames', '-z'], root));
// Every path changed between the merge base with ref and HEAD, deletions included.
export function changedSinceAll(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error('invalid ref');
  return list(git(['diff', '--name-only', '--no-renames', '-z', '--end-of-options', `${ref}...HEAD`, '--'], root));
}
export function mergeBase(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error('invalid ref');
  return git(['merge-base', '--end-of-options', ref, 'HEAD'], root).trim();
}
// The commits a merge in progress brings in, or []. A merge concluded by "git commit" has MERGE_HEAD (one line
// per head for an octopus merge). A clean "git merge" runs pre-merge-commit before it writes MERGE_HEAD, so there
// the heads come from what git merge was given (GIT_REFLOG_ACTION "merge <names>"), or from FETCH_HEAD for
// "git pull". A name that does not resolve gives [], and the merge is judged as a plain commit.
export function mergeHeads(root, env = process.env) {
  try { return readFileSync(gitPath(root, 'MERGE_HEAD'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l)); } catch { /* none */ }
  const action = String(env.GIT_REFLOG_ACTION || '');
  let names = [];
  if (/^merge /.test(action)) names = action.slice(6).split(' ').filter(Boolean);
  else if (/^pull\b/.test(action)) {
    try {
      names = readFileSync(gitPath(root, 'FETCH_HEAD'), 'utf8').split('\n').filter((l) => l && !/\tnot-for-merge\t/.test(l)).map((l) => l.split('\t')[0]);
    } catch { return []; }
  }
  const heads = [];
  for (const n of names) {
    const c = n.startsWith('-') ? null : commitOrNull(root, n);
    if (!c) return [];
    heads.push(c);
  }
  return heads;
}
// The best common ancestor of these commits, or null (unrelated histories).
export function octopusBase(root, revs) {
  try { return git(['merge-base', '--octopus', '--end-of-options', ...revs], root).trim() || null; } catch { return null; }
}
// The commits in from..to that are not merges, oldest first.
export const commitsBetween = (root, from, to) => list(git(['rev-list', '--no-merges', '--reverse', '-z', '--end-of-options', `${from}..${to}`, '--'], root).replace(/\n/g, '\0'));
// Every path whose staged version differs from commit c's, deletions included.
export const stagedChangesAgainst = (root, c) => list(git(['diff', '--cached', '--name-only', '--no-renames', '-z', '--end-of-options', c, '--'], root));
// Every path that differs between two commits, deletions included.
export const changedBetween = (root, a, b) => list(git(['diff', '--name-only', '--no-renames', '-z', '--end-of-options', a, b, '--'], root));
// The commit a rev names, or null (HEAD before the first commit).
export function commitOrNull(root, rev) {
  try { return git(['rev-parse', '--verify', '-q', '--end-of-options', `${rev}^{commit}`], root).trim(); } catch { return null; }
}
// A file's text in a commit, or null when the commit has no such file.
export function fileAtOrNull(root, rev, file) {
  try { return git(['cat-file', 'blob', `${rev}:${file}`], root); } catch { return null; }
}
export const gitPath = (root, name) => resolve(root, git(['rev-parse', '--git-path', name], root).trim());
// env selects the index (GIT_INDEX_FILE); it defaults to this process's environment.
export function stagedFileOrNull(root, file, env) {
  try { return git(['cat-file', 'blob', `:0:${file}`], root, { env }); } catch { return null; }
}
export function stagedBytesOrNull(root, file) {
  try { return git(['cat-file', 'blob', `:0:${file}`], root, { encoding: 'buffer' }); } catch { return null; }
}
export function stageBlob(root, path, content, env) {
  const sha = git(['hash-object', '-w', '--stdin'], root, { env, input: content }).trim();
  git(['update-index', '--add', '--cacheinfo', `100644,${sha},${path}`], root, { env });
}
// Store bytes as a git object, filtered as `git add <file>` would (line endings, clean filters), and return its id.
export const writeBlob = (root, file, bytes) => git(['hash-object', '-w', '--stdin', `--path=${file}`], root, { input: bytes }).trim();
// The id of the object a rev names (":0:path", "HEAD:path", a blob id), or null.
export function objectIdOrNull(root, spec) {
  try { return git(['rev-parse', '--verify', '-q', '--end-of-options', spec], root).trim() || null; } catch { return null; }
}
export function blobExists(root, id) {
  try { git(['cat-file', '-e', `${id}^{blob}`], root); return true; } catch { return false; }
}
export const blobBytes = (root, id) => git(['cat-file', 'blob', id], root, { encoding: 'buffer' });
// A -U0 diff between two blobs, in the shape classifyChange reads.
export const diffBlobs = (root, a, b) => git(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', a, b], root);
export const gitConfig = (root, key, value) => git(['config', '--local', key, value], root);
// A git config value, or null when it is not set.
export function gitConfigGet(root, key) {
  try { return git(['config', '--get', key], root).trim() || null; } catch { return null; }
}
export const indexPath = (root, env) => resolve(root, git(['rev-parse', '--git-path', 'index'], root, { env }).trim());
export const gitCommonDir = (root) => resolve(root, git(['rev-parse', '--git-common-dir'], root).trim());
// Paths that differ from HEAD in the index or working tree, untracked files included (ignored ones are not).
// With -z a rename or copy is "XY new\0old\0"; only the new path is kept.
export function workingTreeChanges(root) {
  // GIT_OPTIONAL_LOCKS=0: status must not take index.lock, or it could collide with the user's own git commands.
  const parts = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root, { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++;
  }
  return out;
}
// Does git ignore this repo path? check-ignore exits 0 when it does, 1 when it does not.
export function isIgnored(root, file) {
  const { GIT_LITERAL_PATHSPECS, ...env } = process.env;
  try { git(['check-ignore', '-q', '--', file], root, { env, literal: false }); return true; } catch (e) {
    if (e.status === 1) return false;
    throw e;
  }
}
