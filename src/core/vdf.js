'use strict';

/**
 * Parseur minimal du format texte KeyValues (VDF) de Valve.
 * Suffisant pour libraryfolders.vdf, appmanifest_*.acf et appworkshop_*.acf.
 */
function parseVdf(text) {
  let i = 0;
  const len = text.length;

  function skipWs() {
    while (i < len) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      if (c === '/' && text[i + 1] === '/') {
        while (i < len && text[i] !== '\n') i++;
        continue;
      }
      break;
    }
  }

  function readString() {
    if (text[i] === '"') {
      i++;
      let out = '';
      while (i < len && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < len) {
          const n = text[i + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else {
          out += text[i++];
        }
      }
      i++; // guillemet fermant
      return out;
    }
    let out = '';
    while (i < len && !/[\s{}"]/.test(text[i])) out += text[i++];
    return out;
  }

  function readObject() {
    const obj = {};
    for (;;) {
      skipWs();
      if (i >= len) return obj;
      if (text[i] === '}') { i++; return obj; }
      const key = readString();
      skipWs();
      if (text[i] === '{') {
        i++;
        obj[key] = readObject();
      } else {
        obj[key] = readString();
      }
    }
  }

  return readObject();
}

module.exports = { parseVdf };
