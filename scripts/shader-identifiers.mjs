import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { shaderTemplateLanguage, shaderTemplateParts } from './shader-template-context.mjs';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const identifier = /^[A-Za-z_]\w*$/;
const words = source => source.match(/[A-Za-z_]\w*/g) || [];
const number = /(?:0[xX][\da-fA-F]+(?:\.[\da-fA-F]*)?(?:[pP][+-]?\d+)?|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[uifh]?/y;
const name = /[A-Za-z_]\w*/y;

// Tokenize without interpreting comments, quoted operands or numeric suffixes
// as identifiers. Positions let renaming preserve all other source bytes.
function tokens(source) {
  const result = [];
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('//', i)) {
      while (i < source.length && !/[\r\n]/.test(source[i])) i++;
      continue;
    }
    if (source.startsWith('/*', i)) {
      i += 2;
      let depth = 1;
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i++];
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i++] === quote) break;
      }
      continue;
    }
    number.lastIndex = name.lastIndex = i;
    const match = number.exec(source) || name.exec(source);
    const text = match?.[0] || source[i];
    result.push({ text, start: i, end: i + text.length });
    i += text.length;
  }
  return result;
}

export function renameShaderIdentifiers(source, identifiers) {
  if (!identifiers.size) return source;
  let result = '', offset = 0;
  for (const token of tokens(source)) {
    const replacement = identifiers.get(token.text);
    if (!replacement) continue;
    result += source.slice(offset, token.start) + replacement;
    offset = token.end;
  }
  return result + source.slice(offset);
}

export function readShaderSourceFiles(root = sourceRoot) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .flatMap(entry => {
      const filename = path.join(root, entry.name);
      return entry.isDirectory() ? readShaderSourceFiles(filename)
        : entry.name.endsWith('.ts') ? [{ filename, source: readFileSync(filename, 'utf8') }] : [];
    });
}

/** Use a graph-wide, injective mapping: scopes, overloads and references across
 * chunks keep the same relationships. Reserve CPU-visible and generated names
 * instead of trying to rename host code or evaluating shader generators. */
