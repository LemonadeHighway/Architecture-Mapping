// Small text helpers shared by every scanner: line numbers, normalizing files, balanced brackets.

/** Strips a byte-order mark and turns CRLF into LF, so offsets and line numbers agree on every OS. */
export function normalizeText(raw) {
  let text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return text.replace(/\r\n?/g, "\n");
}

/** Builds a function offset -> 1-based line number. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** The text of one line (1-based), trimmed, for evidence. */
export function lineText(text, line) {
  let start = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf("\n", start);
    if (next < 0) return "";
    start = next + 1;
  }
  const end = text.indexOf("\n", start);
  return text.slice(start, end < 0 ? text.length : end).trim().slice(0, 240);
}

const OPEN = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);

/**
 * Given `masked` code (comments and string contents blanked) and the offset of an opening bracket, returns the
 * offset of its matching closing bracket, or -1.
 */
export function matchBracket(masked, open) {
  const stack = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (CLOSE.has(c)) {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Splits masked[start, end) at top-level commas. Returns [{start, end}] ranges. `generics` also treats `<...>` as
 * brackets: right for parameter lists (`Func<A, B> f`), wrong for argument lists (`a < b`), so it is opt-in.
 */
export function splitTopLevel(masked, start, end, { generics = false } = {}) {
  const sep = ",";
  const parts = [];
  let depth = 0;
  let angle = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (generics && c === "<" && /\w/.test(masked[i - 1] ?? "")) angle++;
    else if (generics && c === ">" && angle > 0 && masked[i - 1] !== "=") angle--;
    else if (c === sep && depth === 0 && angle === 0) {
      parts.push({ start: from, end: i });
      from = i + 1;
    }
  }
  if (end > from && masked.slice(from, end).trim()) parts.push({ start: from, end });
  return parts;
}

/** Index of the first non-whitespace character at or after i. */
export function skipSpace(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** Index of the last non-whitespace character at or before i. */
export function skipSpaceBack(s, i) {
  while (i >= 0 && /\s/.test(s[i])) i--;
  return i;
}

/** Masks values of secret-looking keys in config text ("Password": "x" -> "Password": "•••"). */
export function maskSecrets(text) {
  return text
    .replace(/("(?:[^"]*(?:password|passwd|secret|apikey|api_key|token|key|connectionstring)[^"]*)"\s*:\s*")([^"]+)(")/gi, (_, a, _v, c) => `${a}•••masked•••${c}`)
    .replace(/((?:password|pwd)\s*=\s*)([^;"\s]+)/gi, (_, a) => `${a}•••masked•••`);
}
