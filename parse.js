// A fast Markdown-to-HTML renderer that mirrors the output of marked 18.1.3
// with its default options (GFM enabled, line breaks off, non-pedantic).
//
// The implementation is a hand-written two-phase parser:
//   1. a line-oriented block parser (containers are stripped by recursion:
//      block quotes and list items gather their lines, strip their markers
//      or content indentation, and are parsed again as their own line list);
//   2. an inline scanner that walks the text of a leaf block once, building
//      a small node list, then resolves link brackets and emphasis with a
//      delimiter stack.
//
// parse() is pure: every call builds a fresh link-definition table and a
// fresh block tree, and nothing is shared between calls.

// ---------------------------------------------------------------------------
// Small character helpers
// ---------------------------------------------------------------------------

const PUNCT_ASCII = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

function isAsciiPunct(ch) {
  return ch !== '' && PUNCT_ASCII.indexOf(ch) !== -1;
}

// Unicode punctuation or symbol, used by the flanking rules. ASCII fast path
// first so the regex only runs for non-ASCII neighbours of a delimiter run.
const UNICODE_PUNCT_RE = /\p{P}|\p{S}/u;
function isPunctCh(ch) {
  if (ch === '') return false;
  if (ch.charCodeAt(0) < 128) return isAsciiPunct(ch);
  return UNICODE_PUNCT_RE.test(ch);
}

function isWsCh(ch) {
  return ch === '' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
    ch === '\f' || ch === '\v' || ch === ' ' ||
    (ch.charCodeAt(0) > 127 && /\s/.test(ch));
}

// ---------------------------------------------------------------------------
// Escaping and URL handling
// ---------------------------------------------------------------------------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ANY_RE = /[&<>"']/;
const ESC_ALL_RE = /[&<>"']/g;

// Escape a run of plain text: every markup-significant character is encoded.
function escText(s) {
  if (!ESC_ANY_RE.test(s)) return s;
  return s.replace(ESC_ALL_RE, (ch) => ESC_MAP[ch]);
}

// Escape literal code content; identical character set to escText.
function escCode(s) {
  return escText(s);
}

const ENTITY_AHEAD_RE = /^(?:#\d+|#[xX][0-9a-fA-F]+|\w+);/;

// Escape a value placed inside a double-quoted attribute. An ampersand that
// already introduces an entity reference is left alone, matching the
// reference renderer's treatment of hrefs and titles.
function escAttr(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      const m = ENTITY_AHEAD_RE.exec(s.slice(i + 1, i + 24));
      if (m) { out += '&' + m[0]; i += 1 + m[0].length; } else { out += '&amp;'; i++; }
    } else if (c === '<') { out += '&lt;'; i++; }
    else if (c === '>') { out += '&gt;'; i++; }
    else if (c === '"') { out += '&quot;'; i++; }
    else if (c === "'") { out += '&#39;'; i++; }
    else { out += c; i++; }
  }
  return out;
}

// Percent-encode a link destination the way encodeURI does, then make it
// safe for an attribute. Lone surrogates are replaced before encoding so a
// malformed destination can never throw.
// Characters that make encodeURI change a string (plus %, whose %25
// form the un-replace step rewrites). Without any of them the encoding
// steps are the identity.
const HREF_ENCODE_RE = /[%\\"<>\^`{|[\]}\x00-\x20\x7f-\uffff]/;

function cleanHref(raw) {
  if (!HREF_ENCODE_RE.test(raw)) return escAttr(raw);
  let u;
  try {
    u = encodeURI(raw).replace(/%25/g, '%');
  } catch {
    u = encodeURI(raw.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')).replace(/%25/g, '%');
  }
  return escAttr(u);
}

// Resolve backslash escapes of ASCII punctuation inside a destination or
// title value; a backslash before anything else stays as it is.
function resolveEscapes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line measurement: indentation is counted in columns, a tab advances to the
// next multiple of four.
// ---------------------------------------------------------------------------

function indentOf(line) {
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col, idx: i };
}

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

// In a table body, a whitespace-only line that holds a tab within its
// first four columns still counts as a (empty) row; any other
// whitespace-only line ends the body.
function isTableBodyBlank(line) {
  if (!isBlankLine(line)) return false;
  return !(line.indexOf('\t') !== -1 && indentOf(line).cols <= 4);
}

// A table body also ends before a line that opens with four spaces, or
// with a tab after at most three spaces: such a line lexes as indented
// code, never as a row.
function tableLineBlocked(line) {
  // A whitespace-only line is governed by the blank-line rule, not this
  // one (the code pattern needs a character after the indent).
  if (isBlankLine(line)) return false;
  let sp = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') { sp++; if (sp >= 4) return true; }
    else if (c === '\t') return true;
    else return false;
  }
  return false;
}

// Rewrite the leading whitespace run of `s` (which starts at column `col`)
// as plain spaces of the same total width, so later column arithmetic on
// the result stays true to the original line.
function expandLeadingWs(s, col) {
  let i = 0;
  let c = col;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') c++;
    else c += 4 - (c % 4);
    i++;
  }
  if (i === 0) return s;
  return ' '.repeat(c - col) + s.slice(i);
}

// Advance `n` columns from character position `idx` (which sits at column
// `col`) over whitespace, returning the rest of the line. A tab straddling
// the cut leaves its remaining width as spaces.
function advanceCols(line, idx, col, n) {
  let i = idx;
  let c = col;
  let left = n;
  while (left > 0 && i < line.length) {
    const ch = line[i];
    if (ch === ' ') { i++; c++; left--; }
    else if (ch === '\t') {
      const w = 4 - (c % 4);
      if (w <= left) { i++; c += w; left -= w; }
      else return expandLeadingWs(' '.repeat(w - left) + line.slice(i + 1), col + n);
    } else break;
  }
  return expandLeadingWs(line.slice(i), col + n);
}

// Expand every tab in a line to spaces at the next multiple-of-four
// column.
function expandTabs(line) {
  if (!line.includes('\t')) return line;
  let out = '';
  let col = 0;
  for (const c of line) {
    if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else { out += c; col++; }
  }
  return out;
}

// Remove up to `count` leading whitespace characters; a tab counts as
// one character here, not as its column width. Fence content is dedented
// this way.
function stripWsChars(line, count) {
  let i = 0;
  while (i < count && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

// Remove up to `cols` columns of leading indentation. A tab that straddles
// the cut is replaced by the spaces that remain of it.
function stripCols(line, cols, expand) {
  if (cols <= 0) return line;
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n && col < cols) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else {
        // The cut falls inside this tab: the rest of the tab becomes
        // spaces. Container content then has its leading whitespace
        // re-expressed in spaces at the same columns; code content keeps
        // the remainder of the line verbatim.
        const rest = ' '.repeat(col + w - cols) + line.slice(i + 1);
        return expand ? expandLeadingWs(rest, cols) : rest;
      }
    } else break;
  }
  return expand ? expandLeadingWs(line.slice(i), cols) : line.slice(i);
}

// ---------------------------------------------------------------------------
// Block-level matchers
// ---------------------------------------------------------------------------

const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const ATX_RE = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const HR_RE = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/;
const SETEXT_RE = /^(=+|-+)[ \t]*$/;
// A line consisting only of pipes, colons, dashes and spaces (with at
// least one pipe): a setext heading whose text starts with, or contains,
// such a line does not convert.
const TABLE_LIKE_RE = /^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*$/;
// A line that is a single HTML tag: a setext heading whose text starts
// with, or contains, such a line does not convert either.
const HTML_LINE_RE = /^ {0,3}<[^>\n]+>$/;

// Cheap pre-check for HTML_LINE_RE: at most three leading spaces, then
// a '<'. (The regex allows spaces only, never tabs.)
function htmlLineMaybe(s) {
  let k = 0;
  while (k < 4 && s[k] === ' ') k++;
  return k <= 3 && s[k] === '<';
}
const QUOTE_RE = /^>[ \t]?/;

// Parse a list marker at the start of an already indent-measured line.
// Returns null when the line does not open a list item.
function listMarker(line) {
  const ind = indentOf(line);
  if (ind.cols > 3) return null;
  const rest = line.slice(ind.idx);
  let m = /^([-*+])[ \t]/.exec(rest) || /^([-*+])$/.exec(rest);
  let ordered = false;
  let bullet = '';
  let delim = '';
  let number = 0;
  let width = 0;
  if (m) {
    bullet = m[1];
    width = 1;
  } else {
    m = /^(\d{1,9})([.)])(?:[ \t]|$)/.exec(rest);
    if (!m) return null;
    ordered = true;
    number = parseInt(m[1], 10);
    delim = m[2];
    width = m[1].length + 1;
  }
  const after = rest.slice(width);
  const blank = /^[ \t]*$/.test(after);
  // Columns of whitespace between the marker's end and the content (for
  // a blank item, the whitespace that trails the marker on its line).
  let spaces = 0;
  {
    let col = ind.cols + width;
    let i = 0;
    while (i < after.length && (after[i] === ' ' || after[i] === '\t')) {
      if (after[i] === ' ') { col++; spaces++; }
      else { const w = 4 - (col % 4); col += w; spaces += w; }
      i++;
    }
  }
  return {
    indent: ind.cols, ordered, bullet, delim, number, width,
    spaces, blank, markerEnd: ind.cols + width,
  };
}

function sameListKind(a, b) {
  if (a.ordered !== b.ordered) return false;
  return a.ordered ? a.delim === b.delim : a.bullet === b.bullet;
}

// The CommonMark block-level tag names (HTML block condition 6).
const BLOCK_TAGS = new Set((
  'address article aside base basefont blockquote body caption center col ' +
  'colgroup dd details dialog dir div dl dt fieldset figcaption figure ' +
  'footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe ' +
  'legend li link main menu menuitem nav noframes ol optgroup option p ' +
  'param search section summary table tbody td tfoot th thead title tr ' +
  'track ul'
).split(' '));

const HTML_TYPE1 = ['pre', 'script', 'style', 'textarea'];

// Try to read an HTML tag starting at the beginning of `s` (which starts
// with '<'). Returns the tag name in lower case and the end index, or null.
// Used for HTML block conditions 6 and 7.
function scanTag(s, from) {
  let i = from;
  if (s[i] === '/') i++;
  const nameMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(s.slice(i));
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  i += nameMatch[0].length;
  if (s[from] === '/') {
    // A closing tag takes no attributes: optional whitespace, then '>'.
    let j = i;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (s[j] === '>') return { name, end: j + 1, closing: true };
    return null;
  }
  // Attributes.
  for (;;) {
    let j = i;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (j >= s.length) return null;
    if (s[j] === '>') return { name, end: j + 1, closing: s[from] === '/' };
    if (s[j] === '/' && s[j + 1] === '>') {
      if (s[from] === '/') return null;
      return { name, end: j + 2, closing: false };
    }
    if (j === i) return null; // attributes need separating whitespace
    const attr = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(s.slice(j));
    if (!attr) return null;
    j += attr[0].length;
    // Optional value.
    let k = j;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    if (s[k] === '=') {
      k++;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
      if (s[k] === '"' || s[k] === "'") {
        const close = s.indexOf(s[k], k + 1);
        if (close === -1) return null;
        j = close + 1;
      } else {
        const val = /^[^ \t"'=<>`]+/.exec(s.slice(k));
        if (!val) return null;
        j = k + val[0].length;
      }
    }
    i = j;
  }
}

// Which HTML block condition a line opens, or 0. The line must already be
// known to have at most three columns of indentation. Conditions 1 and 6
// look only at the tag name and the character right after it, so a tag that
// spans several lines still opens its block on the first line.
function htmlBlockStart(line) {
  const ind = indentOf(line);
  if (ind.cols > 3) return 0;
  const s = line.slice(ind.idx);
  if (s[0] !== '<') return 0;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (s.startsWith('<![CDATA[')) return 5;
  if (/^<![A-Z]/.test(s)) return 4;
  const nm = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (!nm) return 0;
  const closing = nm[1] === '/';
  const name = nm[2].toLowerCase();
  const after = s[nm[0].length];
  if (!closing && HTML_TYPE1.indexOf(name) !== -1) {
    if (after === undefined || after === '>' || after === ' ' || after === '\t') return 1;
    return 0;
  }
  if (BLOCK_TAGS.has(name)) {
    if (after === undefined || after === '>' || after === ' ' || after === '\t' ||
        (after === '/' && s[nm[0].length + 1] === '>')) return 6;
    return 0;
  }
  // Condition 7: a complete open or closing tag alone on the line.
  const tag = scanTag(s, 1);
  if (tag && /^[ \t]*$/.test(s.slice(tag.end))) return 7;
  return 0;
}

// Split a table row into raw cell strings. Pipes escaped with a backslash do
// not split; one leading and one trailing pipe (the row's frame) are dropped.
function splitRow(line) {
  const s = line.trim();
  const cells = [];
  let cur = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && s[i + 1] === '|') {
      // An escaped pipe is cell content, not a separator, and the backslash
      // is consumed by the row split itself.
      cur += '|';
      i += 2;
    } else if (c === '\\' && i + 1 < n && s[i + 1] === '\\') {
      cur += c + s[i + 1];
      i += 2;
    } else if (c === '|') {
      cells.push(cur);
      cur = '';
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  cells.push(cur);
  // The row's frame (one leading and one trailing pipe) contributes no
  // cell: a first or last cell that is empty after trimming is dropped,
  // so a lone '|' splits to zero cells.
  const out = cells.map((c) => c.trim());
  if (out.length > 0 && out[0] === '') out.shift();
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

// If `line` is a table delimiter row, return its alignments, else null.
// Whether a line is a table delimiter row in the loose sense used by
// the paragraph match's lookahead (a row of dashes/colons/pipes, even a
// single dash, which is looser than what actually forms a table).
// A table delimiter row consists of nothing but pipes, colons, dashes
// and whitespace; anything else cannot be one, cheaply checked first.
const DELIM_CHARS_RE = /^[\s|:\-]+$/;
const DELIM_LOOKAHEAD_RE = /^ {0,3}\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
function delimLookahead(line) {
  return DELIM_LOOKAHEAD_RE.test(line);
}

function tableDelimiter(line) {
  const s = line.trim();
  if (s === '') return null;
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell[0] === ':';
    const right = cell[cell.length - 1] === ':';
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

const FOLD_MAP = { 'ß': 'ss', 'ς': 'σ', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
function normalizeLabel(raw) {
  // Unicode case folding: lowercasing plus the full-fold special cases.
  return raw.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[ßςﬀ-ﬆ]/g, (c) => FOLD_MAP[c] || c);
}

// Read a link label starting at s[i] === '['. Returns {raw, end} where end is
// the index just past the closing ']', or null.
function scanLabel(s, i) {
  let j = i + 1;
  const n = s.length;
  let raw = '';
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { raw += c + s[j + 1]; j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') {
      if (raw.length > 999) return null;
      return { raw, end: j + 1 };
    }
    raw += c;
    j++;
    if (raw.length > 1000) return null;
  }
  return null;
}

// Read a link destination at s[i]: either <...> or a bare run with balanced
// parentheses. Returns {raw, end} or null.
function scanDest(s, i) {
  const n = s.length;
  if (s[i] === '<') {
    let j = i + 1;
    let raw = '';
    while (j < n) {
      const c = s[j];
      if (c === '\\' && j + 1 < n) { raw += c + s[j + 1]; j += 2; continue; }
      if (c === '<') return null;
      if (c === '>') return { raw, end: j + 1 };
      if (c === '\n') return null;
      raw += c;
      j++;
    }
    return null;
  }
  let j = i;
  let raw = '';
  let depth = 0;
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
    if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
      raw += c + s[j + 1];
      j += 2;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    raw += c;
    j++;
  }
  if (depth !== 0) return null;
  return { raw, end: j };
}

// Read a link title at s[i] (one of " ' (). Returns {raw, end} or null.
function scanTitle(s, i) {
  const open = s[i];
  const close = open === '(' ? ')' : open;
  if (open !== '"' && open !== "'" && open !== '(') return null;
  let j = i + 1;
  const n = s.length;
  let raw = '';
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { raw += c + s[j + 1]; j += 2; continue; }
    if (c === close) return { raw, end: j + 1 };
    if (open === '(' && c === '(') return null;
    raw += c;
    j++;
  }
  return null;
}

