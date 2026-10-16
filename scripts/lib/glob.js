// Small glob: `*` (within a directory), `**` (any depth), `?` (one character). Everything else is literal.
export function globToRegExp(glob) {
  glob = glob.replace(/(\*\*\/)+/g, '**/');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

export function matchAny(path, globs) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.some((g) => globToRegExp(g.replace(/^(?:\.\/|\/)+/, '')).test(p));
}
