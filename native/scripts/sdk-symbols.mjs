// The C declarations, including unavailable-platform stubs, define the shared ABI.
// Do not use mt_* wildcards: private callbacks can use the same prefix.
export function publicApiSymbols(headers) {
  const symbols = new Set();
  for (const header of headers) {
    const source = header.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const match of source.matchAll(/^[\t ]*(?!typedef\b|static\b)(?:[A-Za-z_]\w*[\t *]+)+(mt_\w+)\s*\([^;{}]*\)\s*;/gm)) {
      symbols.add(match[1]);
    }
  }
  if (!symbols.size) throw Error('No public C API declarations found');
  return [...symbols].sort();
}

export function checkSdkExports(expected, actual) {
  const wanted = new Set(expected), found = new Set(actual);
  const missing = expected.filter(name => !found.has(name));
  const extra = actual.filter(name => !wanted.has(name));
  if (missing.length || extra.length) {
    throw Error(`SDK export mismatch; missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`);
  }
}

export function nativeLinkArguments(output) {
  const match = /native-static-libs: ([^\r\n]+)/.exec(output);
  if (!match) throw Error('rustc did not report native-static-libs');
  // rustc emits linker arguments (including repeated framework/library flags).
  // Keep order and quoted Windows SDK paths; never send this text to a shell.
  return [...match[1].matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)]
    .map(part => part[1] ?? part[2] ?? part[3]);
}