// Try to parse a link reference definition beginning at lines[i]. Definitions
// may put the destination and the title on following lines. On success the
// definition is registered (the first one for a label wins) and the number
// of lines consumed is returned; otherwise 0.
function tryDefinition(lines, i, links) {
  // Work on a window of following lines joined with newlines. A parse may
  // cross a line ending only where the grammar allows one: inside a title,
  // before the destination and before the title — never across a blank line.
  const window = lines.slice(i, i + 16).join('\n');
  const ind = indentOf(lines[i]);
  if (ind.cols > 3) return 0;
  let pos = ind.idx;
  if (window[pos] !== '[') return 0;
  const label = scanLabel(window, pos);
  if (!label || label.raw.indexOf('\n\n') !== -1) return 0;
  pos = label.end;
  if (window[pos] !== ':') return 0;
  pos++;
  const skipSpaces = (p) => {
    while (window[p] === ' ' || window[p] === '\t') p++;
    return p;
  };
  const newlinesBefore = (p) => {
    let c = 0;
    for (let k = 0; k < p; k++) if (window[k] === '\n') c++;
    return c;
  };
  // Move past at most one line ending (and the next line's indentation).
  // Returns the new position, or -1 when crossing is impossible.
  const crossLine = (p) => {
    if (window[p] !== '\n') return -1;
    const nextLine = lines[i + newlinesBefore(p) + 1];
    if (nextLine === undefined || nextLine.trim() === '') return -1;
    return skipSpaces(p + 1);
  };
  pos = skipSpaces(pos);
  const np = crossLine(pos);
  if (np !== -1) pos = np;
  const destStart = pos;
  const dest = scanDest(window, pos);
  if (!dest) return 0;
  if (dest.raw === '' && window[destStart] !== '<') return 0;
  pos = dest.end;
  // After the destination: an optional title on the same line or the next
  // one, then nothing but spaces to the end of that line.
  let title = null;
  let endPos = -1;
  let p = skipSpaces(pos);
  if (window[p] === '"' || window[p] === "'" || window[p] === '(') {
    if (p === pos) return 0; // the title needs separating whitespace
    const t = scanTitle(window, p);
    if (!t || t.raw.indexOf('\n\n') !== -1) return 0;
    title = t.raw;
    p = skipSpaces(t.end);
    if (p < window.length && window[p] !== '\n') return 0;
    endPos = p;
  } else if (p >= window.length || window[p] === '\n') {
    endPos = p;
    // The title may sit on the next line instead.
    const q = crossLine(p);
    if (q !== -1 && (window[q] === '"' || window[q] === "'" || window[q] === '(')) {
      const t = scanTitle(window, q);
      if (t && t.raw.indexOf('\n\n') === -1) {
        const r = skipSpaces(t.end);
        if (r >= window.length || window[r] === '\n') {
          title = t.raw;
          endPos = r;
        }
      }
    }
  } else {
    return 0;
  }
  const key = normalizeLabel(label.raw);
  if (key === '') return 0;
  if (!links.has(key)) {
    links.set(key, {
      href: resolveEscapes(dest.raw),
      title: title === null ? null : resolveEscapes(title),
    });
  }
  return newlinesBefore(endPos) + 1;
}

// ---------------------------------------------------------------------------
// The block parser
// ---------------------------------------------------------------------------

// Does this line begin a block that may interrupt a paragraph?
function interruptsParagraph(line, inList) {
  const ind = indentOf(line);
  if (ind.cols >= 4) return false;
  const rest = line.slice(ind.idx);
  // No block start begins with any other character than these.
  const c0 = rest[0];
  if (c0 !== '`' && c0 !== '~' && c0 !== '#' && c0 !== '>' && c0 !== '*' &&
      c0 !== '-' && c0 !== '+' && c0 !== '_' && c0 !== '<' &&
      !(c0 >= '0' && c0 <= '9')) return false;
  if (FENCE_RE.test(rest)) {
    // A backtick fence whose info string holds a backtick is not a fence.
    const m = FENCE_RE.exec(rest);
    if (!(m[1][0] === '`' && m[2].indexOf('`') !== -1)) return true;
  }
  if (ATX_RE.test(rest)) return true;
  if (QUOTE_RE.test(rest)) return true;
  if (HR_RE.test(rest)) return true;
  const hb = htmlBlockStart(line);
  if (hb >= 1 && hb <= 6) return true;
  const mk = listMarker(line);
  if (mk && !mk.blank) {
    // Inside a list item an ordered marker of any number interrupts; at
    // the top level and in quotes only the number 1 does.
    if (!mk.ordered || mk.number === 1 || inList) return true;
  }
  return false;
}

// Does a parsed block list end inside a paragraph (possibly nested in a
// quote or a list item)? Used to decide lazy continuation lines.
function endsInParagraph(blocks) {
  if (blocks.length === 0) return false;
  const last = blocks[blocks.length - 1];
  if (last.t === 'p') return true;
  if (last.t === 'quote') return endsInParagraph(last.children);
  if (last.t === 'list' && last.items.length > 0) {
    return endsInParagraph(last.items[last.items.length - 1].blocks);
  }
  return false;
}

// Probe parses of a growing line array (a quote body being gathered)
// repeat for every lazy line; within one gather the parse of a prefix
// never changes (the marks that steer it are only ever added at its
// end), so callers may pass a Map to memoize block lists by prefix
// length and parse variant.
function probeParse(cache, key, linesArr, contSet, inList, barriers) {
  if (!cache) {
    return parseBlocks(linesArr, { links: new Map() }, contSet, undefined, inList, !inList, barriers).blocks;
  }
  const k = key + ':' + linesArr.length;
  let blocks = cache.get(k);
  if (blocks === undefined) {
    blocks = parseBlocks(linesArr, { links: new Map() }, contSet, undefined, inList, !inList, barriers).blocks;
    cache.set(k, blocks);
  }
  return blocks;
}

// Parse a candidate container body with a throwaway link table and report
// whether it ends inside a paragraph.
function tailIsParagraph(linesArr, inList, contSet, barriers, cache) {
  if (linesArr.length === 0 || linesArr[linesArr.length - 1] === '') return false;
  const blocks = probeParse(cache, inList ? 'pi' : 'p', linesArr, contSet, inList, barriers);
  return endsInParagraph(blocks);
}

// Whether the lines end with a paragraph block at the top level (not a
// paragraph nested inside a list item or another quote).
function tailIsTopParagraph(linesArr, contSet, barriers, cache) {
  if (linesArr.length === 0 || linesArr[linesArr.length - 1] === '') return false;
  const blocks = probeParse(cache, 'p', linesArr, contSet, false, barriers);
  return blocks.length > 0 && blocks[blocks.length - 1].t === 'p';
}

// Whether the lines end with a code block at the top level.
function tailIsCode(linesArr, contSet, barriers, cache) {
  if (linesArr.length === 0 || linesArr[linesArr.length - 1] === '') return false;
  const blocks = probeParse(cache, 'p', linesArr, contSet, false, barriers);
  return blocks.length > 0 && blocks[blocks.length - 1].t === 'code';
}

// Whether the lines end with a list block at the top level.
function tailIsList(linesArr, cache) {
  if (linesArr.length === 0 || linesArr[linesArr.length - 1] === '') return false;
  const blocks = probeParse(cache, 'l', linesArr, null, false, undefined);
  return blocks.length > 0 && blocks[blocks.length - 1].t === 'list';
}

// Whether the lines end with an HTML block that began with a type-7 tag
// (a tag outside the block-tag list). Inside a quote such a block starts
// at a group boundary and then swallows the group's remaining lines, so
// lazy lines keep joining it while they do not start a block themselves.
function tailIsHtml7(linesArr, contSet, barriers, cache) {
  if (linesArr.length === 0 || linesArr[linesArr.length - 1] === '') return false;
  const blocks = probeParse(cache, 'p', linesArr, contSet, false, barriers);
  const last = blocks[blocks.length - 1];
  if (!last || last.t !== 'html') return false;
  return htmlBlockStart(last.text.split('\n')[0]) === 7;
}

// A lazy line with any list marker (even an empty one, even an ordered
// marker other than 1) ends a block quote's paragraph, so it is never a
// lazy continuation inside one.
const KE_LIST_RE = /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
function quoteStopLine(line) {
  const ind = indentOf(line);
  if (ind.cols <= 3 && KE_LIST_RE.test(line.slice(ind.idx))) return true;
  return interruptsParagraph(line, false);
}

