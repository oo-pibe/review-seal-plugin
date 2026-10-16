import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from './hash.js';
import { passesFor, assertInsideReal } from './config.js';
import { trackedAndUntracked } from './git.js';

export function coveredFiles(root, cfg) {
  return [...new Set(trackedAndUntracked(root))]
    .filter((f) => passesFor(f, cfg).length && lstatSync(join(root, f), { throwIfNoEntry: false })?.isFile())
    .sort();
}

// read returns a checklist's bytes; by default from the working tree (check --staged reads the index).
export function rubricHashes(root, cfg, read = (p) => readFileSync(assertInsideReal(root, p))) {
  const out = {};
  for (const [name, p] of Object.entries(cfg.passes)) out[name] = contentHash(read(p.rubric));
  return out;
}

// `review-by: YYYY-MM-DD` in a file's front matter: content known to need a fresh look by that date.
// Only a real calendar date counts; anything else is ignored.
export function reviewByOf(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const d = m[1].match(/^review-by:[ \t]*(["']?)(\d{4}-\d{2}-\d{2})\1[ \t]*\r?$/m);
  if (!d) return null;
  const t = new Date(d[2] + 'T00:00:00Z');
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d[2] ? d[2] : null;
}
