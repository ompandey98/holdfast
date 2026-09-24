'use strict';

// A surgical JSONC editor.
//
// Kiro's and VS Code's settings.json are JSONC: comments and trailing commas
// are legal, and users keep both. Round-tripping such a file through
// JSON.parse/JSON.stringify silently deletes every comment and reformats the
// whole document — unacceptable when we are editing someone's editor config.
//
// So we never parse-and-rewrite. We scan the text, locate the exact byte span
// of one key's value, and splice. Everything we do not touch stays byte-for-byte
// identical, and every edit reports an exact inverse (`undo`) so `disable` can
// restore the original bytes rather than an approximation of them.

// --- scanning --------------------------------------------------------------

// Advance past whitespace and comments starting at i.
function skipTrivia(text, i) {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    return i;
  }
}

// End index (exclusive) of the string literal starting at the quote at i.
function endOfString(text, i) {
  i++; // opening quote
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '"') return i + 1;
    i++;
  }
  return i;
}

// End index (exclusive) of the value starting at i (object, array, string,
// number, literal). Comment- and string-aware.
function endOfValue(text, i) {
  const c = text[i];
  if (c === '"') return endOfString(text, i);
  if (c === '{' || c === '[') {
    const open = c;
    const close = c === '{' ? '}' : ']';
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') { i = endOfString(text, i); continue; }
      if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) { i = skipTrivia(text, i); continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  // Primitive: run to the next comma, closing bracket, or comment.
  while (i < text.length && !/[,}\]]/.test(text[i])) {
    if (text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) break;
    i++;
  }
  // Trim trailing whitespace back off the value.
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  return i;
}

// Index of the object-opening brace of the document root.
function rootObjectStart(text) {
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM
  i = skipTrivia(text, i);
  return text[i] === '{' ? i : -1;
}

// Every member of the object whose '{' is at objStart, in source order.
function members(text, objStart) {
  const out = [];
  let i = skipTrivia(text, objStart + 1);
  while (i < text.length && text[i] !== '}') {
    if (text[i] !== '"') { i++; continue; } // tolerate anything unexpected
    const keyStart = i;
    const keyEnd = endOfString(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
    let j = skipTrivia(text, keyEnd);
    if (text[j] !== ':') { i = keyEnd; continue; }
    const valueStart = skipTrivia(text, j + 1);
    const valueEnd = endOfValue(text, valueStart);
    out.push({ key, keyStart, keyEnd, valueStart, valueEnd });
    i = skipTrivia(text, valueEnd);
    if (text[i] === ',') i = skipTrivia(text, i + 1);
  }
  return { list: out, objEnd: i };
}

function findMember(text, objStart, key) {
  const { list } = members(text, objStart);
  // Last occurrence wins, matching how JSON parsers resolve duplicate keys.
  for (let k = list.length - 1; k >= 0; k--) if (list[k].key === key) return list[k];
  return null;
}

// Indentation of the line the given index sits on, plus the file's apparent
// one-level indent unit.
function indentAt(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(lineStart, index));
  return m ? m[0] : '';
}

function indentUnit(text, objStart) {
  const { list } = members(text, objStart);
  if (list.length) {
    const ind = indentAt(text, list[0].keyStart);
    const outer = indentAt(text, objStart);
    if (ind.length > outer.length) return ind.slice(outer.length);
  }
  return text.includes('\t') && !/\n {2,}/.test(text) ? '\t' : '  ';
}

// --- editing ---------------------------------------------------------------

// Set one key of the object at objStart to raw `valueText`.
// Returns { text, undo } where undo = { at, length, text } describes the splice
// that restores the input byte-for-byte.
function setKeyIn(text, objStart, key, valueText) {
  const existing = findMember(text, objStart, key);
  if (existing) {
    const prior = text.slice(existing.valueStart, existing.valueEnd);
    const next = text.slice(0, existing.valueStart) + valueText + text.slice(existing.valueEnd);
    return {
      text: next,
      undo: { at: existing.valueStart, length: valueText.length, text: prior },
      priorRaw: prior,
    };
  }

  const { list, objEnd } = members(text, objStart);
  const outer = indentAt(text, objStart);
  const unit = indentUnit(text, objStart);
  const inner = list.length ? indentAt(text, list[0].keyStart) : outer + unit;

  // Insert as the first member: the bytes we add are contiguous and adjacent to
  // '{', so removing exactly them later restores the original file.
  const at = objStart + 1;
  const inserted = list.length
    ? `\n${inner}${JSON.stringify(key)}: ${valueText},`
    : `\n${inner}${JSON.stringify(key)}: ${valueText}\n${outer}`;
  const next = text.slice(0, at) + inserted + text.slice(at);
  void objEnd;
  return { text: next, undo: { at, length: inserted.length, text: '' }, priorRaw: null };
}