// Gather and parse a block quote whose first line is lines[i].
function parseQuote(lines, i, ctx) {
  const inner = [];
  const innerSrc = [];
  const contSet = new Set();
  // Lines stripped of four columns by the deep lazy arm: inside the
  // content they join a paragraph with code-fold semantics, unlike
  // scooped setext underlines, which are plain paragraph text.
  const foldSet = new Set();
  const probeCache = new Map();
  // Group boundaries inside the quote: a lazy line that follows a marker
  // line starts a new group. Groups are parsed separately (paragraphs
  // merge across them; tables and headings do not span them), and the
  // quote ends after a group whose last block is code, a heading, a
  // thematic break, HTML or a table.
  const barriers = new Set();
  // Segment starts: a marker line that follows lazy lines opens a new
  // segment; a list gathered in an earlier segment may not reach into
  // it (other blocks flow across).
  const segStarts = new Set();
  // Whether each gathered inner line came in without a quote marker.
  const lazyFlags = [];
  let seenMarker = false;
  let lazySinceMarker = false;
  // Whether the last gathered line was a marker line or a deeply
  // indented line that was itself stripped: a deeply indented lazy line
  // loses four columns only while no plain lazy line precedes it in its
  // group; after a plain lazy line it joins verbatim.
  let deepRun = true;
  // Set by the setext arm when an underline was scooped plainly into a
  // list item: the next lazy line still belongs to the item.
  let listSetextTail = false;
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    const ind = indentOf(line);
    const lstHeld = listSetextTail;
    listSetextTail = false;
    if (ind.cols <= 3 && line[ind.idx] === '>') {
      let content = line.slice(ind.idx + 1);
      if (content[0] === ' ') {
        // The rest of the line's leading whitespace keeps its original
        // column widths, re-expressed in spaces.
        content = expandLeadingWs(content.slice(1), ind.cols + 2);
      }
      else if (content[0] === '\t') {
        // The tab counts as the one optional space after the marker; what
        // remains of its width stays as spaces, and any further leading
        // tabs keep the widths they had in the original line.
        const w = 4 - ((ind.cols + 1) % 4);
        content = expandLeadingWs(
          ' '.repeat(Math.max(0, w - 1)) + content.slice(1), ind.cols + 2);
      }
      // A setext underline on a marker line, when the quote so far ends
      // with a run of lazy lines that continue a paragraph, converts
      // that lazy run alone into the heading: split the run off from
      // the paragraph it was gathered into with a blank line.
      if (SETEXT_RE.test(content) && inner.length > 0 &&
          lazyFlags[inner.length - 1]) {
        let runStart = inner.length - 1;
        while (runStart > 0 && lazyFlags[runStart - 1]) runStart--;
        const pre = runStart > 0
          ? parseBlocks(inner.slice(0, runStart), { links: new Map() }, contSet, undefined, false, true, barriers)
          : null;
        if (pre && pre.blocks.length > 0 &&
            pre.blocks[pre.blocks.length - 1].t === 'p') {
          const shift = (set) => {
            const vals = [...set].map((v) => (v >= runStart ? v + 1 : v));
            set.clear();
            for (const v of vals) set.add(v);
          };
          shift(barriers);
          shift(contSet);
          shift(foldSet);
          shift(segStarts);
          probeCache.clear();
          inner.splice(runStart, 0, '');
          innerSrc.splice(runStart, 0, j);
          lazyFlags.splice(runStart, 0, false);
        }
      }
      if (lazySinceMarker && inner.length > 0) segStarts.add(inner.length);
      lazySinceMarker = false;
      inner.push(content);
      innerSrc.push(j);
      lazyFlags.push(false);
      deepRun = true;
      seenMarker = true;
      j++;
      continue;
    }
    if (isBlankLine(line)) break;
    // A lazy line after a marker line opens a new group.
    const newGroup = () => {
      lazySinceMarker = true;
      if (seenMarker) { barriers.add(inner.length); seenMarker = false; }
    };
    // A deeply indented lazy line joins the paragraph with its indentation
    // stripped, as forced continuation text.
    if (ind.cols >= 4 && deepRun && tailIsTopParagraph(inner, contSet, barriers, probeCache)) {
      newGroup();
      contSet.add(inner.length);
      foldSet.add(inner.length);
      inner.push(stripCols(line, 4, true));
      innerSrc.push(j);
      lazyFlags.push(true);
      deepRun = true;
      j++;
      continue;
    }
    // A lazy setext underline never becomes a heading inside the quote: it
    // is paragraph text, and once the quote already holds two lines it is
    // indented by four spaces so it cannot act as an underline at all.
    const restQ = ind.cols <= 3 ? line.slice(ind.idx) : '';
    if (ind.cols <= 3 && SETEXT_RE.test(restQ) && !HR_RE.test(restQ) &&
        !KE_LIST_RE.test(restQ) &&
        (tailIsParagraph(inner, false, contSet, barriers, probeCache) ||
         tailIsHtml7(inner, contSet, barriers, probeCache))) {
      newGroup();
      contSet.add(inner.length);
      // The four-space form mirrors marked's per-group setext replace:
      // it indents an underline that is not the first line of its group,
      // which in gather terms is an underline whose previous inner line
      // was itself gathered lazily. When the quote's tail is a list the
      // line is consumed by the list instead (no replace applies there)
      // and joins plainly.
      const tailList = tailIsList(inner, probeCache);
      const canConvert = inner.length >= 2 &&
        lazyFlags[inner.length - 1] === true && !tailList;
      inner.push(canConvert ? '    ' + restQ : line);
      innerSrc.push(j);
      lazyFlags.push(true);
      deepRun = false;
      // An underline scooped plainly into a list item converts the
      // item's paragraph to a heading when the item is lexed, but the
      // list's raw line loop still takes the next lazy line into the
      // item; remember that for one line.
      listSetextTail = tailList && !canConvert;
      j++;
      continue;
    }
    // A lazy line that continues a table the quote so far ends with (a
    // body row in the same group, or the first line of a new group after
    // the table) is taken into the quote.
    if (inner.length > 0 && (ind.cols >= 4 || !quoteStopLine(line)) &&
        !isTableBodyBlank(line) && !tableLineBlocked(line) &&
        !interruptsParagraph(line, false) &&
        tailEndsInTable(inner, contSet, barriers, probeCache)) {
      newGroup();
      inner.push(line);
      innerSrc.push(j);
      lazyFlags.push(true);
      deepRun = false;
      j++;
      continue;
    }
    // A deeply indented lazy line in the same group as a table the
    // quote ends with is the group's next block (an indented code
    // block), not a table row: it joins verbatim.
    if (ind.cols >= 4 && inner.length > 0 &&
        lazyFlags[inner.length - 1] &&
        tailEndsInTable(inner, contSet, barriers, probeCache)) {
      newGroup();
      inner.push(line);
      innerSrc.push(j);
      lazyFlags.push(true);
      deepRun = false;
      j++;
      continue;
    }
    // A plain lazy line in the same group as an indented code block the
    // quote ends with still belongs to the group: the group is lexed as
    // a unit, so the line follows the code block inside the quote. It
    // must open no block itself and not be a link definition.
    if (inner.length > 0 && lazyFlags[inner.length - 1] &&
        tailIsCode(inner, contSet, barriers, probeCache) &&
        !quoteStopLine(line) && !interruptsParagraph(line, false) &&
        tryDefinition(lines, j, new Map()) === 0) {
      newGroup();
      inner.push(line);
      innerSrc.push(j);
      lazyFlags.push(true);
      deepRun = false;
      j++;
      continue;
    }
    // Lazy continuation: the line is taken into the quote when the quote so
    // far ends inside a paragraph and the line itself opens no block that
    // would interrupt one. A quote ending in a list whose last item is
    // empty also continues.
    if (inner.length > 0 && !quoteStopLine(line) &&
        (tailIsParagraph(inner, false, contSet, barriers, probeCache) || tailIsEmptyList(inner, contSet, barriers, probeCache) ||
         (lstHeld && !interruptsParagraph(line, false)))) {
      newGroup();
      inner.push(line);
      innerSrc.push(j);
      lazyFlags.push(true);
      deepRun = false;
      j++;
      continue;
    }
    // A quote ending in a type-7 HTML block (started at a group boundary)
    // keeps taking lazy lines that start no block: the block swallows the
    // rest of its group.
    if (inner.length > 0 && !quoteStopLine(line) &&
        !interruptsParagraph(line, false) &&
        tailIsHtml7(inner, contSet, barriers, probeCache)) {
      newGroup();
      inner.push(line);
      innerSrc.push(j);
      lazyFlags.push(true);
      deepRun = false;
      j++;
      continue;
    }
    break;
  }
  const children = parseBlocks(inner, ctx, contSet, undefined, false, true, barriers, false, segStarts, foldSet);
  return [{ t: 'quote', children: children.blocks }, j];
}

// Whether a candidate quote body ends with a list whose last item is
// empty (an empty item does not close the quote's continuation).
function tailIsEmptyList(linesArr, contSet, barriers, cache) {
  if (linesArr.length === 0) return false;
  const blocks = probeParse(cache, 'p', linesArr, contSet, false, barriers);
  if (blocks.length === 0) return false;
  const last = blocks[blocks.length - 1];
  return last.t === 'list' && last.items.length > 0 &&
    last.items[last.items.length - 1].blocks.length === 0;
}

// Whether a candidate quote body ends with a table block (possibly as
// the last block of the last list item, mirroring endsInParagraph).
function tailEndsInTable(linesArr, contSet, barriers, cache) {
  if (linesArr.length === 0) return false;
  const blocks = probeParse(cache, 'p', linesArr, contSet, false, barriers);
  return endsInTable(blocks);
}

function endsInTable(blocks) {
  if (blocks.length === 0) return false;
  const last = blocks[blocks.length - 1];
  if (last.t === 'table') return true;
  if (last.t === 'list' && last.items.length > 0) {
    return endsInTable(last.items[last.items.length - 1].blocks);
  }
  if (last.t === 'quote') return endsInTable(last.children);
  return false;
}

// Gather and parse a list whose first item starts at lines[i].
// Track an open fenced code block across the stripped content lines of a
// list item: while a fence is open, every following line belongs to the
// item (fence content is not subject to the item's indentation rules)
// until the closing fence line.
function fenceTrack(state, line) {
  const ind = indentOf(line);
  if (ind.cols > 3) return state;
  const m = FENCE_RE.exec(line.slice(ind.idx));
  if (!m) return state;
  if (state) {
    if (m[1][0] === state.ch && m[1].length >= state.len &&
        /^[ \t]*$/.test(m[2])) return null;
    return state;
  }
  if (m[1][0] === '`' && m[2].indexOf('`') !== -1) return state;
  return { ch: m[1][0], len: m[1].length };
}

// Whether a lazy setext underline inside a list item is twisted into a
// four-space line: that happens exactly when the previous gathered
// line's content at the item indent (prevM) could serve as setext
// heading text for it — it is non-empty and does not itself open a
// bullet, fence, quote, heading, HTML, or table construct, nor is it
// indented by four or more columns.
function setextTwistOk(m) {
  if (m === '') return false;
  const t = m.replace(/\t/g, '    ');
  if (t.search(/[^ ]/) >= 4) return false;
  const rest = t.replace(/^ {0,3}/, '');
  if (/^(?:[*+-]|\d{1,9}[.)]) /.test(rest)) return false;
  if (/^(?:`{3,}|~{3,})/.test(rest)) return false;
  if (rest.startsWith('>')) return false;
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return false;
  if (HTML_LINE_RE.test(m) || TABLE_LIKE_RE.test(m)) return false;
  return true;
}

// Whether lazy gathering inside a list item stops before the next line,
// judged from the previous gathered line's content at the item indent
// (prevM): gathering stops when that content is indented by four or more
// columns or itself opens a fence, heading, HTML block, or thematic
// break. An empty prevM never blocks.
function itemLazyBlocked(prevM) {
  if (prevM === '') return false;
  const t = prevM.replace(/\t/g, '    ');
  if (t.search(/[^ ]/) >= 4) return true;
  const rest = t.replace(/^ {0,3}/, '');
  if (/^(?:`{3,}|~{3,})/.test(rest)) return true;
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return true;
  if (HR_RE.test(rest)) return true;
  if (rest[0] === '<') {
    const hb = htmlBlockStart(prevM);
    if (hb >= 1 && hb <= 6) return true;
  }
  return false;
}

