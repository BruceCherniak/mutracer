import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';

// The raw native graph owns all CPU matrices. Web keeps its original types,
// defaults and storage; only generated compiler inputs use this closed layout.
export function matrixNames(module, name) {
  if (module === 'vec3') return name === 'transformMat4' ? new Set(['m']) : new Set();
  if (module === 'mat3') {
    if (!['create', 'fromMat4', 'normalFromMat4'].includes(name)) throw new Error(`Review native matrix function: ${module}.${name}`);
    return new Set(['out', 'a']);
  }
  if (module === 'mat4') {
    if (!['copy', 'create', 'invert', 'lookAt', 'identity', 'targetTo', 'getScaling', 'multiply', 'orthoNO', 'perspectiveNO', 'scale', 'rotateZ', 'fromScaling', 'translate'].includes(name)) throw new Error(`Review native matrix function: ${module}.${name}`);
    return new Set(name === 'getScaling' ? ['mat'] : ['out', 'a', 'b']);
  }
  return new Set();
}
export function canonicalMatrixStorage(stage) {
  function replace(file, before, after) {
    const path = resolve(stage, file), source = readFileSync(path, 'utf8');
    if (!source.includes(before)) throw new Error(`Native matrix layout changed: ${file}: ${before}`);
    writeFileSync(path, source.replaceAll(before, after));
  }
  for (const file of ['src/types.ts', 'src/math.ts', 'src/math/mat4.ts', 'src/math/mat3.ts']) {
    const alias = file === 'src/types.ts' ? 'Mat4' : file.endsWith('mat3.ts') ? 'Mat3Array' : 'Mat4Array';
    replace(file, `type ${alias} = Float32Array | number[]`, `type ${alias} = Float64Array`);
  }
  for (const name of ['mat3', 'mat4']) {
    replace(`src/math/${name}.ts`, 'function create(): Float32Array', 'function create(): Float64Array');
    const size = name === 'mat4' ? 16 : 9;
    replace(`src/math/${name}.ts`, `new Float32Array(${size})`, `new Float64Array(${size})`);
  }
  replace('src/scene/Camera.ts', 'const output: number[] = [];', 'const output = new Float64Array(16);');
  for (const file of ['src/renderer/scenePreparation.ts', 'src/renderer/lightSampling.ts', 'src/renderer/packedMeshInstances.ts']) {
    replace(file, 'new Array<number>(16).fill(0)', 'new Float64Array(16)');
  }
  replace('src/renderer/lightSampling.ts', 'matrix instanceof Float32Array ? matrix.length : matrix.length', 'matrix.length');
  replace('src/scene/MeshState.ts', 'transforms: Float32Array;', 'transforms: Float64Array;');
  replace('src/renderer/lightSampling.ts', 'instanceTransforms?: Float32Array;', 'instanceTransforms?: Float64Array;');
  for (const file of ['src/scene/InstanceState.ts', 'src/scene/InstancedMesh.ts']) {
    replace(file, 'transforms?: Float32Array;', 'transforms?: Float32Array | Float64Array;');
    replace(file, 'transforms: Float32Array;', 'transforms: Float64Array;');
    replace(file, 'this.transforms = options.transforms ?? new Float32Array(this.count * 16);',
      'this.transforms = options.transforms instanceof Float64Array ? options.transforms : options.transforms ? new Float64Array(options.transforms) : new Float64Array(this.count * 16);');
    replace(file, 'this.transforms instanceof Float32Array', 'this.transforms instanceof Float64Array');
    replace(file, 'Float32 transforms.', 'Float64 transforms.');
  }

}
export function specializeMatrices(source, module) {
  const file = ts.createSourceFile('math.ts', source, ts.ScriptTarget.Latest, true), f = ts.factory;
  const transformed = ts.transform(file, [context => node => ts.visitNode(node, function visit(node) {
    if (!ts.isFunctionDeclaration(node) || !node.body) return ts.visitEachChild(node, visit, context);
    const names = matrixNames(module, node.name.text);
    if (!names.size) return node;
    const replaced = new Set(node.parameters.filter(p => names.has(p.name.getText(file))).map(p => p.type?.getText(file)).filter(Boolean));
    const type = node => node && ts.visitNode(node, function visitType(node) {
      return ts.isTypeReferenceNode(node) && replaced.has(node.getText(file)) ? f.createTypeReferenceNode('Float64Array') : ts.visitEachChild(node, visitType, context);
    });
    const parameters = node.parameters.map(p => names.has(p.name.getText(file))
      ? f.updateParameterDeclaration(p, p.modifiers, p.dotDotDotToken, p.name, p.questionToken, f.createTypeReferenceNode('Float64Array'), p.initializer) : p);
    return f.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name,
      node.typeParameters?.filter(p => !replaced.has(p.name.text)), parameters, type(node.type), node.body);
  })]);
  let result = ts.createPrinter().printFile(transformed.transformed[0]); transformed.dispose();
  if (module === 'mat3') result = result.replace(/^import type .*?\n/m, '');
  return result;
}
