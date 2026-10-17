import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';

const pixels = ['Uint8Array', 'Uint8ClampedArray', 'Float32Array', 'Int32Array'];
const specs = [
  ['src/renderer/textureAtlasPixels.ts', 'writeRawAtlasPlacement', 'texture', pixels, true],
  ['src/renderer/envMapDistribution.ts', 'environmentLuminance', 'data', pixels],
  ['src/renderer/lightSampling.ts', 'environmentPower', 'data', pixels],
  ['src/renderer/scenePreparation.ts', 'finiteValues', 'values', ['Float32Array', 'Float64Array', 'number[]']]
];

// Derive the native kernels from the shared TS bodies. scriptc cannot index
// storage unions directly; dispatch once per array/texture, never per component.
export function specializeStorageSource(source, name, parameter, storages, atlas = false) {
  const file = ts.createSourceFile('storage.ts', source, ts.ScriptTarget.Latest, true);
  const original = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!original?.body) throw new Error(`Review native storage kernel: ${name}`);
  const f = ts.factory, printer = ts.createPrinter();
  const print = node => printer.printNode(ts.EmitHint.Unspecified, node, file);
  const kernelName = (storage, output = '') => `${name}${storage.replace(/\W/g, '')}${output}`;
  const outputs = atlas ? ['Uint8Array', 'Uint16Array'] : [''];
  const kernels = [];
  for (const storage of storages) for (const output of outputs) {
    const byteSource = storage.startsWith('Uint8');
    const body = ts.transform(original.body, [context => node => ts.visitNode(node, function visit(n) {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        if (n.name.text === 'bytes') return f.updateVariableDeclaration(n, n.name, n.exclamationToken,
          n.type, byteSource ? f.createTrue() : f.createFalse());
        if (['scale', 'sourceScale'].includes(n.name.text)) return f.updateVariableDeclaration(n, n.name,
          n.exclamationToken, n.type, byteSource
            ? f.createBinaryExpression(f.createNumericLiteral(1), ts.SyntaxKind.SlashToken, f.createNumericLiteral(255))
            : f.createNumericLiteral(1));
      }
      // The dispatcher has already selected one of the four supported formats.
      if (atlas && ts.isIfStatement(n) && n.expression.getText(file).startsWith('!bytes')) return undefined;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const args = n.arguments.map(a => ts.visitNode(a, visit));
        if (['pixelLength', 'size', 'attributeLength'].includes(n.expression.text)) return f.createPropertyAccessExpression(args[0], 'length');
        if (['pixelValue', 'read', 'attributeValue'].includes(n.expression.text)) return f.createElementAccessExpression(args[0], args[1]);
        if (n.expression.text === 'writeAtlasPixel') return f.createBinaryExpression(
          f.createElementAccessExpression(args[0], args[1]), ts.SyntaxKind.EqualsToken, args[2]);
      }
      return ts.visitEachChild(n, visit, context);
    })]);
    const parameters = original.parameters.map(p => {
      const key = p.name.getText(file);
      if (atlas && key === 'data') return `${key}: ${output}`;
      if (key === parameter) return atlas
        ? 'texture: {image: {width: number; height: number; data: ' + storage + '}; flipY: boolean}'
        : `${key}: ${storage}`;
      return print(p);
    });
    kernels.push(`function ${kernelName(storage, output)}(${parameters.join(', ')})${original.type ? ': ' + print(original.type) : ''} ${print(body.transformed[0])}`);
    body.dispose();
  }
  const argumentsFor = storage => original.parameters.map(p => p.name.getText(file) === parameter && atlas
    ? '{image: {width: source.width, height: source.height, data: source.data}, flipY: texture.flipY}' : p.name.getText(file)).join(', ');
  const value = atlas ? 'source.data' : parameter;
  const dispatch = storages.map(storage => {
    const call = output => `return ${kernelName(storage, output)}(${argumentsFor(storage)});`;
    const result = atlas ? `if (data instanceof Uint16Array) {${call('Uint16Array')}} ${call('Uint8Array')}` : call('');
    return storage === 'number[]' ? result : `if (${value} instanceof ${storage}) {${result}}`;
  }).join('\n');
  // The first brace may be in an inline parameter type; use the actual body span.
  const signature = original.getText(file).slice(0, original.body.pos - original.getStart(file));
  const wrapper = `${signature}{${atlas ? 'const source = texture.image;' : ''}\n${dispatch}\n${storages.includes('number[]') ? '' : 'throw new Error("Unsupported texture pixel storage.");'}\n}`;
  let result = source.slice(0, original.getStart(file)) + wrapper + '\n' + kernels.join('\n') + source.slice(original.end);
  // All pixel/math access imports in these kernels are now direct operations.
  const parsed = ts.createSourceFile('result.ts', result, ts.ScriptTarget.Latest, true);
  const used = new Set();
  function count(node) {if (ts.isImportDeclaration(node)) return; if (ts.isIdentifier(node)) used.add(node.text); ts.forEachChild(node, count);}
  count(parsed);
  const statements = parsed.statements.map(node => {
    if (!ts.isImportDeclaration(node) || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) return node;
    const kept = node.importClause.namedBindings.elements.filter(s => used.has(s.name.text));
    if (!kept.length && !node.importClause.name) return undefined;
    return f.updateImportDeclaration(node, node.modifiers, f.updateImportClause(node.importClause,
      node.importClause.isTypeOnly, node.importClause.name, kept.length ? f.updateNamedImports(node.importClause.namedBindings, kept) : undefined), node.moduleSpecifier, node.attributes);
  }).filter(Boolean);
  result = printer.printFile(f.updateSourceFile(parsed, statements));
  return result;
}

export function specializeStorageLoops(stage) {
  for (const [file, name, parameter, storages, atlas] of specs) {
    const path = resolve(stage, file);
    writeFileSync(path, specializeStorageSource(readFileSync(path, 'utf8'), name, parameter, storages, atlas));
  }
}