export function createShaderIdentifierMap(files) {
  const reserved = new Set(['main', 'depthQuery']);
  const occupied = new Set();
  const candidates = new Set(), frequency = new Map();
  const fragments = [], generated = [];
  const functions = { wgsl: new Set(), glsl: new Set() };
  const types = { wgsl: new Set(), glsl: new Set() };
  const typeDependencies = new Map();
  const reserveText = text => { for (const word of words(text)) reserved.add(word); };
  for (const file of files) {
    for (const word of words(file.source)) occupied.add(word);
    const sourceFile = ts.createSourceFile(file.filename, file.source, ts.ScriptTarget.Latest, true);
    function visit(node, inherited) {
      if (ts.isTaggedTemplateExpression(node)) {
        if (!ts.isIdentifier(node.tag) || node.tag.text !== 'glsl') {
          reserveText(node.getText(sourceFile));
          return;
        }
        visit(node.tag);
        visit(node.template, 'glsl');
        return;
      }
      if (ts.isIdentifier(node)) reserved.add(node.text);
      if (ts.isStringLiteral(node)) reserveText(node.text);
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const language = shaderTemplateLanguage(node, sourceFile, inherited);
        const text = shaderTemplateParts(node).join('\0');
        if (language) {
          fragments.push({ language, text, list: tokens(text) });
          // A name such as load_${name}, ${name}Region or vec${n}f is
          // assembled dynamically. Preserve every matching concrete name.
          for (const match of text.matchAll(/(?:[A-Za-z_]\w*|\0)+(?:\w|\0)*/g)) {
            if (match[0].includes('\0') && match[0].replaceAll('\0', '')) {
              generated.push(new RegExp('^' + match[0].split('\0')
                .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\w*') + '$'));
            }
          }
        } else reserveText(text);
        if (ts.isTemplateExpression(node)) {
          for (const span of node.templateSpans) visit(span.expression, language);
        }
        return;
      }
      ts.forEachChild(node, child => visit(child, inherited));
    }
    visit(sourceFile);
  }

  // Discover all private types first so GLSL declarations using types from
  // another chunk are recognized. Constructors are not external functions.
  for (const { language, list } of fragments) {
    for (let i = 0; i < list.length - 1; i++) {
      if (['struct', 'alias'].includes(list[i].text) && identifier.test(list[i + 1].text)) {
        types[language].add(list[i + 1].text);
        candidates.add(list[i + 1].text);
      }
    }
  }
  const glslTypes = new Set(['void', 'bool', 'int', 'uint', 'float', ...types.glsl]);
  for (const { list } of fragments) for (const { text } of list) {
    if (/^(?:[biu]?vec[234]|mat[234](?:x[234])?|[iu]?sampler\w+)$/.test(text)) glslTypes.add(text);
  }
  for (const { language, text, list } of fragments) {
    for (const token of list) if (identifier.test(token.text)) {
      frequency.set(token.text, (frequency.get(token.text) || 0) + 1);
    }
    for (const line of text.split(/[\r\n]/)) if (/^\s*#/.test(line)) reserveText(line);
    for (const match of text.matchAll(/@(?:vertex|fragment|compute)\b[\s\S]*?\bfn\s+(\w+)/g)) reserved.add(match[1]);
    for (const match of text.matchAll(/@\w+\s*\(([^)]*)\)/g)) reserveText(match[1]);
    let structDepth = 0, braceDepth = 0, pendingStruct;
    let currentStruct;
    for (let i = 0; i < list.length; i++) {
      const current = list[i].text, next = list[i + 1]?.text;
      if (current === 'struct') pendingStruct = next;
      if (current === '{') {
        braceDepth++;
        if (pendingStruct) {
          structDepth = braceDepth; currentStruct = pendingStruct; pendingStruct = undefined;
          if (!typeDependencies.has(currentStruct)) typeDependencies.set(currentStruct, new Set());
        }
      }
      if (current === '}') {
        if (structDepth === braceDepth) { structDepth = 0; currentStruct = undefined; }
        braceDepth--;
      }
      if (current === '.' && identifier.test(next || '')) reserved.add(next);
      if (currentStruct && types[language].has(current)) typeDependencies.get(currentStruct).add(current);
      if (current === 'alias' && identifier.test(next || '')) {
        const dependencies = new Set();
        for (let j = i + 2; j < list.length && list[j].text !== ';'; j++) {
          if (types[language].has(list[j].text)) dependencies.add(list[j].text);
        }
        typeDependencies.set(next, dependencies);
      }
      if (language === 'wgsl') {
        if (current === 'fn' && identifier.test(next || '')) {
          functions.wgsl.add(next); candidates.add(next);
        }
        if (identifier.test(current) && next === ':') {
          (structDepth ? reserved : candidates).add(current);
        }
        if (['let', 'var', 'const', 'override'].includes(current)) {
          let j = i + 1;
          const qualifiers = [];
          if (list[j]?.text === '<') {
            while (j < list.length && list[j].text !== '>') qualifiers.push(list[j++].text);
            j++;
          }
          const declared = list[j]?.text;
          if (identifier.test(declared || '')) {
            const binding = current === 'override' || qualifiers.includes('uniform') || qualifiers.includes('storage')
              || list.slice(Math.max(0, i - 24), i).some(token => token.text === 'binding');
            (binding ? reserved : candidates).add(declared);
            if (binding && list[j + 1]?.text === ':') {
              for (let k = j + 2; k < list.length && list[k].text !== ';'; k++) {
                if (identifier.test(list[k].text)) reserved.add(list[k].text);
              }
            }
          }
        }
      } else if (glslTypes.has(current) && identifier.test(next || '')) {
        candidates.add(next);
        if (list[i + 2]?.text === '(') functions.glsl.add(next);
        if (structDepth || list.slice(Math.max(0, i - 3), i)
          .some(token => ['uniform', 'in', 'out'].includes(token.text))) {
          reserved.add(next);
          if (!structDepth) reserved.add(current);
        }
      }
    }
  }
  // Keep buffer-facing type names recursively, including aliases and nested
  // structs, so reflection sees the same layouts and names as the host.
  let changed;
  do {
    changed = false;
    for (const [type, dependencies] of typeDependencies) if (reserved.has(type)) {
      for (const dependency of dependencies) if (!reserved.has(dependency)) {
        reserved.add(dependency); changed = true;
      }
    }
  } while (changed);
  // Union both languages' external call targets. reverseBits, for example,
  // is a GLSL helper in this library but a WGSL builtin.
  for (const { language, list } of fragments) for (let i = 0; i < list.length - 1; i++) {
    const word = list[i].text;
    let argument = i + 1;
    if (list[argument].text === '<') {
      let depth = 1;
      argument++;
      while (argument < list.length && depth) {
        const token = list[argument++].text;
        if (token === '<') depth++;
        else if (token === '>') depth--;
        else if ([';', '{', '}'].includes(token)) break;
      }
      if (depth) continue;
    }
    if (identifier.test(word) && list[argument]?.text === '('
      && !functions[language].has(word) && !types[language].has(word)) reserved.add(word);
  }
  const selected = [...candidates].filter(word => word.length > 3 && !reserved.has(word)
    && !/^(?:gl_|__)/.test(word) && !/^[A-Z0-9_]+$/.test(word)
    && !generated.some(pattern => pattern.test(word))).sort((a, b) =>
    (frequency.get(b) || 0) * (b.length - 2) - (frequency.get(a) || 0) * (a.length - 2)
      || (a < b ? -1 : a > b ? 1 : 0));

  // Use only one/two-letter names, then underscore-prefixed names. This avoids
  // long reserved words by construction. Short WGSL/C/C++ reserved words:
  // https://www.w3.org/TR/WGSL/#keyword-summary
  for (const word of ['as', 'do', 'fn', 'go', 'if', 'in', 'is', 'of', 'or']) occupied.add(word);
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let serial = 0;
  function shortName() {
    let n = serial++, result = '';
    if (n >= 52 + 52 * 52) { n -= 52 + 52 * 52; result = '_'; }
    let suffix = '';
    do { suffix = alphabet[n % 52] + suffix; n = Math.floor(n / 52) - 1; } while (n >= 0);
    return result + suffix;
  }
  const mapping = new Map();
  for (const word of selected) {
    let replacement;
    do { replacement = shortName(); } while (occupied.has(replacement));
    occupied.add(replacement);
    if (replacement.length < word.length) mapping.set(word, replacement);
  }
  return mapping;
}

export function loadShaderIdentifierMap() {
  return createShaderIdentifierMap(readShaderSourceFiles());
}
