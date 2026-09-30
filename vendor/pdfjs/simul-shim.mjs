/*! Simul: built-ins that the modern pdf.js 6.3.289 build calls unguarded and
 * Chrome 138 lacks. Each is defined only when missing, non-enumerable like the
 * built-in it stands in for, and covers what pdf.js uses: options it does not
 * implement throw instead of being ignored. Loaded before pdf.js in the page
 * and in its worker. */
function define(target, name, value) {
  if (typeof target[name] === 'function') return;
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

for (const Collection of [Map, WeakMap]) {
  define(Collection.prototype, 'getOrInsert', function getOrInsert(key, value) {
    if (!this.has(key)) this.set(key, value);
    return this.get(key);
  });
  define(
    Collection.prototype,
    'getOrInsertComputed',
    function getOrInsertComputed(key, callback) {
      if (!this.has(key)) this.set(key, callback(key));
      return this.get(key);
    },
  );
}

// pdf.js sums byte lengths (exact as a plain sum) and glyph and column widths,
// where the plain sum's rounding is far below a pixel.
define(Math, 'sumPrecise', function sumPrecise(items) {
  let sum = -0;
  for (const item of items) {
    if (typeof item !== 'number') throw new TypeError('Math.sumPrecise sums numbers only.');
    sum += item;
  }
  return sum;
});

function assertDefaultBase64Options(options) {
  if (options === undefined) return;
  const { alphabet = 'base64', omitPadding = false, lastChunkHandling = 'loose' } = options;
  if (alphabet !== 'base64' || omitPadding || lastChunkHandling !== 'loose') {
    throw new TypeError('This base64 stand-in supports only the default options.');
  }
}

define(Uint8Array.prototype, 'toHex', function toHex() {
  let hex = '';
  for (const byte of this) hex += byte.toString(16).padStart(2, '0');
  return hex;
});

define(Uint8Array.prototype, 'toBase64', function toBase64(options) {
  assertDefaultBase64Options(options);
  let binary = '';
  for (let index = 0; index < this.length; index += 0x8000) {
    binary += String.fromCharCode(...this.subarray(index, index + 0x8000));
  }
  return btoa(binary);
});

define(Uint8Array, 'fromBase64', function fromBase64(text, options) {
  assertDefaultBase64Options(options);
  if (typeof text !== 'string') throw new TypeError('Uint8Array.fromBase64 needs a string.');
  let binary;
  try {
    binary = atob(text);
  } catch {
    throw new SyntaxError('Uint8Array.fromBase64 was given invalid base64.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
});
