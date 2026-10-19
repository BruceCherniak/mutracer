import {auditNumericAccess} from './numeric-access-audit.mjs';
import {specializeStorageLoops} from './storage-lowering.mjs';
import {specializeVectorCalls} from './vector-lowering.mjs';
import {lowerConcreteAccess} from './attribute-lowering.mjs';
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let staged, nativeMatrices = false;
const snapshots = new Map();
const loweredGraphs = new Set();
const originals = new Map();
// scriptc 0.3.2 cannot index numeric storage unions. Lower these two access
// adapters only in generated compiler inputs, keeping Web hot loops branch-free.
function narrowAccess(source, constructors, parameter = 'array', names) {
  const file = ts.createSourceFile('access.ts', source, ts.ScriptTarget.Latest, true);
  const factory = ts.factory;
  const transformed = ts.transform(file, [context => node => ts.visitNode(node, function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.body && node.parameters[0]?.name.getText(file) === parameter && (!names || names.includes(node.name?.text))) {
      let indexed = false;
      function inspect(n) {
        if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === parameter ||
            ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === parameter && n.name.text === 'length') indexed = true;
        ts.forEachChild(n, inspect);
      }
      inspect(node.body); if (!indexed) return node;
      const body = node.body.statements;
      const branches = constructors.filter(name => name !== 'Array').map(name => factory.createIfStatement(
        factory.createBinaryExpression(factory.createIdentifier(parameter), ts.SyntaxKind.InstanceOfKeyword, factory.createIdentifier(name)),
        factory.createBlock([...body, ...(body.some(ts.isReturnStatement) ? [] : [factory.createReturnStatement()])], true)
      ));
      return factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters,
        node.parameters, node.type, factory.createBlock([...branches, ...(constructors.includes('Array') ? body : [factory.createThrowStatement(factory.createNewExpression(factory.createIdentifier('Error'), undefined, [factory.createStringLiteral('Unsupported numeric storage')]))])], true));
    }
    return ts.visitEachChild(node, visit, context);
  })]);
  const result = ts.createPrinter().printFile(transformed.transformed[0]);
  transformed.dispose();
  return result;
}
// Math source keeps the original direct indexing. Generate the compiler's
// equivalent accesses without copying or maintaining another math implementation.
function lowerMath(source, module) {
  const file = ts.createSourceFile('math.ts', source, ts.ScriptTarget.Latest, true);
  const f = ts.factory, used = new Set();
  let direct = new Set();
  const transformed = ts.transform(file, [context => node => ts.visitNode(node, function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.body) {
      const previous = direct; direct = new Set();
      const result = ts.visitEachChild(node, visit, context); direct = previous; return result;
    }
    const concrete = expression => ts.isIdentifier(expression) && direct.has(expression.text);
    const call = (name, args) => {used.add(name); return f.createCallExpression(f.createIdentifier(name), undefined, args);};
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isElementAccessExpression(node.left)) {
      if (concrete(node.left.expression)) return ts.visitEachChild(node, visit, context);
      return call('write', [ts.visitNode(node.left.expression, visit), ts.visitNode(node.left.argumentExpression, visit), ts.visitNode(node.right, visit)]);
    }
    if (ts.isElementAccessExpression(node) && !concrete(node.expression)) return call('read', [ts.visitNode(node.expression, visit), ts.visitNode(node.argumentExpression, visit)]);
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'length' && !concrete(node.expression)) return call('size', [ts.visitNode(node.expression, visit)]);
    return ts.visitEachChild(node, visit, context);
  })]);
  const result = ts.createPrinter().printFile(transformed.transformed[0]); transformed.dispose();
  return (used.size ? `import {${[...used].join(', ')}} from './access.js';\n` : '') + result;
}
function compilerSource() {
  if (staged) return staged;
  mkdirSync(resolve(root, '.native-build'), {recursive:true});
  staged = mkdtempSync(resolve(root, '.native-build/compiler-'));
  cpSync(resolve(root, 'src'), resolve(staged, 'src'), {recursive:true});
  cpSync(resolve(root, 'native'), resolve(staged, 'native'), {recursive:true,
    filter: path => !path.includes('/node_modules') &&
      (!/\.[^/]+$/.test(path) || /\.(ts|json)$/.test(path))});
  for (const name of ['tsconfig.json', 'package.json']) cpSync(resolve(root, name), resolve(staged, name));
  symlinkSync(resolve(root, 'node_modules'), resolve(staged, 'node_modules'), 'dir');
  for (const [file, types] of [['src/math/access.ts', ['Float32Array', 'Float64Array', 'Array']],
    ['src/scene/attributeData.ts', ['Float32Array', 'Uint16Array', 'Uint32Array', 'Int32Array']]]) {
    writeFileSync(resolve(staged, file), narrowAccess(readFileSync(resolve(root, file), 'utf8'), types));
  }
  for (const [file, types, names] of [
    ['src/scene/texturePixels.ts', ['Float32Array', 'Int32Array', 'Uint8Array', 'Uint8ClampedArray'], undefined],
    ['src/renderer/textureAtlasPixels.ts', ['Uint16Array', 'Uint8Array'], ['writeAtlasPixel']]
  ]) {
    const path = resolve(staged, file);
    writeFileSync(path, narrowAccess(readFileSync(path, 'utf8'), types, 'data', names));
  }

  for (const name of ['mat3', 'mat4', 'vec2', 'vec3']) {
    const file = `src/math/${name}.ts`;
    writeFileSync(resolve(staged, file), lowerMath(readFileSync(resolve(staged, file), 'utf8'), name));
  }
  snapshots.set(nativeMatrices, staged);
  return staged;
}
function sourcePath(path) {
  const absolute = resolve(root, path), rel = relative(root, absolute), stage = compilerSource();
  if (!rel.startsWith('..') && !rel.startsWith('.native-build/')) return resolve(stage, rel);
  // Diagnostic wrappers and profiles can be generated outside the source tree.
  // Their absolute project imports must use this same staged dependency graph.
  const target = resolve(stage, 'entries', String(originals.size) + '-' + absolute.split('/').at(-1));
  mkdirSync(dirname(target), {recursive:true});
  writeFileSync(target, readFileSync(absolute, 'utf8').replaceAll(root + '/', stage + '/'));
  originals.set(target, absolute);
  return target;
}
export function spawnCompiler(compiler, args, options = {}, matrixPrecision) {
  if (!['build', 'coverage'].includes(args[0])) return spawnSync(compiler, args, options);
  const profileAt = args.indexOf('--profile');
  let entry = args[1];
  if (profileAt >= 0) {
    const profile = resolve(root, args[profileAt + 1]);
    entry = resolve(dirname(profile), JSON.parse(readFileSync(profile, 'utf8')).entry);
  }
  nativeMatrices = matrixPrecision ?? (resolve(root, entry ?? '') === resolve(root, 'native/render-core.ts'));
  staged = snapshots.get(nativeMatrices);
  const mapped = [...args];
  let compiledEntry;
  for (let i = 1; i < args.length; i++) {
    if (args[i - 1] === '-o' || args[i - 1] === '--out') continue;
    if (args[i - 1] === '--profile') {
      const profile = resolve(root, args[i]), spec = JSON.parse(readFileSync(profile, 'utf8'));
      const entry = sourcePath(resolve(dirname(profile), spec.entry));
      const target = resolve(compilerSource(), 'profiles', String(originals.size) + '.json');
      mkdirSync(dirname(target), {recursive:true}); writeFileSync(target, JSON.stringify({...spec, entry}));
      originals.set(target, profile); mapped[i] = target; compiledEntry = entry;
    } else if (/\.tsx?$/.test(args[i]) && existsSync(resolve(root, args[i]))) compiledEntry = mapped[i] = sourcePath(args[i]);
  }
  if (compiledEntry && !loweredGraphs.has(compiledEntry)) {
    specializeVectorCalls(staged, compiledEntry);
    specializeStorageLoops(staged, compiledEntry);
    lowerConcreteAccess(staged, compiledEntry);
    auditNumericAccess(staged, compiledEntry, nativeMatrices);
    loweredGraphs.add(compiledEntry);
  }
  const result = spawnSync(compiler, mapped, options);
  result.nativeMatrixPrecision = nativeMatrices ? 64 : 32;
  result.nativeSourceRoot = staged;
  for (const field of ['stdout', 'stderr']) if (typeof result[field] === 'string') {
    for (const [generated, original] of originals) result[field] = result[field].replaceAll(generated, original);
    if (!nativeMatrices) result[field] = result[field].replaceAll(staged + '/', root + '/');
  }
  return result;
}
