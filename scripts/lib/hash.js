import { createHash } from 'node:crypto';

// Whitespace-only edits should not cost a review; any change to the words should.
export function normalize(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

// Bytes that are valid UTF-8 are hashed as normalised text, so a file hashes the same read as bytes or as text.
// Other bytes are hashed as they are: decoding them would turn every invalid byte into U+FFFD, and different
// files would hash the same.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function contentHash(content) {
  let data = content;
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    try { data = normalize(utf8.decode(content)); } catch { data = content; }
  } else data = normalize(content);
  return 'sha256:' + createHash('sha256').update(data).digest('hex').slice(0, 16);
}

// Binds the review's evidence AND the version reviewed. Hand-editing any field breaks it.
// It is not a signature: anyone can recompute it. It catches edits, not forgery.
export function computeToken(file, pass, e) {
  const canonical = JSON.stringify({
    file,
    pass,
    at: e.at,
    contentHash: e.contentHash,
    rubricHash: e.rubricHash,
    verdict: e.verdict,
    findings: [...(e.findings || [])].map(String).sort(),
    reviewer: e.reviewer,
    via: e.via,
    // Only when present, so entries written before reviewedBlob existed keep their tokens.
    ...(e.reviewedBlob === undefined ? {} : { reviewedBlob: e.reviewedBlob }),
  });
  return 'rv_' + createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}
