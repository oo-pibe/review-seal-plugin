// Text that came from a reviewer or from a repository (findings, ledger fields, file names, checklist paths,
// reviewer errors) is untrusted. It is passed through sanitizeText before it is stored or shown, so it cannot
// drive a terminal (ANSI and OSC escapes), reorder what a reader sees (bidi overrides), or split into extra
// lines that a CI runner would read as its own commands.

// Tabs and line breaks become spaces, so a finding stays on one line.
const BREAKS = /[\t\n\r\u2028\u2029]/g;
// Every other C0 control, DEL, every C1 control, and the bidi embedding, override and isolate characters.
const STRIP = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeText(s) {
  return String(s ?? '').replace(BREAKS, ' ').replace(STRIP, '');
}

// On GitHub Actions the runner reads a printed line as a workflow command when it starts with "::" after any
// leading whitespace, and reads the legacy "##[" form anywhere in a line. ciSafe defuses both in one printed
// line (callers split their output into lines first). Elsewhere the line is returned unchanged.
export function ciSafe(line, env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') return line;
  return String(line).replace(/##\[/g, '## [').replace(/^(\s*)::/, '$1: :');
}

// GitHub workflow command escaping: data escapes % CR LF; property values also : and ,.
export const ghData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
export const ghProp = (s) => ghData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