// Remove one key of the object at objStart, taking exactly one adjacent comma
// with it so the result stays valid.
function removeKeyIn(text, objStart, key) {
  const m = findMember(text, objStart, key);
  if (!m) return { text, removed: false };

  let start = m.keyStart;
  let end = m.valueEnd;
  const after = skipTrivia(text, end);
  if (text[after] === ',') {
    end = after + 1; // this member's own trailing comma
  } else {
    // Last member: take the comma that precedes it instead.
    let b = start - 1;
    while (b >= 0 && /\s/.test(text[b])) b--;
    if (text[b] === ',') start = b;
  }
  // If the member had a line to itself, take exactly that line — its leading
  // indentation and its terminating newline — and nothing else.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const leading = text.slice(lineStart, start);
  let e = end;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  if (/^[ \t]*$/.test(leading) && text[e] === '\n') {
    start = lineStart;
    e += 1;
  }

  return { text: text.slice(0, start) + text.slice(e), removed: true };
}

// --- path helpers (nested objects, e.g. ["env","ANTHROPIC_BASE_URL"]) -------

function resolveObject(text, pathParts) {
  let objStart = rootObjectStart(text);
  if (objStart === -1) return null;
  for (const part of pathParts) {
    const m = findMember(text, objStart, part);
    if (!m || text[m.valueStart] !== '{') return null;
    objStart = m.valueStart;
  }
  return objStart;
}

// Set text at a nested path. Creates missing intermediate objects.
function setPath(text, pathParts, valueText) {
  if (rootObjectStart(text) === -1) throw new Error('not a JSON object document');
  const parents = pathParts.slice(0, -1);
  const key = pathParts[pathParts.length - 1];

  let objStart = resolveObject(text, parents);
  if (objStart === null) {
    // Create the missing parent chain, innermost value included, in one splice.
    for (let depth = parents.length - 1; depth >= 0; depth--) {
      const head = parents.slice(0, depth);
      const at = resolveObject(text, head);
      if (at === null) continue;
      const unit = indentUnit(text, at);
      const outer = indentAt(text, at) || '';
      let body = `${JSON.stringify(key)}: ${valueText}`;
      for (let d = parents.length - 1; d >= depth; d--) {
        const pad = outer + unit.repeat(d - depth + 2);
        body = `{\n${pad}${body}\n${outer + unit.repeat(d - depth + 1)}}`;
      }
      const res = setKeyIn(text, at, parents[depth], body);
      return { text: res.text, undo: res.undo, priorRaw: res.priorRaw };
    }
    throw new Error(`cannot locate insertion point for ${pathParts.join('.')}`);
  }
  return setKeyIn(text, objStart, key, valueText);
}

function getPath(text, pathParts) {
  const parents = pathParts.slice(0, -1);
  const objStart = resolveObject(text, parents);
  if (objStart === null) return null;
  const m = findMember(text, objStart, pathParts[pathParts.length - 1]);
  return m ? text.slice(m.valueStart, m.valueEnd) : null;
}

function removePath(text, pathParts) {
  const objStart = resolveObject(text, pathParts.slice(0, -1));
  if (objStart === null) return { text, removed: false };
  return removeKeyIn(text, objStart, pathParts[pathParts.length - 1]);
}

// Apply a recorded undo splice.
function applyUndo(text, undo) {
  return text.slice(0, undo.at) + undo.text + text.slice(undo.at + undo.length);
}

module.exports = {
  rootObjectStart,
  members,
  findMember,
  setKeyIn,
  removeKeyIn,
  setPath,
  getPath,
  removePath,
  applyUndo,
};
