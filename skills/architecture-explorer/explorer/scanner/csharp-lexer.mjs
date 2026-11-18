// A C# lexer that is just precise enough for static scanning: it finds every comment and string literal (regular,
// verbatim @"", interpolated $"", raw """ and interpolated raw $"""), and returns
//   masked:  the source with comments and string *contents* replaced by spaces (newlines kept), so a regex over it
//            can never match inside a comment or a string, and offsets/line numbers stay identical to the source;
//   strings: every literal with its offset and value.
// It does not build a syntax tree. What it cannot know (types, overloads) the graph marks as inferred.

export function lexCSharp(text) {
  const out = text.split("");
  const strings = [];
  const comments = [];
  const n = text.length;
  let i = 0;

  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    // Comments.
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      comments.push({ start: i, end: stop, doc: text[i + 2] === "/" });
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      comments.push({ start: i, end: stop, doc: false });
      blank(i, stop);
      i = stop;
      continue;
    }
    // Preprocessor lines (#region, #if ...): blanked, they never hold code we care about.
    if (c === "#" && /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i))) {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    // Character literals.
    if (c === "'") {
      let j = i + 1;
      while (j < n && j < i + 12 && text[j] !== "'" && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      if (text[j] === "'") {
        blank(i + 1, j);
        i = j + 1;
        continue;
      }
      i++;
      continue;
    }
    // String literals: optional $ (one or more) and/or @, then quotes.
    if (c === '"' || c === "$" || c === "@") {
      const lit = readString(text, i);
      if (lit) {
        strings.push(lit);
        blank(lit.contentStart, lit.contentEnd);
        i = lit.end;
        continue;
      }
    }
    i++;
  }
  return { masked: out.join(""), strings, comments };
}

/** Reads a string literal starting at i, or returns null when i doesn't start one. */
function readString(text, i) {
  let j = i;
  let dollars = 0;
  let verbatim = false;
  while (text[j] === "$" || text[j] === "@") {
    if (text[j] === "$") dollars++;
    else verbatim = true;
    j++;
  }
  if (text[j] !== '"') return null;
  // `@` alone before an identifier (@class) is not a string; `$` only appears for strings.
  if (j - i > 3) return null;
  const prefixEnd = j;
  let quotes = 0;
  while (text[j + quotes] === '"') quotes++;

  // Raw string: three or more quotes.
  if (quotes >= 3) {
    const contentStart = prefixEnd + quotes;
    const closer = '"'.repeat(quotes);
    let k = text.indexOf(closer, contentStart);
    if (k < 0) k = text.length;
    let end = k + quotes;
    while (text[end] === '"') end++; // a longer run still closes
    const raw = text.slice(contentStart, k);
    return { start: i, end, contentStart, contentEnd: k, value: dedentRaw(raw), kind: "raw", interpolated: dollars > 0 };
  }

  // Empty string "".
  if (quotes === 2 && !verbatim) {
    return { start: i, end: prefixEnd + 2, contentStart: prefixEnd + 1, contentEnd: prefixEnd + 1, value: "", kind: "regular", interpolated: dollars > 0 };
  }

  const contentStart = prefixEnd + 1;
  let k = contentStart;
  let value = "";
  while (k < text.length) {
    const ch = text[k];
    if (verbatim) {
      if (ch === '"') {
        if (text[k + 1] === '"') {
          value += '"';
          k += 2;
          continue;
        }
        break;
      }
    } else {
      if (ch === "\\") {
        const e = text[k + 1];
        value += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "" : e ?? "";
        k += 2;
        continue;
      }
      if (ch === '"' || ch === "\n") break;
    }
    if (dollars > 0 && ch === "}" && text[k + 1] === "}") {
      value += "}";
      k += 2;
      continue;
    }
    if (dollars > 0 && ch === "{") {
      if (text[k + 1] === "{") {
        value += "{";
        k += 2;
        continue;
      }
      // Holes are marked \u0001expr\u0002 so a reader can tell `{{id}}` (literal braces) from `{action}` (a value).
      const holeEnd = skipHole(text, k);
      value += `\u0001${text.slice(k + 1, holeEnd - 1)}\u0002`;
      k = holeEnd;
      continue;
    }
    value += ch;
    k++;
  }
  const contentEnd = k;
  const end = text[k] === '"' ? k + 1 : k;
  return { start: i, end, contentStart, contentEnd, value, kind: verbatim ? "verbatim" : "regular", interpolated: dollars > 0 };
}

/** Skips an interpolation hole `{ ... }`, including nested strings and braces. Returns the offset after `}`. */
function skipHole(text, open) {
  let depth = 0;
  let k = open;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '"' || ((ch === "$" || ch === "@") && /["$@]/.test(text[k + 1] ?? ""))) {
      const inner = readString(text, k);
      if (inner) {
        k = inner.end;
        continue;
      }
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return k + 1;
    } else if (ch === "\n" && depth <= 1 && text[k - 1] !== ",") {
      // A regular interpolated string can't span lines; stop rather than swallow the file.
    }
    k++;
  }
  return k;
}

/** Raw strings drop the indentation of their closing line; for scanning SQL the content is enough as is. */
function dedentRaw(raw) {
  return raw.replace(/^\n/, "");
}
