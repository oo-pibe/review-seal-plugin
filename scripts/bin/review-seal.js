#!/usr/bin/env node
import { main } from '../lib/cli.js';
import { sanitizeText, ciSafe } from '../lib/text.js';

// A reader that goes away early (review-seal list | head) is not an error: stop writing and exit quietly.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => {
    if (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED') return;
    throw e;
  });
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    // An unexpected error can quote a file name or git's output, so it is printed as plain text, line by line.
    const text = process.env.REVIEW_SEAL_DEBUG ? err.stack || err.message : err.message;
    process.stderr.write(String(text).split('\n').map((l, i) => ciSafe(`${i ? '  ' : 'review-seal: '}${sanitizeText(l)}`)).join('\n') + '\n');
    process.exitCode = 2;
  },
);
