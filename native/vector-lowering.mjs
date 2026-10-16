import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';

// Specialize only statically known numeric storage in the closed native graph.
// Clone the shared function AST, never maintain a second arithmetic body. Open
// arrays/unions and callbacks keep the existing compatibility implementation.
export function specializeVectorCalls(stage, entry) {
  const config = ts.readConfigFile(resolve(stage, 'tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, stage).options;
  const program = ts.createProgram([entry], {...options, noEmit:true});
  const checker = program.getTypeChecker(), f = ts.factory, variants = new Map();
  const storages = new Map([['Float32Array', '32'], ['Float64Array', '64']]);
  let calls = 0;
  const edits = new Map();
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.fileName.startsWith(stage + '/')) continue;
    const changes = new Map();
    function inspect(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration && ts.isFunctionDeclaration(declaration) && declaration.typeParameters?.length &&
            /\/src\/math\/vec[23]\.ts$/.test(declaration.getSourceFile().fileName) && declaration.name.text !== 'forEach') {
          const types = new Map(), signature = [];
          let concrete = true;
          for (const parameter of declaration.parameters) {
            if (!parameter.type || !ts.isTypeReferenceNode(parameter.type)) continue;
            const name = parameter.type.typeName.getText(declaration.getSourceFile());
            if (!declaration.typeParameters.some(p => p.name.text === name)) continue;
            const arg = node.arguments[declaration.parameters.indexOf(parameter)];
            const type = arg && checker.getTypeAtLocation(arg), storage = type && !type.isUnion() && type.getSymbol()?.name;
            if (!storages.has(storage) || types.has(name) && types.get(name) !== storage) {concrete = false; break;}
            types.set(name, storage); signature.push(storages.get(storage));
          }
          if (concrete && types.size === declaration.typeParameters.length) {
            const path = declaration.getSourceFile().fileName, name = `native_${declaration.name.text}_${signature.join('_')}`;
            let functions = variants.get(path); if (!functions) variants.set(path, functions = new Map());
            functions.set(name, {declaration, types}); changes.set(node, name); calls++;
          }
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(file); if (changes.size) edits.set(file.fileName, changes);
  }
  for (const file of program.getSourceFiles()) {
    const changes = edits.get(file.fileName), functions = variants.get(file.fileName);
    if (!changes && !functions) continue;
    const transformed = ts.transform(file, [context => node => ts.visitNode(node, function visit(node) {
      if (changes?.has(node)) return f.updateCallExpression(node,
        f.updatePropertyAccessExpression(node.expression, ts.visitNode(node.expression.expression, visit), f.createIdentifier(changes.get(node))),
        undefined, node.arguments.map(a => ts.visitNode(a, visit)));
      return ts.visitEachChild(node, visit, context);
    })]);
    const extra = [];
    for (const [name, {declaration, types}] of functions ?? []) {
      if (file.statements.some(n => ts.isFunctionDeclaration(n) && n.name?.text === name)) continue;
      const clone = ts.transform(declaration, [context => node => ts.visitNode(node, function visit(node) {
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && types.has(node.typeName.text))
          return f.createTypeReferenceNode(types.get(node.typeName.text));
        return ts.visitEachChild(node, visit, context);
      })]);
      const fn = clone.transformed[0];
      extra.push(f.updateFunctionDeclaration(fn, fn.modifiers, fn.asteriskToken, f.createIdentifier(name), undefined, fn.parameters, fn.type, fn.body));
      clone.dispose();
    }
    const result = f.updateSourceFile(transformed.transformed[0], [...transformed.transformed[0].statements, ...extra]);
    writeFileSync(file.fileName, ts.createPrinter().printFile(result)); transformed.dispose();
  }
  const summary = {calls, functions:[...variants.values()].reduce((n, v) => n + v.size, 0)};
  writeFileSync(resolve(stage, 'vector-specialization.json'), JSON.stringify(summary, null, 2));
  return summary;
}
