import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';

export function canonicalAttributes(stage) {
  function replace(file, before, after) {
    const path = resolve(stage, file), source = readFileSync(path, 'utf8');
    if (!source.includes(before)) throw new Error(`Native attribute layout changed: ${file}`);
    writeFileSync(path, source.replace(before, after));
  }
  // Raw C descriptors already supply Uint32 indices. Keep the Web/U16 contract
  // in the original source and module probes; the raw native graph is closed.
  const geometry = 'src/scene/Geometry.ts', path = resolve(stage, geometry), source = readFileSync(path, 'utf8');
  if (!/^type IndexAttribute = .*;$/m.test(source)) throw new Error('Review native index attribute layout');
  writeFileSync(path, source.replace(/^type IndexAttribute = .*;$/m, 'type IndexAttribute = Attribute<Uint32Array>;'));
  replace('native/scene-core.ts', 'sourceIndices instanceof Uint32Array ? sourceIndices : new Uint32Array(sourceIndices)', 'sourceIndices');
  replace('src/renderer/geometryUpdates.ts', 'if (array instanceof Uint16Array) array[index] = value;\n  else array[index] = value;', 'array[index] = value;');

  // Generate concrete packers from the one shared loop. The caller's attribute
  // format selects a function once, rather than testing every vertex component.
  const packPath = resolve(stage, 'src/renderer/geometryUpdates.ts');
  const file = ts.createSourceFile(packPath, readFileSync(packPath, 'utf8'), ts.ScriptTarget.Latest, true), f = ts.factory;
  const formats = {position:'Float32Array', normal:'Float32Array', uv:'Float32Array', uv1:'Float32Array', color:'Float32Array', tangent:'Float32Array', materialIndex:'Int32Array'};
  const transformed = ts.transform(file, [context => node => ts.visitNode(node, function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'packAttribute') {
      return ['Float32Array', 'Int32Array'].map(storage => f.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken,
        f.createIdentifier('packAttribute' + storage), undefined,
        node.parameters.map(p => f.updateParameterDeclaration(p, p.modifiers, p.dotDotDotToken, p.name, p.questionToken,
          p.type && ts.visitNode(p.type, function type(n) {return ts.isTypeReferenceNode(n) && n.typeName.getText(file) === 'T'
            ? f.createTypeReferenceNode(storage) : ts.visitEachChild(n, type, context);}), p.initializer)), node.type, node.body));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'packAttribute') {
      const arg = node.arguments[0], storage = ts.isPropertyAccessExpression(arg) && formats[arg.name.text];
      if (!storage) throw new Error('Review native vertex attribute format');
      return f.updateCallExpression(node, f.createIdentifier('packAttribute' + storage), undefined, node.arguments);
    }
    return ts.visitEachChild(node, visit, context);
  })]);
  writeFileSync(packPath, ts.createPrinter().printFile(transformed.transformed[0])); transformed.dispose();
}

export function lowerConcreteAccess(stage, entry) {
  const config = ts.readConfigFile(resolve(stage, 'tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, stage).options;
  const program = ts.createProgram([resolve(stage, entry)], {...options, noEmit:true}), checker = program.getTypeChecker(), f = ts.factory;
  const summary = {replaced:0, byStorage:{}, remainingValueAccesses:0};
  const typed = new Set(['Float32Array', 'Float64Array', 'Int32Array', 'Uint32Array', 'Uint16Array']);
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.fileName.startsWith(stage + '/')) continue;
    const imports = new Map(), counts = new Map();
    for (const statement of file.statements) if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const spec of statement.importClause.namedBindings.elements) {
        const symbol = checker.getSymbolAtLocation(spec.name);
        if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) continue;
        const target = checker.getAliasedSymbol(symbol), declaration = target.declarations?.[0];
        if (!declaration || !/\/(math\/access|scene\/attributeData)\.ts$/.test(declaration.getSourceFile().fileName)) continue;
        imports.set(symbol, spec); counts.set(symbol, 0);
      }
    }
    if (!imports.size) continue;
    function count(node) {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node)) {const symbol = checker.getSymbolAtLocation(node); if (counts.has(symbol)) counts.set(symbol, counts.get(symbol) + 1);}
      ts.forEachChild(node, count);
    }
    count(file);
    let changed = false;
    const transformed = ts.transform(file, [context => node => ts.visitNode(node, function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const symbol = checker.getSymbolAtLocation(node.expression), spec = imports.get(symbol), name = spec && (spec.propertyName ?? spec.name).text;
        if (spec && ['read', 'write', 'size', 'attributeValue', 'attributeLength'].includes(name)) {
          let type = checker.getTypeAtLocation(node.arguments[0]);
          if (type.flags & ts.TypeFlags.TypeParameter) type = checker.getBaseConstraintOfType(type) ?? type;
          const storage = !type.isUnion() && type.getSymbol()?.name;
          if (typed.has(storage) && (name !== 'write' || ts.isExpressionStatement(node.parent))) {
            const args = node.arguments.map(arg => ts.visitNode(arg, visit));
            counts.set(symbol, counts.get(symbol) - 1); changed = true; summary.replaced++; summary.byStorage[storage] = (summary.byStorage[storage] ?? 0) + 1;
            if (['size', 'attributeLength'].includes(name)) return f.createPropertyAccessExpression(args[0], 'length');
            const access = f.createElementAccessExpression(args[0], args[1]);
            return name === 'write' ? f.createBinaryExpression(access, ts.SyntaxKind.EqualsToken, args[2]) : access;
          }
          if (name === 'attributeValue') summary.remainingValueAccesses++;
        }
      }
      return ts.visitEachChild(node, visit, context);
    })]);
    const statements = transformed.transformed[0].statements.map(node => {
      if (!ts.isImportDeclaration(node) || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) return node;
      const kept = node.importClause.namedBindings.elements.filter(spec => {
        const symbol = checker.getSymbolAtLocation(spec.name); return !counts.has(symbol) || counts.get(symbol) > 0;
      });
      if (kept.length === node.importClause.namedBindings.elements.length) return node;
      changed = true;
      if (!kept.length && !node.importClause.name) return undefined;
      return f.updateImportDeclaration(node, node.modifiers, f.updateImportClause(node.importClause, node.importClause.isTypeOnly, node.importClause.name, f.updateNamedImports(node.importClause.namedBindings, kept)), node.moduleSpecifier, node.attributes);
    }).filter(Boolean);
    if (changed) writeFileSync(file.fileName, ts.createPrinter().printFile(f.updateSourceFile(transformed.transformed[0], statements)));
    transformed.dispose();
  }
  writeFileSync(resolve(stage, 'numeric-access.json'), JSON.stringify(summary, null, 2));
  return summary;
}
