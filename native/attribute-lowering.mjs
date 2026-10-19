import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';

export function lowerConcreteAccess(stage, entry) {
  const config = ts.readConfigFile(resolve(stage, 'tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, stage).options;
  const program = ts.createProgram([resolve(stage, entry)], {...options, noEmit:true}), checker = program.getTypeChecker(), f = ts.factory;
  const summary = {replaced:0, byStorage:{}, remainingValueAccesses:0};
  const typed = new Set(['Float32Array', 'Float64Array', 'Int32Array', 'Uint32Array', 'Uint16Array', 'Uint8Array', 'Uint8ClampedArray', 'number[]']);
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.fileName.startsWith(stage + '/')) continue;
    const imports = new Map(), counts = new Map();
    for (const statement of file.statements) if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const spec of statement.importClause.namedBindings.elements) {
        const symbol = checker.getSymbolAtLocation(spec.name);
        if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) continue;
        const target = checker.getAliasedSymbol(symbol), declaration = target.declarations?.[0];
        if (!declaration || !/\/(math\/access|scene\/attributeData|scene\/texturePixels|renderer\/textureAtlasPixels)\.ts$/.test(declaration.getSourceFile().fileName)) continue;
        imports.set(symbol, spec); counts.set(symbol, 0);
      }
    }
    function count(node) {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node)) {const symbol = checker.getSymbolAtLocation(node); if (counts.has(symbol)) counts.set(symbol, counts.get(symbol) + 1);}
      ts.forEachChild(node, count);
    }
    count(file);
    let changed = false;
    const transformed = ts.transform(file, [context => node => ts.visitNode(node, function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const symbol = checker.getSymbolAtLocation(node.expression), spec = imports.get(symbol);
        const declaration = checker.getResolvedSignature(node)?.declaration;
        const accessor = declaration && /\/(math\/access|scene\/attributeData|scene\/texturePixels|renderer\/textureAtlasPixels)\.ts$/.test(declaration.getSourceFile().fileName);
        const name = spec ? (spec.propertyName ?? spec.name).text : accessor && declaration.name?.text;
        if ((spec || accessor) && ['read', 'write', 'size', 'attributeValue', 'attributeLength', 'pixelValue', 'pixelLength', 'writeAtlasPixel'].includes(name)) {
          let type = checker.getTypeAtLocation(node.arguments[0]);
          if (type.flags & ts.TypeFlags.TypeParameter) type = checker.getBaseConstraintOfType(type) ?? type;
          const storage = !type.isUnion() && (checker.isArrayType(type) && checker.getTypeArguments(type)[0]?.flags & ts.TypeFlags.Number ? 'number[]' : type.getSymbol()?.name);
          if (typed.has(storage) && (!['write', 'writeAtlasPixel'].includes(name) || ts.isExpressionStatement(node.parent))) {
            const args = node.arguments.map(arg => ts.visitNode(arg, visit));
            if (counts.has(symbol)) counts.set(symbol, counts.get(symbol) - 1); changed = true; summary.replaced++; summary.byStorage[storage] = (summary.byStorage[storage] ?? 0) + 1;
            if (['size', 'attributeLength', 'pixelLength'].includes(name)) return f.createPropertyAccessExpression(args[0], 'length');
            const access = f.createElementAccessExpression(args[0], args[1]);
            return ['write', 'writeAtlasPixel'].includes(name) ? f.createBinaryExpression(access, ts.SyntaxKind.EqualsToken, args[2]) : access;
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