function parseList(lines, i, ctx, segStarts, barriers) {
  const first = listMarker(lines[i]);
  const baseIndent = first.indent;
  const items = [];
  let loose = false;
  let endBlank = false;
  let lastItemLines = null;
  let lastItemContSet = null;
  let j = i;
  while (j < lines.length) {
    // Blank lines between items belong to the list when another item of
    // the same kind follows them (and they loosen it); otherwise they are
    // left for the enclosing level.
    if (items.length > 0 && isBlankLine(lines[j])) {
      let k = j;
      while (k < lines.length && isBlankLine(lines[k])) k++;
      let nm = k < lines.length ? listMarker(lines[k]) : null;
      if (nm) {
        const indK = indentOf(lines[k]);
        if (indK.cols <= 3 && HR_RE.test(lines[k].slice(indK.idx))) nm = null;
      }
      if (nm && sameListKind(nm, first) && nm.indent <= baseIndent + 3) {
        loose = true;
        j = k;
      } else break;
    }
    const lineJ = lines[j];
    const indJ = indentOf(lineJ);
    if (indJ.cols <= 3 && HR_RE.test(lineJ.slice(indJ.idx))) break;
    const mk = listMarker(lines[j]);
    if (!mk || !sameListKind(mk, first)) break;
    if (items.length > 0 && mk.indent > baseIndent + 3) break;
    // Inside a blockquote, an item whose marker line follows lazy lines
    // opens a new segment and starts a separate list.
    if (items.length > 0 && segStarts && segStarts.has(j)) break;
    // Content indent for this item.
    let ci;
    if (mk.blank || mk.spaces > 4) ci = mk.markerEnd + 1;
    else ci = mk.markerEnd + mk.spaces;
    const itemStartLine = j;
    const itemLines = [];
    const contSet = new Set();
    // The previous gathered line's content at the item indent, used by
    // the lazy setext rule below.
    let prevM = '';
    if (mk.blank) itemLines.push('');
    else {
      const line = lines[j];
      const startIdx = indentOf(line).idx + mk.width;
      itemLines.push(advanceCols(line, startIdx, mk.markerEnd, ci - mk.markerEnd));
      prevM = expandTabs(line.slice(startIdx));
    }
    j++;
    let blanks = 0;
    let itemDone = false;
    let hasContent = !mk.blank;
    let fence = itemLines.length > 0
      ? fenceTrack(null, itemLines[itemLines.length - 1]) : null;
    let fenceContent = 0;
    // Inside a blockquote, a segment start (a marker line that follows
    // lazy lines) caps the item: it may not gather lines at or past the
    // first segment start after its own marker line.
    let segLimit = Infinity;
    if (segStarts) {
      for (const b of segStarts) {
        if (b > itemStartLine && b < segLimit) segLimit = b;
      }
    }
    while (j < lines.length && !itemDone) {
      if (j >= segLimit) break;
      const line = lines[j];
      if (isBlankLine(line)) {
        if (fence) { itemLines.push(''); prevM = ''; j++; continue; }
        // An item that starts blank ends at a second blank line.
        if (mk.blank && !hasContent) break;
        itemLines.push('');
        prevM = '';
        blanks++;
        j++;
        continue;
      }
      const ind = indentOf(line);
      if (fence) {
        if (ind.cols >= ci) {
          hasContent = true;
          const s = stripCols(line, ci, true);
          itemLines.push(s);
          prevM = s;
          fence = fenceTrack(fence, s);
          fenceContent++;
          blanks = 0;
          j++;
          continue;
        }
        // Below the content indent, an open fence keeps only a plain
        // line that directly follows fence content: a line that would
        // interrupt a paragraph, one after a blank, or one after a
        // content line that would itself block a lazy continuation at
        // the item indent (deep indentation, a fence/heading/break
        // start, or an HTML block start), ends the item (the fence
        // stays unclosed inside it) and is parsed outside.
        const prevContent = fenceContent > 0 &&
          itemLines[itemLines.length - 1] !== '' && !itemLazyBlocked(prevM);
        if (prevContent && !interruptsParagraph(line, true)) {
          // A setext-shaped fence line is still twisted to the
          // four-space form when the previous line could take an
          // underline (marked applies the twist to every lazy item
          // line, fence content included).
          if (ind.cols <= 3 && SETEXT_RE.test(line.slice(ind.idx)) &&
              !HR_RE.test(line.slice(ind.idx)) && setextTwistOk(prevM)) {
            itemLines.push('    ' + line.slice(ind.idx));
          } else {
            itemLines.push(line);
          }
          prevM = expandTabs(line).slice(ci);
          fence = fenceTrack(fence, line);
          fenceContent++;
          blanks = 0;
          j++;
          continue;
        }
        break;
      }
      // At a blockquote group barrier, a blank item whose marker was
      // followed by spaces takes nothing: its would-be first content
      // line belongs to the quote's next group instead. (A blank item
      // whose marker ends the line still gathers at the content
      // indent, inside a quote as elsewhere.)
      const atBarrier = barriers && barriers.has(j);
      if (atBarrier && !hasContent && mk.spaces > 0) break;
      // At a barrier, an item whose last gathered line ends with
      // whitespace is closed: a following line below the content indent
      // belongs to the quote's next group, and a line at the content
      // indent starts a new chunk of the item (handled in the indented
      // arm below).
      const prevTrailWs = atBarrier && itemLines.length > 0 &&
        /[ \t]$/.test(itemLines[itemLines.length - 1]);
      if (prevTrailWs && ind.cols < ci) break;
      // An item that starts blank takes content only at the content
      // indent; a line below it ends the (still empty) item.
      if (!hasContent && ind.cols < ci) break;
      if (ind.cols >= ci) {
        hasContent = true;
        if (prevTrailWs) {
          itemLines[itemLines.length - 1] =
            itemLines[itemLines.length - 1].replace(/[ \t]+$/, '');
          itemLines.push('');
          loose = true;
        }
        if (blanks > 0) { /* blank-separated content inside the item */ }
        const s = stripCols(line, ci, true);
        itemLines.push(s);
        prevM = s;
        fence = fenceTrack(null, s);
        if (fence) fenceContent = 0;
        blanks = 0;
        j++;
        continue;
      }
      // Below the content indent: a sibling item, the end of the list, a
      // well-indented continuation, or a lazy paragraph line. A thematic
      // break line is never an item line.
      if (ind.cols <= 3 && HR_RE.test(line.slice(ind.idx))) break;
      const nm = listMarker(line);
      if (nm && ind.cols < ci && ind.cols <= baseIndent + 3) {
        itemDone = true;
        break;
      }
      // A line scooped up by indentation alone (at least four columns
      // but below the content indent) joins the item verbatim through
      // the lazy arm below: inside the item text it folds into the
      // paragraph like any other deeply indented continuation line.

      // A lazy setext underline: when the previous item line has no
      // content at the item indent, the underline converts the item's
      // paragraph into a heading; otherwise it joins the item text as a
      // four-space line (a fold-in, like marked's twisted underline).
      if (blanks === 0 && ind.cols <= 3 && SETEXT_RE.test(line.slice(ind.idx)) &&
          !HR_RE.test(line.slice(ind.idx)) && !itemLazyBlocked(prevM)) {
        if (setextTwistOk(prevM)) {
          itemLines.push('    ' + line.slice(ind.idx));
        } else {
          itemLines.push(line);
        }
        prevM = expandTabs(line).slice(ci);
        j++;
        continue;
      }
      if (blanks === 0 && !interruptsParagraph(line) && !itemLazyBlocked(prevM) &&
          !/^(?:`{3,}|~{3,})/.test(line.slice(ind.idx))) {
        itemLines.push(line);
        prevM = expandTabs(line).slice(ci);
        j++;
        continue;
      }
      break;
    }
    // Trailing blank lines of the item do not belong to it; they separate
    // items (which loosens the list) or end it. The placeholder line of an
    // item that starts blank is not a separator.
    let trailing = 0;
    while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') {
      itemLines.pop();
      trailing++;
    }
    if (mk.blank && itemLines.length === 0) trailing = 0;
    lastItemLines = itemLines;
    lastItemContSet = contSet;
    const parsed = parseBlocks(itemLines, ctx, contSet, undefined, true, false);
    if (parsed.looseSep) loose = true;
    if (trailing > 0 && j < lines.length) {
      const ind3 = indentOf(lines[j]);
      const nm3 = !(ind3.cols <= 3 && HR_RE.test(lines[j].slice(ind3.idx))) && listMarker(lines[j]);
      if (nm3 && sameListKind(nm3, first)) loose = true;
    }
    // Mark task-list items: a leading [ ] / [x] in the first paragraph.
    let task = null;
    if (parsed.blocks.length > 0 && parsed.blocks[0].t === 'p') {
      const text = parsed.blocks[0].text;
      const tm = /^\[([ xX])\][ \t]+(?=\S)/.exec(text);
      if (tm) {
        task = tm[1] !== ' ';
        parsed.blocks[0].text = text.slice(tm[0].length);
        parsed.blocks[0].taskHead = true;
      }
    }
    items.push({ blocks: parsed.blocks, task, trailing });
    endBlank = trailing > 0;
    if (itemDone) continue;
    // The item ended without a sibling marker on the spot; if one follows
    // after blank lines, let the loop head claim them and carry on.
    {
      let k = j;
      while (k < lines.length && isBlankLine(lines[k])) k++;
      const nm = k < lines.length ? listMarker(lines[k]) : null;
      if (nm && sameListKind(nm, first) && nm.indent <= baseIndent + 3) continue;
    }
    break;
  }
  // The final item's text is trimmed of trailing whitespace before it
  // is lexed; when trimming changes the last gathered line, the item is
  // parsed again from the trimmed lines.
  if (items.length > 0 && lastItemLines && lastItemLines.length > 0) {
    const ll = lastItemLines[lastItemLines.length - 1];
    const tl = ll.replace(/[ \t]+$/, '');
    if (tl !== ll) {
      const copy = lastItemLines.slice();
      copy[copy.length - 1] = tl;
      const parsed = parseBlocks(copy, ctx, lastItemContSet, undefined, true, false);
      if (parsed.looseSep) loose = true;
      let task = null;
      if (parsed.blocks.length > 0 && parsed.blocks[0].t === 'p') {
        const text = parsed.blocks[0].text;
        const tm = /^\[([ xX])\][ \t]+(?=\S)/.exec(text);
        if (tm) {
          task = tm[1] !== ' ';
          parsed.blocks[0].text = text.slice(tm[0].length);
          parsed.blocks[0].taskHead = true;
        }
      }
      items[items.length - 1].blocks = parsed.blocks;
      items[items.length - 1].task = task;
    }
  }
  // A non-final item whose text ends on a folded code line keeps that
  // line's ending when blank lines followed it in the item (the final
  // item's text is trimmed, so it never does).
  for (let q = 0; q + 1 < items.length; q++) {
    const it = items[q];
    if (it.trailing > 0 && it.blocks.length > 0) {
      const last = it.blocks[it.blocks.length - 1];
      if (last.t === 'p' && last.fold) last.text += '\n';
      else if (last.t === 'html' && !last.text.endsWith('\n')) last.text += '\n';
    }
    delete it.trailing;
  }
  if (items.length > 0) delete items[items.length - 1].trailing;
  return [{
    t: 'list', ordered: first.ordered, start: first.number, loose, items,
  }, j, endBlank];
}

// Parse a list of source lines into blocks. Returns the blocks plus whether
// any two sibling blocks were separated by a blank line (used for list
// looseness). Link definitions register into ctx.links as a side effect.
function parseBlocks(lines, ctx, contSet, phantomIdx, inList, top = true, barriers, endNl = false, segStarts, foldSet) {
  const blocks = [];
  let looseSep = false;
  let sawBlank = false;
  let i = 0;
  const n = lines.length;
  const noteBlock = () => {
    if (blocks.length > 0 && sawBlank) looseSep = true;
    sawBlank = false;
  };
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { sawBlank = true; i++; continue; }
    const ind = indentOf(line);
    const rest = ind.cols < 4 ? line.slice(ind.idx) : '';

    // Indented code block.
    if (ind.cols >= 4) {
      noteBlock();
      const buf = [];
      let j = i;
      while (j < n) {
        const l = lines[j];
        if (indentOf(l).cols >= 4) { buf.push(stripCols(l, 4)); j++; continue; }
        if (isBlankLine(l)) { buf.push(''); j++; continue; }
        break;
      }
      while (buf.length > 0 && buf[buf.length - 1] === '') buf.pop();
      blocks.push({ t: 'code', lang: null, text: buf.map((l) => l + '\n').join('') });
      i = j;
      continue;
    }

    // Fast lane: a line whose first character opens no block construct
    // (no fence, heading, HTML, definition, quote, break or list) can
    // only start a paragraph, so the dispatch checks are skipped.
    const c0 = rest[0];
    const plainStart = c0 !== '`' && c0 !== '~' && c0 !== '#' && c0 !== '<' &&
      c0 !== '[' && c0 !== '>' && c0 !== '*' && c0 !== '-' && c0 !== '+' &&
      c0 !== '_' && !(c0 >= '0' && c0 <= '9');

    // Fenced code block.
    const fence = plainStart ? null : FENCE_RE.exec(rest);
    if (fence && !(fence[1][0] === '`' && fence[2].indexOf('`') !== -1)) {
      noteBlock();
      const ch = fence[1][0];
      const len = fence[1].length;
      const info = fence[2].trim();
      const lang = info === '' ? null : resolveEscapes(info.split(/[ \t]+/)[0]);
      const buf = [];
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (j === phantomIdx) break;
        const l = lines[j];
        const li = indentOf(l);
        if (li.cols <= 3) {
          const lr = l.slice(li.idx);
          const close = FENCE_RE.exec(lr);
          if (close && close[1][0] === ch && close[1].length >= len &&
              /^[ \t]*$/.test(close[2])) {
            closed = true;
            break;
          }
        }
        // Backtick fence content is dedented by the fence's indent;
        // tilde fence content is kept verbatim.
        buf.push(ch === '`' ? stripWsChars(l, ind.cols) : l);
        j++;
      }
      // A fence drops one trailing blank content line, closed or not.
      if (buf.length > 0 && buf[buf.length - 1] === '') buf.pop();
      blocks.push({
        t: 'code', lang, text: buf.map((l) => l + '\n').join(''),
      });
      i = closed ? j + 1 : j;
      continue;
    }

    // ATX heading.
    const atx = plainStart ? null : ATX_RE.exec(rest);
    if (atx) {
      noteBlock();
      let content = atx[2] === undefined ? '' : atx[2];
      content = content.replace(/[ \t]+$/, '');
      if (/^#+$/.test(content)) content = '';
      else content = content.replace(/[ \t]+#+$/, '');
      content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      blocks.push({ t: 'h', level: atx[1].length, text: content });
      i++;
      continue;
    }

    // HTML block.
    const hb = plainStart ? 0 : htmlBlockStart(line);
    if (hb !== 0) {
      noteBlock();
      const buf = [line];
      let j = i + 1;
      if (hb === 1) {
        const tagName = /<(pre|script|style|textarea)/i.exec(rest)[1].toLowerCase();
        const closeRe = new RegExp('</' + tagName, 'i');
        while (j < n && j !== phantomIdx && !closeRe.test(lines[j - 1])) { buf.push(lines[j]); j++; }
      } else if (hb >= 2 && hb <= 5) {
        // On the first line the close marker only counts after the
        // opening delimiter (so '<?>' alone does not close a PI block).
        const closeStr = hb === 2 ? '-->' : hb === 3 ? '?>' : hb === 4 ? '>' : ']]>';
        const openLen = hb === 2 ? 4 : hb === 5 ? 9 : 2;
        let closed = buf[0].slice(indentOf(buf[0]).idx + openLen).includes(closeStr);
        while (!closed && j < n && j !== phantomIdx) {
          buf.push(lines[j]);
          if (lines[j].includes(closeStr)) closed = true;
          j++;
        }
      } else {
        while (j < n && !isBlankLine(lines[j])) { buf.push(lines[j]); j++; }
      }
      // Conditions 1-5 run to their close marker or to the end of the
      // text; trailing blank lines are not part of the block either way.
      if (hb >= 1 && hb <= 5) {
        while (buf.length > 0 && isBlankLine(buf[buf.length - 1])) buf.pop();
      }
      let htmlText = buf.join('\n');
      // The block keeps its last line's ending when the source continues
      // right after it: a following non-empty line (conditions 1-5), or
      // the end of the source itself with its final newline.
      const lastIdx = i + buf.length - 1;
      if (hb >= 1 && hb <= 5 && lastIdx + 1 < n && lines[lastIdx + 1] !== '') htmlText += '\n';
      else if (phantomIdx === lastIdx + 1) htmlText += '\n';
      blocks.push({ t: 'html', text: htmlText });
      i = j;
      continue;
    }

    // Link reference definition. A definition counts as a block for the
    // blank-line separation bookkeeping (it can loosen an enclosing list).
    if (rest[0] === '[') {
      const used = tryDefinition(lines, i, ctx.links);
      if (used > 0) { noteBlock(); i += used; continue; }
    }

    // Block quote.
    if (rest[0] === '>') {
      noteBlock();
      const [q, nj] = parseQuote(lines, i, ctx);
      blocks.push(q);
      i = nj;
      continue;
    }

    // Thematic break (before list: "- - -" is a break, not a list).
    if (!plainStart && HR_RE.test(rest)) {
      noteBlock();
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    // List.
    if (!plainStart && listMarker(line)) {
      noteBlock();
      const [lst, nj, endBlank] = parseList(lines, i, ctx, segStarts, barriers);
      blocks.push(lst);
      // Blank lines the list swallowed after its last item still separate
      // it from whatever block comes next.
      if (endBlank) sawBlank = true;
      i = nj;
      continue;
    }

    // Paragraph, with setext-heading and table conversion while gathering.
    noteBlock();
    let foldTrail = false;
    const paraLines = [line];
    // The gathered lines verbatim: a setext heading's text is the raw
    // text (folded lines keep their indentation there), while the
    // paragraph text folds them.
    const paraRaw = [line];
    // Whether any gathered line is table-delimiter-like, which blocks a
    // setext conversion, and whether the last gathered line came from an
    // indented-code fold-in (see the append at the loop's end).
    let paraTableLike = (line.includes('|') && TABLE_LIKE_RE.test(line)) ||
      (htmlLineMaybe(line) && HTML_LINE_RE.test(line));
    let prevCode = false;
    const pushPara = (l, isCode, testLine) => {
      if (prevCode && !isCode) paraLines.push('');
      paraLines.push(l);
      paraRaw.push(testLine === undefined ? l : testLine);
      prevCode = isCode;
      const tl = testLine === undefined ? l : testLine;
      if ((tl.includes('|') && TABLE_LIKE_RE.test(tl)) ||
          (htmlLineMaybe(tl) && HTML_LINE_RE.test(tl))) paraTableLike = true;
    };
    let j = i + 1;
    let converted = null;
    while (j < n) {
      const l = lines[j];
      if (isBlankLine(l)) {
        // A whitespace-only final line (nothing after it, not even a line
        // ending) is paragraph text rather than a separator.
        if (l !== '' && j === n - 1 && j !== phantomIdx && paraLines.length > 0) paraLines.push(l);
        break;
      }
      const li = indentOf(l);
      const lr = li.cols < 4 ? l.slice(li.idx) : null;
      if (contSet && contSet.has(j) && lr !== null &&
          (lr[0] === '=' || lr[0] === '-') && SETEXT_RE.test(lr)) {
        // A scooped-up underline line stays paragraph text. Below the top
        // level it joins like a folded code line, so a plain line after
        // it is separated by an extra blank.
        pushPara(l, !top);
        j++;
        continue;
      }
      if (lr !== null && (lr[0] === '=' || lr[0] === '-') &&
          SETEXT_RE.test(lr) && !paraTableLike &&
          !(barriers && [...barriers].some((b) => b > i && b <= j))) {
        converted = {
          t: 'h', level: lr[0] === '=' ? 1 : 2,
          text: paraRaw.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
        };
        j++;
        break;
      }
      if (lr !== null && DELIM_CHARS_RE.test(l)) {
        const aligns = tableDelimiter(l);
        // A delimiter row that would interrupt a paragraph (a bullet-led
        // row) still forms a table when the header is the paragraph's
        // first line: at a block start the table wins over the list.
        if (aligns !== null && (paraLines.length === 1 || !interruptsParagraph(l, inList)) && !(barriers && barriers.has(j))) {
          const header = splitRow(paraLines[paraLines.length - 1]);
          if (header.length === aligns.length &&
              (lr.indexOf('|') !== -1 || lr.indexOf(':') !== -1)) {
            const rows = [];
            let k = j + 1;
            while (k < n && !(barriers && barriers.has(k)) && !isTableBodyBlank(lines[k]) && !tableLineBlocked(lines[k]) && !interruptsParagraph(lines[k], inList)) {
              const cells = splitRow(lines[k]);
              while (cells.length < header.length) cells.push('');
              rows.push(cells.slice(0, header.length));
              k++;
            }
            const head = paraLines.slice(0, -1);
            converted = { t: 'table', header, aligns, rows, head };
            j = k;
            break;
          }
        }
      }
      if (foldSet && foldSet.has(j)) {
        pushPara(l, true);
        j++;
        continue;
      }
      if (contSet && contSet.has(j)) {
        pushPara(l, !top);
        j++;
        continue;
      }
      // When the gathered paragraph can no longer convert as a whole
      // (a table-like or HTML line is in it), it still ends before a
      // line that heads a setext heading of its own: the heading forms
      // from that line alone.
      if (paraTableLike && j + 1 < n && !TABLE_LIKE_RE.test(l) &&
          !HTML_LINE_RE.test(l)) {
        const ui = indentOf(lines[j + 1]);
        if (ui.cols < 4 && SETEXT_RE.test(lines[j + 1].slice(ui.idx))) break;
      }
      // The paragraph match also ends before a line whose following
      // line is a table delimiter row, when that line opens an HTML
      // block or the delimiter row would itself interrupt the
      // paragraph (a bullet-led row never forms a table).
      if (j + 1 < n && delimLookahead(lines[j + 1]) &&
          ((lr !== null && lr[0] === '<' && htmlBlockStart(l) !== 0) || HTML_LINE_RE.test(l) ||
           (!inList && !barriers && l.includes('|') &&
             splitRow(l).every((cell) => cell.trim() === '')) ||
           (!HR_RE.test(lines[j + 1].trim()) && interruptsParagraph(lines[j + 1], inList)))) break;
      // Below the top level the text token ends before any HTML block
      // start, even a type-7 one that could not interrupt a paragraph.
      if ((!top || (barriers && barriers.has(j))) && lr !== null && lr[0] === '<' &&
          htmlBlockStart(l) !== 0) break;
      if (interruptsParagraph(l, inList)) { if (prevCode) foldTrail = true; break; }
      // Below the top level, a continuation line indented by four or
      // more columns joins the paragraph with four columns removed
      // (it is lexed as indented code and folded into the text); a
      // plain line after such a fold-in is separated by an extra blank,
      // the code token's trailing line ending.
      const isCode = !top && li.cols >= 4;
      pushPara(isCode ? stripCols(l, 4, true) : l, isCode, l);
      j++;
    }
    if (converted && converted.t === 'table') {
      if (converted.head.length > 0) {
        blocks.push({ t: 'p', text: converted.head.join('\n') });
      }
      blocks.push({ t: 'table', header: converted.header, aligns: converted.aligns, rows: converted.rows });
    } else if (converted) {
      blocks.push(converted);
    } else {
      // A paragraph that ends on a folded code line keeps that line's
      // ending when anything follows it in the block text: a following
      // block (the loop stopped at its first, non-blank line), an
      // interrupting line, or the block text's own final newline. A
      // blank line after the fold drops the ending.
      let ptext = paraLines.join('\n');
      if (prevCode && (foldTrail || endNl ||
          (j < n && !isBlankLine(lines[j])))) ptext += '\n';
      blocks.push({ t: 'p', text: ptext, fold: prevCode });
    }
    i = j;
  }
  return { blocks, looseSep };
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

const ANGLE_SCHEME_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/;
const ANGLE_EMAIL_RE = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;
const ENTITY_RE = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(\w+));/;
const LOCAL_PART_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&\'*+/=?^_`{|}~-';

// Scan an HTML tag in inline text (attributes may span lines). Returns the
// end index just past '>', or -1.
function scanInlineTag(s, i) {
  let j = i + 1;
  if (s[j] === '/') j++;
  const name = /^[A-Za-z][A-Za-z0-9-]*/.exec(s.slice(j));
  if (!name) return -1;
  j += name[0].length;
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n';
  for (;;) {
    let k = j;
    while (k < s.length && isWs(s[k])) k++;
    if (k >= s.length) return -1;
    if (s[k] === '>') return k + 1;
    if (s[k] === '/' && s[k + 1] === '>') return s[i + 1] === '/' ? -1 : k + 2;
    if (k === j) return -1;
    if (s[i + 1] === '/') return -1; // closing tags take no attributes
    const attr = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(s.slice(k));
    if (!attr) return -1;
    k += attr[0].length;
    let q = k;
    while (q < s.length && isWs(s[q])) q++;
    if (s[q] === '=') {
      q++;
      while (q < s.length && isWs(s[q])) q++;
      if (s[q] === '"' || s[q] === "'") {
        const close = s.indexOf(s[q], q + 1);
        if (close === -1) return -1;
        q = close + 1;
      } else {
        const val = /^[^ \t\n"'=<>`]+/.exec(s.slice(q));
        if (!val) return -1;
        q += val[0].length;
      }
      j = q;
    } else {
      j = k;
    }
  }
}

// Any raw HTML construct at s[i] === '<' (comment, CDATA, processing
// instruction, declaration, or a tag). Returns the end index or -1.
function scanRawHtml(s, i) {
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    const end = s.indexOf('-->', i + 4);
    return end === -1 ? -1 : end + 3;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    return end === -1 ? -1 : end + 3;
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  if (/^<![A-Za-z]/.test(s.slice(i, i + 3))) {
    const end = s.indexOf('>', i + 2);
    return end === -1 ? -1 : end + 1;
  }
  return scanInlineTag(s, i);
}

// The "(destination title)" tail of an inline link, starting at s[i] === '('.
// Returns {href, title, end} or null.
// Can the source slice text[s..e] serve as an inline link's label? The
// label grammar consumes escapes, nested bracket units (to their first
// unescaped ']'), and code spans closed by the next backtick run of any
// length; a backtick run with no later run to close its span voids the
// label, except a run of two or more sitting directly before the
// closing bracket, which is label text.
// Count the maximal backtick runs in text[a..b].
function countRuns(text, a, b) {
  let cnt = 0;
  let p = a;
  while (p < b) {
    if (text[p] === '`') { cnt++; while (p < b && text[p] === '`') p++; }
    else p++;
  }
  return cnt;
}

function labelOk(text, s, e) {
  let i = s;
  while (i < e) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') {
      let j = i + 1;
      while (j < e && text[j] !== ']') { if (text[j] === '\\') j++; j++; }
      if (j >= e) return false;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let m = 1;
      while (text[i + m] === '`') m++;
      let j = i + m;
      while (j < e && text[j] !== '`') j++;
      if (j >= e) return m >= 2 && i + m === e;
      let r = 1;
      while (text[j + r] === '`') r++;
      i = j + r;
      continue;
    }
    i++;
  }
  return true;
}

function scanLinkTail(s, i) {
  const n = s.length;
  let p = i + 1;
  const skipWs = () => { while (p < n && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++; };
  skipWs();
  if (s[p] === ')') return { href: '', title: null, end: p + 1 };
  let dest = null;
  if (s[p] === '<') {
    // Angle destination: no line endings and no unescaped '<' inside.
    let j = p + 1;
    let raw = '';
    let ok = false;
    while (j < n) {
      const c = s[j];
      if (c === '\\' && j + 1 < n) { raw += c + s[j + 1]; j += 2; continue; }
      if (c === '<' || c === '\n') break;
      if (c === '>') { ok = true; break; }
      raw += c;
      j++;
    }
    if (ok) { dest = { raw, end: j + 1 }; p = j + 1; }
  }
  if (!dest) {
    const d = scanDest(s, p);
    if (!d || d.raw.indexOf('\n') !== -1) return null;
    dest = d;
    p = d.end;
  }
  const afterDest = p;
  skipWs();
  if (s[p] === ')') return { href: resolveEscapes(dest.raw), title: null, end: p + 1 };
  if (p === afterDest) return null; // title needs separating whitespace
  const t = scanTitle(s, p);
  if (!t) return null;
  p = t.end;
  skipWs();
  if (s[p] !== ')') return null;
  return { href: resolveEscapes(dest.raw), title: resolveEscapes(t.raw), end: p + 1 };
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 't') out += nd.raw ? nd.v : escText(nd.v);
    else if (nd.k === 'h') out += nd.v;
    else if (nd.k === 'd') out += nd.ch.repeat(nd.n);
  }
  return out;
}

function stripTags(html) {
  // An image contributes its alt text to the plain-text rendering.
  return html
    .replace(/<img src="[^"]*" alt="([^"]*)"(?: title="[^"]*")?>/g, '$1')
    .replace(/<[^>]*>/g, '');
}

// Resolve emphasis and strikethrough among the delimiter nodes of a node
// list, in place, following the CommonMark matching rules.
// Classify a delimiter run by its neighbouring characters in the source:
// 'open' for a run that can only open (it adds to the balance an opener
// must overcome), 'plain' for a run that closes without ceremony,
// 'closer3' for a both-flanking run whose use is subject to the rule of
// three, and 'none' for a run that plays no part at all.
function delimClass(forCh, prev, next) {
  // Neighbour classes for a candidate run. In the asterisk matcher a
  // tilde counts as a word character; in the underscore and tilde
  // matchers it is ordinary punctuation.
  const cls = (c) => c === '' || isWsCh(c) ? 'S'
    : (c === '~' && forCh === '*') || !isPunctCh(c) ? 'W' : 'P';
  const pc = cls(prev);
  const nc = cls(next);
  if (pc === 'P' && nc === 'S') return 'plain';
  if (pc === 'W' && nc !== 'W') return 'plain';
  if (nc === 'W' && pc !== 'W') return 'open';
  if (pc === 'S' && nc === 'P') return 'open';
  if (pc === 'P' && nc === 'P') return 'closer3';
  if (pc === 'W' && nc === 'W') return forCh === '_' ? 'none' : 'closer3';
  return 'none';
}

// The character the reference lexer reports as preceding a position: the
// last character of the latest text run before it, where a text run
// ending in '_' never updates it, and any non-text token clears it.
function gatePrev(nodes, idx) {
  for (let j = idx - 1; j >= 0; j--) {
    const p = nodes[j];
    if (p.k === 't') {
      if (p.v.endsWith('_')) continue;
      return p.v[p.v.length - 1];
    }
    if (p.k === 'd') {
      if (p.n === 0 || p.ch === '_') continue;
      return p.ch;
    }
    if (p.k === 'h' && p.pc !== undefined) return p.pc;
    return '';
  }
  return '';
}

// May this run be tried as an opener? The reference matcher only attempts
// a run followed by a non-space character; a run followed by punctuation
// (a tilde does not count) is attempted only when the preceding character
// is empty, whitespace or punctuation other than a delimiter. An
// underscore run followed by a word character or a tilde is not attempted
// after an alphanumeric.
function delimGate(nd, nodes, idx, text, atEnd) {
  const next = atEnd ? '' : nd.pos + nd.n < text.length ? text[nd.pos + nd.n] : '';
  if (next === '' || isWsCh(next)) return false;
  const prev = gatePrev(nodes, idx);
  if (nd.ch === '_' && (next === '~' || !isPunctCh(next)) && /[\p{L}\p{N}]/u.test(prev)) return false;
  if (next !== '~' && isPunctCh(next) && prev !== '') {
    const u = (isWsCh(prev) || isPunctCh(prev)) && prev !== '*' && prev !== '_';
    if (!u) return false;
  }
  return true;
}

// The context flag that promotes plain closers to rule-of-three closers:
// set when the opener's run is preceded by a non-space character and
// either followed by punctuation (a tilde does not count), or (for '*')
// preceded by a character that is not punctuation.
function delimR(nd, scan, atStart) {
  if (atStart) return false;
  let s = nd.pos - (nd.orig - nd.n);
  while (s > 0 && scan[s - 1] === nd.ch) s--;
  const prev = s > 0 ? scan[s - 1] : '';
  if (prev === '' || isWsCh(prev)) return false;
  const next = nd.pos + nd.n < scan.length ? scan[nd.pos + nd.n] : '';
  if (next !== '' && next !== '~' && isPunctCh(next)) return true;
  return nd.ch === '*' && !isPunctCh(prev);
}

// The closer scan consumes a leading span of the form __...*...__ (when
// looking for '*' closers) or **..._...** (for '_') whole: the single
// delimiter of the scanned kind inside it is not a candidate. Returns the
// source position the span ends at, or -1 when the scan text does not
// open with such a span.
function skipSpanEnd(text, s, ch) {
  const A = ch === '*' ? '_' : '*';
  let p = s;
  while (p < text.length && text[p] !== '*' && text[p] !== '_') p++;
  if (text[p] !== A || text[p + 1] !== A) return -1;
  p += 2;
  while (p < text.length && text[p] !== '*' && text[p] !== '_') p++;
  if (text[p] !== ch) return -1;
  p++;
  while (p < text.length && text[p] !== '*' && text[p] !== '_') p++;
  if (text[p] === A && text[p + 1] === A) return p;
  return -1;
}

// The emphasis and strikethrough scans run on a masked copy of the
// inline text, the same length as the original: reference-link
// constructs whose label is defined collapse into a bracketed run of
// 'a's (a first label that itself contains a link stays readable, with
// only its reference part masked), escaped punctuation and the inner
// backticks of code spans become '+', and whole inline-link constructs,
// code spans, and HTML tags collapse the same way. Delimiter runs
// inside a masked region do not take part, and the neighbours of a run
// are read from the masked text.
const REFLINK_SEARCH_RE = new RegExp("!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()", "g");
const INLINE_LINK_RE = new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)");
const BLOCKSKIP_RE = new RegExp("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", "g");

// Whether a would-be first label itself contains a link: an inline
// link found by the block-skip scan, or a reference construct whose
// label is defined and whose own first label is link-free.
function linkInText(e, links) {
  if (!e.includes('[')) return false;
  for (const n of e.matchAll(BLOCKSKIP_RE)) {
    if (INLINE_LINK_RE.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(REFLINK_SEARCH_RE)) {
    const s = n[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !links.has(normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// The mask replacement for one reference-link construct: unchanged
// when its defining label is not defined; the whole construct masked
// otherwise, except that a first label containing a link stays
// readable (recursively masked) with only the reference part hidden.
function maskReflink(r, links) {
  const o = r.lastIndexOf('[');
  if (!links.has(normalizeLabel(r.slice(o + 1, -1)))) return r;
  if (o > 1 && r.charAt(0) !== '!') {
    const inner = r.slice(1, o - 1);
    if (linkInText(inner, links)) {
      return '[' + inner.replace(REFLINK_SEARCH_RE, (m) => maskReflink(m, links)) +
        '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

function maskInline(text, links) {
  let t = text;
  if (links && t.includes('[')) {
    t = t.replace(REFLINK_SEARCH_RE, (r) => maskReflink(r, links));
  }
  t = t.replace(
    /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
    (n, s, r) => r ? '+'.repeat(n.length)
      : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  t = t.replace(BLOCKSKIP_RE,
    (n) => '[' + 'a'.repeat(Math.max(0, n.length - 2)) + ']');
  return t;
}

// Scan forward from the opener at nodes[oi] for its closing run, counting
// a balance over the runs in between: runs that can only open raise it,
// closers lower it, and a both-flanking closer may be skipped (its length
// remembered) when the rule of three forbids the pairing.
function scanDelim(nodes, oi, text, scan, oBreakRetry) {
  const O = nodes[oi];
  const y = O.orig;
  let m = O.n;
  let f = 0;
  const R = O.ch === '~' ? false : delimR(O, scan, oi === 0);
  // The scan breaks on a rule-of-three candidate when the character the
  // lexer reports before this run is the delimiter character itself.
  const oBreak = gatePrev(nodes, oi) === O.ch;
  const spanEnd = O.ch === '~' ? -1 : skipSpanEnd(scan, O.pos + O.n, O.ch);
  for (let j = oi + 1; j < nodes.length; j++) {
    const nd = nodes[j];
    if (nd.k !== 'd' || nd.ch !== O.ch || nd.n === 0 || nd.masked) continue;
    if (nd.pos < spanEnd) continue;
    if (O.ch === '~' && nd.n !== O.n) continue;
    const prev = nd.pos === O.pos + O.n ? '' : nd.pos > 0 ? scan[nd.pos - 1] : '';
    const next = j === nodes.length - 1 ? '' : nd.pos + nd.orig < scan.length ? scan[nd.pos + nd.orig] : '';
    const cls = delimClass(O.ch, prev, next);
    if (cls === 'open') { m += nd.n; continue; }
    if (cls === 'none') continue;
    if (O.ch !== '~' && (cls === 'closer3' || R)) {
      if (oBreak && cls === 'closer3') return null;
      if (y % 3 !== 0 && (y + nd.n) % 3 === 0) { f += nd.n; continue; }
    }
    m -= nd.n;
    if (m > 0) continue;
    return { ci: j, bUsed: Math.min(nd.n, nd.n + m + f) };
  }
  return null;
}

// Resolve emphasis and strikethrough in a node list, in place, by trying
// each delimiter run as an opener in order and wrapping what it matches;
// matched content is resolved recursively.
function resolveDelims(nodes, text, scan) {
  let i = 0;
  while (i < nodes.length) {
    const nd = nodes[i];
    if (nd.k !== 'd' || nd.n === 0 || nd.masked || !delimGate(nd, nodes, i, text, i === nodes.length - 1)) { i++; continue; }
    // A run that finds no closer is retried one character shorter, the
    // shed character becoming literal text, until one character remains.
    let hit = null;
    let retry = false;
    for (;;) {
      hit = scanDelim(nodes, i, text, scan, retry);
      // A tilde run is tried only at its full length: when it fails, the
      // text scanner swallows the whole run, so no shorter retry exists.
      if (hit || nd.n <= 1 || nd.ch === '~') break;
      nodes.splice(i, 0, { k: 't', v: nd.ch });
      i++;
      nd.n--;
      nd.pos++;
      retry = true;
    }
    if (!hit) { i++; continue; }
    const closer = nodes[hit.ci];
    let useO;
    let useC;
    let tag;
    if (nd.ch === '~') { useO = nd.n; useC = nd.n; tag = 'del'; }
    else if (Math.min(nd.n, hit.bUsed) % 2 === 1) { useO = 1; useC = 1; tag = 'em'; }
    else { useO = 2; useC = 2; tag = 'strong'; }
    const inner = [];
    if (nd.n - useO > 0) {
      const p2 = nd.pos + useO;
      inner.push({ k: 'd', ch: nd.ch, n: nd.n - useO, orig: nd.n - useO, pos: p2, masked: scan[p2] !== nd.ch });
    }
    for (let j = i + 1; j < hit.ci; j++) inner.push(nodes[j]);
    if (hit.bUsed - useC > 0) {
      inner.push({ k: 'd', ch: nd.ch, n: hit.bUsed - useC, orig: hit.bUsed - useC, pos: closer.pos, masked: closer.masked });
    }
    resolveDelims(inner, text, scan);
    const html = '<' + tag + '>' + renderNodes(inner) + '</' + tag + '>';
    const tail = closer.n - hit.bUsed;
    const replacement = [{ k: 'h', v: html, pc: nd.ch }];
    if (tail > 0) {
      const p3 = closer.pos + hit.bUsed;
      replacement.push({ k: 'd', ch: nd.ch, n: tail, orig: closer.orig, pos: p3, masked: scan[p3] !== nd.ch });
    }
    nodes.splice(i, hit.ci - i + 1, ...replacement);
    i++;
  }
}

// Scan an email domain at text[pos]: a first label of [A-Za-z0-9_-],
// then one or more dot groups whose label ends in an alphanumeric. A
// group whose label run continues past its last alphanumeric (trailing
// '-' or '_') cannot end the domain, and the match retreats to the
// previous group instead. Returns {dom, end} or null.
function scanEmailDomain(text, pos, limit) {
  const isDomCh = (c) => /[A-Za-z0-9_-]/.test(c);
  let i = pos;
  const labelRun = () => {
    let j = i;
    while (j < limit && isDomCh(text[j])) j++;
    const r = text.slice(i, j);
    i = j;
    return r;
  };
  const first = labelRun();
  if (first === '') return null;
  let dom = first;
  let groups = 0;
  let end = i;
  while (i < limit && text[i] === '.') {
    const save = i;
    i++;
    const run = labelRun();
    if (run === '') { i = save; break; }
    let lastAlnum = -1;
    for (let k = run.length - 1; k >= 0; k--) {
      if (/[A-Za-z0-9]/.test(run[k])) { lastAlnum = k; break; }
    }
    if (lastAlnum === -1 || lastAlnum < run.length - 1) { i = save; break; }
    dom += '.' + run;
    groups++;
    end = i;
  }
  if (groups === 0) return null;
  return { dom, end };
}

// Try a GFM bare-URL autolink starting at s[i] (the caller checked the
// prefix and the preceding-character rule). Returns the end index or -1.
function scanBareUrl(s, i) {
  let prefixLen;
  if (s.startsWith('www.', i)) prefixLen = 4;
  else {
    const m = /^(?:https?|ftp):\/\//i.exec(s.slice(i, i + 10));
    if (!m) return -1;
    prefixLen = m[0].length;
  }
  const first = s[i + prefixLen];
  if (first === undefined || !/[A-Za-z0-9_-]/.test(first)) return -1;
  let end = i;
  const n = s.length;
  while (end < n) {
    const c = s[end];
    if (c === ' ' || c === '\t' || c === '\n' || c === '<' || c === '\r') break;
    end++;
  }
  let url = s.slice(i, end);
  // The run is cut back to its longest prefix that can end a URL: chunks
  // of ordinary characters, balanced parenthesised groups, ampersands
  // that do not end an entity, and sentence punctuation that is not at
  // the very end.
  const backpedal = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
  let prev = null;
  while (prev !== url) {
    prev = url;
    const m = backpedal.exec(url);
    url = m ? m[0] : '';
  }
  if (url.length <= prefixLen) return -1;
  return i + url.length;
}

function autolinkBoundary(s, i) {
  if (i === 0) return true;
  const prev = s[i - 1];
  return prev === ' ' || prev === '\t' || prev === '\n' || prev === '(' ||
    prev === '*' || prev === '_' || prev === '~';
}

// The characters that end a plain text run: each opens a construct.
// Autolink and address starts (w h H f F @) count only while autolinks
// are live at the current position, so there are two stop patterns; a
// regex search finds the next stop in one engine pass.
const RUN_STOP_LIVE_RE = /[`\\<&![\]*_~\nwhHfF@]/g;
const RUN_STOP_QUIET_RE = /[`\\<&![\]*_~\n]/g;

// Parse the inline content of one leaf block and return its HTML.
function renderInline(text, ctx, inLink) {
  const nodes = [];
  const brackets = [];
  let pendingSpan = null;
  let spanShadow = null;
  let hasDelim = false;
  let buf = '';
  let i = 0;
  const n = text.length;
  // The delimiter scan string is the text with code spans, escapes and
  // reference-link text hidden. When none of those can occur (no
  // backtick, no backslash, and no reference labels in play) the mask
  // would be the identity, so the text itself serves.
  const scan = (text.includes('*') || text.includes('_') || text.includes('~'))
    ? (text.includes('`') || text.includes('\\') ||
       (text.includes('[') && (ctx.links.size > 0 || text.includes('(')))
        ? maskInline(text, ctx.links) : text)
    : text;
  const flush = () => {
    if (buf !== '') { nodes.push({ k: 't', v: buf, raw: !!ctx.rawMode }); buf = ''; }
  };
  while (i < n) {
    const c = text[i];
    // Plain run fast path: consume a whole stretch of ordinary text at
    // once; the next construct-opening character is found by the regex
    // engine rather than a character-at-a-time loop.
    if (!spanShadow) {
      const stopRe = (!inLink && !ctx.aOpen) ? RUN_STOP_LIVE_RE : RUN_STOP_QUIET_RE;
      stopRe.lastIndex = i;
      const m = stopRe.exec(text);
      const j = m ? m.index : n;
      if (j > i) {
        buf += text.slice(i, j);
        i = j;
        continue;
      }
    }
    // Span shadow: the bracket a remembered span belongs to has failed,
    // so everything up to the partner run is code content, verbatim.
    if (spanShadow) {
      if (i < spanShadow.cs) { buf += c; i++; continue; }
      const ps = spanShadow;
      spanShadow = null;
      if (i === ps.cs && nodes[ps.nodeIdx] === ps.node) {
        buf = '';
        nodes.length = ps.nodeIdx;
        let content = text.slice(ps.runEnd, ps.cs).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' &&
            content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        nodes.push({ k: 'h', v: '<code>' + escCode(content) + '</code>' });
        i = ps.cs + ps.len;
        continue;
      }
    }
    if (c === '\\') {
      const next = text[i + 1];
      if (next === '\n') {
        flush();
        nodes.push({ k: 'h', v: '<br>' });
        i += 2;
        // Leading whitespace of the next line is not rendered after a
        // hard break.
        while (text[i] === ' ' || text[i] === '\t') i++;
      } else if (next !== undefined && isAsciiPunct(next)) {
        buf += next;
        i += 2;
      } else {
        buf += c;
        i++;
      }
      continue;
    }
    if (c === '`') {
      let m = 1;
      while (text[i + m] === '`') m++;
      // A remembered cross-bracket span: a run that closed a label span
      // pairs with this run when the bracket has since failed, the run's
      // text node is still in place, and nothing but text, delimiters,
      // and hard breaks was emitted in between.
      if (pendingSpan && i === pendingSpan.cs && m === pendingSpan.len) {
        const ps = pendingSpan;
        pendingSpan = null;
        if (nodes[ps.nodeIdx] === ps.node &&
            !brackets.includes(ps.bracket) &&
            brackets.every((b) => ps.stack.has(b)) &&
            !nodes.slice(ps.nodeIdx + 1).some((nd) => nd.k === 'h' && nd.v !== '<br>')) {
          buf = '';
          nodes.length = ps.nodeIdx;
          let content = text.slice(ps.runEnd, ps.cs).replace(/\n/g, ' ');
          if (content.length >= 2 && content[0] === ' ' &&
              content[content.length - 1] === ' ' && content.trim() !== '') {
            content = content.slice(1, -1);
          }
          nodes.push({ k: 'h', v: '<code>' + escCode(content) + '</code>' });
          i = ps.cs + m;
          continue;
        }
      }
      const B = brackets.length > 0 ? brackets[brackets.length - 1] : null;
      if (B) {
        // Inside a bracket, the label scan pairs backtick runs into
        // spans: a run opens a span that the next run of any length
        // closes, and a ']' inside a span does not close the bracket.
        // The bracket records whether a label span is currently open;
        // labelOk re-checks the whole label when ']' is reached.
        if (m >= 2 && text[i + m] === ']') {
          // Two or more backticks directly before ']' are label text.
          B.spanOpen = false;
          buf += '`'.repeat(m);
          i += m;
          continue;
        }
        if (B.spanOpen) {
          // This run closes the open label span, so it is not a span
          // opener for the bracket. It may still pair with a later run
          // of its own length as a code span, but only when that span
          // does not swallow the bracket's closing ']'.
          let cs = -1;
          let q = i + m;
          while (q < n) {
            if (text[q] === '`') {
              let r = 1;
              while (text[q + r] === '`') r++;
              if (r === m) { cs = q; break; }
              q += r;
            } else q++;
          }
          let rb = i + m;
          while (rb < n && text[rb] !== ']') rb++;
          if (cs === -1 || cs + m > rb) {
            // With a partner run beyond the bracket's ']', the span may
            // still form if the bracket fails: remember it (the run
            // stands as its own text node meanwhile).
            if (cs !== -1 && !pendingSpan) {
              flush();
              const runNode = { k: 't', v: '`'.repeat(m) };
              nodes.push(runNode);
              pendingSpan = {
                len: m, runEnd: i + m, cs,
                nodeIdx: nodes.length - 1, node: runNode,
                bracket: B, stack: new Set(brackets),
              };
            } else {
              buf += '`'.repeat(m);
            }
            B.spanOpen = false;
            i += m;
            continue;
          }
          flush();
          let content = text.slice(i + m, cs).replace(/\n/g, ' ');
          if (content.length >= 2 && content[0] === ' ' &&
              content[content.length - 1] === ' ' && content.trim() !== '') {
            content = content.slice(1, -1);
          }
          nodes.push({ k: 'h', v: '<code>' + escCode(content) + '</code>' });
          B.spanOpen = countRuns(text, i, cs + m) % 2 === 0;
          i = cs + m;
          continue;
        }
        // This run opens a label span.
        let j = i + m;
        while (j < n && text[j] !== '`') j++;
        if (j >= n) {
          // No later run at all: the run is literal text, and the span
          // it opens never closes (labelOk decides at the ']').
          B.spanOpen = true;
          buf += '`'.repeat(m);
          i += m;
          continue;
        }
        let r2 = 1;
        while (text[j + r2] === '`') r2++;
        if (r2 !== m) {
          // The label span ends at that run, but an equal-length span
          // may still close later. When it does and no ']' falls
          // between the two span ends, the code span is what stands if
          // the bracket fails (and the content is re-rendered if it
          // forms), so fall through to the real span search then.
          let cs = -1;
          let q = j + r2;
          while (q < n) {
            if (text[q] === '`') {
              let r = 1;
              while (text[q + r] === '`') r++;
              if (r === m) { cs = q; break; }
              q += r;
            } else q++;
          }
          let contested = false;
          if (cs !== -1) {
            for (let p = j + r2; p < cs + m; p++) {
              if (text[p] === ']') { contested = true; break; }
            }
          }
          // With no equal-length span at all, the label-span consume is
          // only needed when it shelters a ']' inside it; otherwise the
          // run stands alone and later runs pair up on their own.
          let bracketInSpan = false;
          if (cs === -1) {
            for (let p = i + m; p < j; p++) {
              if (text[p] === ']') { bracketInSpan = true; break; }
            }
          }
          if (contested || bracketInSpan) {
            buf += text.slice(i, j + r2);
            i = j + r2;
            continue;
          }
        }
      }
      // Find a closing run of exactly the same length.
      let j = i + m;
      let closeStart = -1;
      while (j < n) {
        if (text[j] === '`') {
          let r = 1;
          while (text[j + r] === '`') r++;
          if (r === m) { closeStart = j; break; }
          j += r;
        } else j++;
      }
      if (closeStart === -1) {
        if (B) B.spanOpen = true;
        buf += '`'.repeat(m);
        i += m;
      } else {
        flush();
        let content = text.slice(i + m, closeStart).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' &&
            content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        nodes.push({ k: 'h', v: '<code>' + escCode(content) + '</code>' });
        if (B) B.spanOpen = countRuns(text, i, closeStart + m) % 2 === 1;
        i = closeStart + m;
      }
      continue;
    }
    if (c === '<') {
      const rest = text.slice(i, i + 1200);
      let m = ANGLE_SCHEME_RE.exec(rest);
      if (m) {
        flush();
        nodes.push({
          k: 'h',
          v: '<a href="' + cleanHref(m[1]) + '">' + escText(m[1]) + '</a>',
        });
        i += m[0].length;
        continue;
      }
      m = ANGLE_EMAIL_RE.exec(rest);
      if (m) {
        flush();
        nodes.push({
          k: 'h',
          v: '<a href="' + cleanHref('mailto:' + m[1]) + '">' + escText(m[1]) + '</a>',
        });
        i += m[0].length;
        continue;
      }
      const rawEnd = scanRawHtml(text, i);
      if (rawEnd !== -1) {
        flush();
        const raw = text.slice(i, rawEnd);
        nodes.push({ k: 'h', v: raw });
        // A raw <a ...> tag (the name followed by a space) switches the
        // lexer into its in-link state, suppressing bare autolinks from
        // here to the matching </a> anywhere later in the document.
        if (!ctx.aOpen && /^<a /i.test(raw)) ctx.aOpen = true;
        else if (ctx.aOpen && /^<\/a>/i.test(raw)) ctx.aOpen = false;
        // Inside a pre, code, kbd or script element, text is rendered
        // unescaped until the matching close tag: a start tag of one of
        // these names (not self-closing) turns the state on, and a close
        // tag of any of them turns it off again.
        const tagM = /^<(\/?)(pre|code|kbd|script)(?=[ >])/i.exec(raw);
        if (tagM) {
          if (tagM[1] === '/') ctx.rawMode = false;
          else if (!/\/>$/.test(raw)) ctx.rawMode = true;
        }
        i = rawEnd;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '&') {
      const m = ENTITY_RE.exec(text.slice(i, i + 34));
      if (m) {
        if (m[3] !== undefined) {
          // A named reference is passed through untouched.
          flush();
          nodes.push({ k: 'h', v: '&' + m[3] + ';' });
        } else {
          const cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
          // Zero, surrogates and values past the Unicode range decode
          // to the replacement character.
          buf += (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))
            ? '�' : String.fromCodePoint(cp);
        }
        i += m[0].length;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      flush();
      nodes.push({ k: 't', v: '![' });
      brackets.push({ idx: nodes.length - 1, img: true, active: true, textStart: i + 2, spanOpen: false });
      i += 2;
      continue;
    }
    if (c === '[') {
      flush();
      nodes.push({ k: 't', v: '[' });
      brackets.push({ idx: nodes.length - 1, img: false, active: true, textStart: i + 1, spanOpen: false });
      i++;
      continue;
    }
    if (c === ']') {
      flush();
      // The closer pairs with the nearest unmatched opener, active or not:
      // a deactivated opener blocks the match and is consumed by it.
      if (brackets.length === 0) { buf += c; i++; continue; }
      const bi = brackets.length - 1;
      const opener = brackets[bi];
      // When the bracket fails, a bare autolink that was capped at this
      // ']' expands to its full length and swallows the ']' itself.
      const expandCapped = () => {
        const last = nodes[nodes.length - 1];
        if (last && last.capAt === i) {
          last.v = last.capFull;
          i = last.capEnd;
          return true;
        }
        return false;
      };
      if (!opener.active) {
        brackets.pop();
        if (expandCapped()) continue;
        buf += c;
        i++;
        continue;
      }
      if (inLink && !opener.img) {
        // Links do not form inside link text.
        brackets.splice(bi, 1);
        if (expandCapped()) continue;
        buf += c;
        i++;
        continue;
      }
      let info = null;
      let endPos = i + 1;
      if (text[i + 1] === '(') {
        const tail = scanLinkTail(text, i + 1);
        if (tail && labelOk(text, opener.textStart, i)) { info = tail; endPos = tail.end; }
      }
      let labelSeen = false;
      if (!info && text[i + 1] === '[') {
        const lab = scanLabel(text, i + 1);
        if (lab && labelOk(text, opener.textStart, i)) {
          labelSeen = true;
          const key = normalizeLabel(lab.raw === '' ? text.slice(opener.textStart, i) : lab.raw);
          const def = ctx.links.get(key);
          if (def) { info = { href: def.href, title: def.title }; endPos = lab.end; }
        }
      }
      if (!info && !labelSeen) {
        // Shortcut reference: only when no bracketed label followed, since a
        // present-but-undefined label voids the whole construct.
        const key = normalizeLabel(text.slice(opener.textStart, i));
        const def = ctx.links.get(key);
        if (def) { info = { href: def.href, title: def.title }; endPos = i + 1; }
      }
      if (!info) {
        // A remembered span whose bracket just failed shadows the text
        // up to its partner run (it all becomes code content).
        if (pendingSpan && pendingSpan.bracket === opener &&
            nodes[pendingSpan.nodeIdx] === pendingSpan.node &&
            !nodes.slice(pendingSpan.nodeIdx + 1).some((nd) => nd.k === 'h' && nd.v !== '<br>')) {
          spanShadow = pendingSpan;
          pendingSpan = null;
        }
        brackets.splice(bi, 1);
        if (expandCapped()) continue;
        buf += c;
        i++;
        continue;
      }
      // The bracket content is rendered from its source text: link text
      // with links and bare autolinks disabled, image alt text with them
      // enabled (its rendering is then reduced to plain text).
      const innerText = text.slice(opener.textStart, i);
      let html;
      const titleAttr = info.title !== null && info.title !== undefined
        ? ' title="' + escAttr(info.title) + '"' : '';
      // The bracket content is tokenized under the in-link state, which is
      // restored afterwards: tag effects inside it do not leak out.
      const savedAOpen = ctx.aOpen;
      if (opener.img) {
        html = '<img src="' + cleanHref(info.href) + '" alt="' +
          stripTags(renderInline(innerText, ctx, false)) + '"' + titleAttr + '>';
      } else {
        html = '<a href="' + cleanHref(info.href) + '"' + titleAttr + '>' +
          renderInline(innerText, ctx, true) + '</a>';
      }
      ctx.aOpen = savedAOpen;
      nodes.length = opener.idx;
      nodes.push({ k: 'h', v: html });
      for (let k = brackets.length - 1; k >= 0; k--) {
        if (brackets[k].idx >= opener.idx) brackets.splice(k, 1);
      }
      if (!opener.img) {
        for (const b of brackets) if (!b.img) b.active = false;
      }
      i = endPos;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let m = 1;
      while (text[i + m] === c) m++;
      if (c === '~' && m > 2) {
        buf += '~'.repeat(m);
        i += m;
        continue;
      }
      flush();
      hasDelim = true;
      nodes.push({ k: 'd', ch: c, n: m, orig: m, pos: i, masked: scan[i] !== c });
      i += m;
      continue;
    }
    if (c === '\n') {
      // A hard break when the text run ends in two or more spaces.
      let spaces = 0;
      while (buf[buf.length - 1 - spaces] === ' ') spaces++;
      if (spaces >= 2) {
        buf = buf.slice(0, buf.length - spaces);
        flush();
        nodes.push({ k: 'h', v: '<br>' });
        i++;
        while (text[i] === ' ' || text[i] === '\t') i++;
      } else {
        buf += c;
        i++;
      }
      continue;
    }
    if (!inLink && !ctx.aOpen && (c === 'w' || c === 'h' || c === 'H' || c === 'f' || c === 'F')) {
      // A scheme autolink may start after any character; the www. form
      // needs a word boundary before it.
      if (c !== 'w' || autolinkBoundary(text, i)) {
        let end = scanBareUrl(text, i);
        let capFull = null;
        if (end !== -1 && brackets.length > 0) {
          // A pending bracket's ']' must survive for the bracket matcher;
          // the run stops before the first one. If the bracket then fails,
          // the run is expanded to its full length (the ']' was part of
          // the URL all along).
          const close = text.indexOf(']', i);
          if (close !== -1 && close < end) {
            const fullUrl = text.slice(i, end);
            const fullHref = fullUrl.startsWith('www.') ? 'http://' + fullUrl : fullUrl;
            capFull = {
              v: '<a href="' + cleanHref(fullHref) + '">' + escText(fullUrl) + '</a>',
              at: close,
              end,
            };
            end = close;
          }
          if (end <= i) end = -1;
        }
        if (end !== -1) {
          // A delimiter run inside the URL that could close a pending
          // emphasis opener ends the URL before the run: the content
          // the opener encloses is lexed as if the string ended there,
          // so the run stays available to the delimiter matcher.
          for (const ch of ['_', '*', '~']) {
            let openerOk = null;
            let cappedUrl = false;
            for (let p = i; p < end && !cappedUrl; p++) {
              if (text[p] !== ch) continue;
              let q = p;
              while (q < end && text[q] === ch) q++;
              if (openerOk === null) {
                openerOk = nodes.some((nd, ni) => nd.k === 'd' && nd.ch === ch &&
                  nd.n > 0 && delimGate(nd, nodes, ni, text, false));
              }
              if (openerOk) {
                const cls = delimClass(ch, p > 0 ? text[p - 1] : '',
                  q < text.length ? text[q] : '');
                if (cls === 'plain' || cls === 'closer3') {
                  const pre = scanBareUrl(text.slice(0, p), i);
                  if (pre !== -1) { end = pre; cappedUrl = true; }
                }
              }
              p = q - 1;
            }
            if (cappedUrl) break;
          }
        }
        if (end !== -1) {
          flush();
          const url = text.slice(i, end);
          const href = url.startsWith('www.') ? 'http://' + url : url;
          const node = {
            k: 'h',
            v: '<a href="' + cleanHref(href) + '">' + escText(url) + '</a>',
          };
          if (capFull) { node.capFull = capFull.v; node.capAt = capFull.at; node.capEnd = capFull.end; }
          nodes.push(node);
          i = end;
          continue;
        }
      }
      buf += c;
      i++;
      continue;
    }
    if (!inLink && !ctx.aOpen && c === '@') {
      // GFM email autolink. The local part is scanned in the source text,
      // so it can span delimiter nodes (an underscore inside the address)
      // but never an escape sequence or another construct.
      let start = i;
      while (start > 0 && LOCAL_PART_CHARS.indexOf(text[start - 1]) !== -1) start--;
      let local = text.slice(start, i);
      if (local !== '' && start > 0 && text[start - 1] === '\\') {
        // A first character escaped by an odd run of backslashes is not
        // part of the address.
        let bs = 0;
        let k = start - 1;
        while (k >= 0 && text[k] === '\\') { bs++; k--; }
        if (bs % 2 === 1) { start++; local = local.slice(1); }
      }
      let prefix = '';
      if (local !== '') {
        for (const p of ['mailto:', 'xmpp:']) {
          if (start >= p.length && text.slice(start - p.length, start) === p) {
            const before = start - p.length;
            if (before === 0 || LOCAL_PART_CHARS.indexOf(text[before - 1]) === -1) prefix = p;
          }
        }
      }
      // The domain: a first label, then dot groups whose labels end in an
      // alphanumeric. A group whose label run trails off in '-' or '_'
      // is dropped whole (the match retreats to the previous group). A
      // trailing run of underscores that will close an earlier underscore
      // opener is not part of the address at all: the content string
      // ends before it.
      let domLimit = text.length;
      let capped = false;
      let trailLen = 0;
      {
        let spanEnd = i + 1;
        while (spanEnd < text.length && /[A-Za-z0-9_.-]/.test(text[spanEnd])) spanEnd++;
        // A maximal underscore run inside the domain span can close an
        // earlier underscore opener instead of belonging to the address:
        // when the text before the run is already a complete domain and
        // the run could act as a closer for a pending opener, the
        // address ends at the run (the content the opener encloses is
        // lexed as if the string ended there).
        let openerOk = null;
        for (let p = i + 1; p < spanEnd; p++) {
          if (text[p] !== '_') continue;
          let q = p;
          while (q < spanEnd && text[q] === '_') q++;
          const dom = scanEmailDomain(text, i + 1, p);
          if (dom && dom.end === p) {
            if (openerOk === null) {
              openerOk = nodes.some((nd, ni) => nd.k === 'd' && nd.ch === '_' &&
                nd.n > 0 && delimGate(nd, nodes, ni, text, false));
            }
            const cls = delimClass('_', text[p - 1], q < text.length ? text[q] : '');
            if (openerOk && (cls === 'plain' || cls === 'closer3')) {
              domLimit = p;
              capped = true;
              trailLen = q - p;
              break;
            }
          }
          p = q - 1;
        }
      }
      // When the domain was capped by a trailing underscore run, a
      // matching leading underscore run is emphasis, not address: the
      // underscores stay as delimiter nodes for the resolver.
      if (capped && prefix === '' && local.startsWith('_')) {
        let lead = 0;
        while (lead < local.length && local[lead] === '_') lead++;
        const strip = Math.min(lead, trailLen);
        if (strip > 0) local = local.slice(strip);
      }
      const dom = scanEmailDomain(text, i + 1, domLimit);
      let domEnd = 0;
      let resource = '';
      let ok = false;
      if (local !== '' && dom) {
        domEnd = dom.end;
        const after = capped && domEnd >= domLimit ? undefined : text[domEnd];
        if (prefix === 'xmpp:' && after === '/') {
          const rm = /^\/[^ \t\n\r</]+/.exec(text.slice(domEnd));
          if (rm) { resource = rm[0]; domEnd += rm[0].length; ok = true; }
        }
        if (!ok && (after === undefined || !/[A-Za-z0-9_-]/.test(after))) ok = true;
      }
      if (ok) {
        // Reclaim the address characters from the pending output: text
        // nodes shrink, underscore delimiter runs inside the address are
        // consumed whole, anything else aborts the autolink.
        flush();
        let need = prefix.length + local.length;
        let reclaimed = true;
        while (need > 0) {
          const nd = nodes[nodes.length - 1];
          if (!nd) { reclaimed = false; break; }
          if (nd.k === 't') {
            if (nd.v.length <= need) { need -= nd.v.length; nodes.pop(); }
            else { nd.v = nd.v.slice(0, nd.v.length - need); need = 0; }
          } else if (nd.k === 'd' && nd.orig <= need) {
            need -= nd.orig;
            nodes.pop();
          } else { reclaimed = false; break; }
        }
        if (reclaimed) {
          const addr = local + '@' + dom.dom;
          const href = prefix === 'xmpp:' ? 'xmpp:' + addr + resource : 'mailto:' + addr;
          nodes.push({
            k: 'h',
            v: '<a href="' + cleanHref(href) + '">' +
              escText(prefix + addr + resource) + '</a>',
          });
          i = domEnd;
          continue;
        }
      }
      buf += c;
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  if (hasDelim) resolveDelims(nodes, text, scan);
  return renderNodes(nodes);
}

// ---------------------------------------------------------------------------
// Rendering the block tree
// ---------------------------------------------------------------------------

function checkboxHtml(checked) {
  return checked
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">';
}

function renderBlocks(blocks, ctx, tight) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, ctx, tight, false);
  return out;
}

// A block whose text holds no inline construct at all renders as its
// escaped text: no escapes, code spans, brackets, emphasis marks, tags,
// entities or addresses, no bare-autolink forms (a scheme's "://" or a
// "www." start), and no hard-break space runs before a newline.
const PLAIN_BLOCK_RE = /[`\\[\]*_~<&!@]| {2,}\n|:\/\/|www\./;

// Inline rendering for one block: the raw-text state set by pre, code,
// kbd and script tags starts fresh for every block, though it is shared
// with (and leaks out of) nested link text within the block.
function blockInline(text, ctx) {
  ctx.rawMode = false;
  if (!PLAIN_BLOCK_RE.test(text)) return escText(text);
  return renderInline(text, ctx, false);
}

function renderBlock(b, ctx, tight, taskPrefix) {
  switch (b.t) {
    case 'p': {
      const inner = blockInline(b.text, ctx);
      const pre = taskPrefix ? checkboxHtml(taskPrefix === 'checked') + ' ' : '';
      if (tight) return pre + inner;
      return '<p>' + pre + inner + '</p>\n';
    }
    case 'h':
      return '<h' + b.level + '>' + blockInline(b.text, ctx) + '</h' + b.level + '>\n';
    case 'code': {
      const cls = b.lang !== null && b.lang !== undefined
        ? ' class="language-' + escAttr(b.lang) + '"' : '';
      return '<pre><code' + cls + '>' + escCode(b.text) + '</code></pre>\n';
    }
    case 'html':
      return b.text;
    case 'hr':
      return '<hr>\n';
    case 'quote':
      return '<blockquote>\n' + renderBlocks(b.children, ctx, false) + '</blockquote>\n';
    case 'list': {
      let out;
      if (b.ordered) {
        out = b.start !== 1 ? '<ol start="' + b.start + '">\n' : '<ol>\n';
      } else {
        out = '<ul>\n';
      }
      for (const item of b.items) {
        out += '<li>';
        for (let k = 0; k < item.blocks.length; k++) {
          const blk = item.blocks[k];
          let chunk;
          if (k === 0 && item.task !== null && blk.t === 'p') {
            chunk = renderBlock(blk, ctx, !b.loose, item.task ? 'checked' : 'unchecked');
          } else {
            chunk = renderBlock(blk, ctx, !b.loose, false);
          }
          out += chunk;
          // In a tight item a paragraph ending on a folded code line
          // keeps the code line's ending before the next block (the
          // merged text token's raw ends with a newline); a loose
          // item's paragraph token has no such ending.
          if (!b.loose && blk.t === 'p' && blk.fold &&
              k + 1 < item.blocks.length && !chunk.endsWith('\n')) {
            out += '\n';
          }
        }
        out += '</li>\n';
      }
      out += b.ordered ? '</ol>\n' : '</ul>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < b.header.length; k++) {
        const a = b.aligns[k];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' +
          blockInline(b.header[k], ctx) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length > 0) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let k = 0; k < row.length; k++) {
            const a = b.aligns[k];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' +
              blockInline(row[k], ctx) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody></table>\n';
      } else {
        out += '</table>\n';
      }
      return out;
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const ctx = { links: new Map(), aOpen: false, rawMode: false };
  const phantomIdx = src.endsWith('\n') ? lines.length - 1 : -1;
  const { blocks } = parseBlocks(lines, ctx, undefined, phantomIdx);
  return renderBlocks(blocks, ctx, false);
}
