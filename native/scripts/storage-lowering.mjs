import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';

const numericStorage = new Set(['Float32Array', 'Float64Array', 'Int32Array', 'Uint32Array', 'Uint16Array', 'Uint8Array', 'Uint8ClampedArray']);

// Monomorphization changes only types and call targets. All branches, arithmetic,
// scale values and loop bodies remain the shared source's AST, without name-based
// rewrites. Iterate because a concrete wrapper can expose further generic calls.
export function specializeStorageLoops(stage, entry) {
  const config = ts.readConfigFile(resolve(stage, 'tsconfig.json'), ts.sys.readFile);
  const options = config.config ? ts.parseJsonConfigFileContent(config.config, ts.sys, stage).options : {};
  const f = ts.factory, summary = {calls: 0, functions: 0, passes: 0, variants: []};
  for (let pass = 0; pass < 12; pass++) {
    const program = ts.createProgram([resolve(stage, entry)], {...options, noEmit: true});
    const checker = program.getTypeChecker(), edits = new Map(), variants = new Map(), extraImports = new Map();
    function concrete(type) {
      if (type?.isUnion()) {
        const members = type.types.filter(t => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
        if (members.length !== 1) return;
        type = members[0];
      }
      if (!type || type.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
      const name = type.getSymbol()?.name;
      if (numericStorage.has(name)) return {name, node: f.createTypeReferenceNode(name)};
      if (checker.isArrayType(type) && checker.getTypeArguments(type)[0]?.flags & ts.TypeFlags.Number) {
        return {name: 'number[]', node: f.createArrayTypeNode(f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword))};
      }
    }
    for (const file of program.getSourceFiles()) {
      if (file.isDeclarationFile || !file.fileName.startsWith(stage + '/')) continue;
      const changes = new Map();
      function inspect(node) {
        if (ts.isCallExpression(node)) {
          const declaration = checker.getResolvedSignature(node)?.declaration;
          if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body && declaration.typeParameters?.length &&
              declaration.getSourceFile().fileName.startsWith(stage + '/') &&
              (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))) {
            const parameters = new Set(declaration.typeParameters.map(t => t.name.text)), types = new Map();
            let valid = true;
            function infer(pattern, actual) {
              if (!pattern || !actual || !valid) return;
              if (actual.isUnion()) {
                const members = actual.types.filter(t => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
                if (members.length === 1) actual = members[0];
              }
              if (ts.isUnionTypeNode(pattern)) {
                const candidates = pattern.types.filter(n => !(n.kind === ts.SyntaxKind.UndefinedKeyword || ts.isLiteralTypeNode(n)));
                if (candidates.length === 1) infer(candidates[0], actual);
              } else if (ts.isTypeReferenceNode(pattern)) {
                const name = pattern.typeName.getText(declaration.getSourceFile());
                if (parameters.has(name)) {
                  const storage = concrete(actual);
                  if (!storage || types.has(name) && types.get(name).name !== storage.name) valid = false;
                  else types.set(name, storage);
                } else if (pattern.typeArguments?.length && actual.getSymbol()?.name === name) {
                  const args = checker.getTypeArguments(actual);
                  pattern.typeArguments.forEach((p, i) => infer(p, args[i]));
                }
              }
            }
            declaration.parameters.forEach((p, i) => infer(p.type, node.arguments[i] && checker.getTypeAtLocation(node.arguments[i])));
            if (valid && types.size === parameters.size) {
              const signature = [...types].map(([key, value]) => key + ':' + value.name).join(',');
              const name = `storage_${declaration.name.text}_${createHash('sha256').update(signature).digest('hex').slice(0, 12)}`;
              const target = declaration.getSourceFile();
              let functions = variants.get(target.fileName); if (!functions) variants.set(target.fileName, functions = new Map());
              if (!target.statements.some(n => ts.isFunctionDeclaration(n) && n.name?.text === name)) functions.set(name, {declaration, types});
              changes.set(node, name);
              if (ts.isIdentifier(node.expression) && target !== file) {
                const symbol = checker.getSymbolAtLocation(node.expression), spec = symbol?.declarations?.find(ts.isImportSpecifier);
                if (!spec) throw new Error(`Cannot import concrete numeric function: ${file.fileName}:${node.getStart(file)}`);
                const statement = spec.parent.parent.parent;
                let imports = extraImports.get(file.fileName); if (!imports) extraImports.set(file.fileName, imports = new Map());
                let names = imports.get(statement); if (!names) imports.set(statement, names = new Set()); names.add(name);
              }
            }
          }
        }
        ts.forEachChild(node, inspect);
      }
      inspect(file); if (changes.size) edits.set(file.fileName, changes);
    }
    if (!edits.size) break;
    summary.passes++;
    for (const file of program.getSourceFiles()) {
      const changes = edits.get(file.fileName), functions = variants.get(file.fileName), imports = extraImports.get(file.fileName);
      if (!changes && !functions) continue;
      function cloneVariant(name, declaration, types) {
        const clone = ts.transform(declaration, [context => node => ts.visitNode(node, function visit(node) {
          if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && types.has(node.typeName.text)) return types.get(node.typeName.text).node;
          return ts.visitEachChild(node, visit, context);
        })]);
        const fn = clone.transformed[0];
        const result = f.updateFunctionDeclaration(fn, fn.modifiers, fn.asteriskToken, f.createIdentifier(name), undefined, fn.parameters, fn.type, fn.body);
        summary.functions++; summary.variants.push({file:file.fileName.slice(stage.length + 1), name, types:Object.fromEntries([...types].map(([k,v]) => [k,v.name]))});
        clone.dispose(); return result;
      }
      const transformed = ts.transform(file, [context => node => ts.visitNode(node, function visit(node) {
        if (ts.isBlock(node)) {
          const children = ts.visitEachChild(node, visit, context);
          const nested = [...functions ?? []].filter(([,v]) => v.declaration.parent === node)
            .map(([name,{declaration,types}]) => cloneVariant(name,declaration,types));
          return nested.length ? f.updateBlock(children,[...children.statements,...nested]) : children;
        }
        if (changes?.has(node)) {
          const expression = ts.isIdentifier(node.expression) ? f.createIdentifier(changes.get(node))
            : f.updatePropertyAccessExpression(node.expression, ts.visitNode(node.expression.expression, visit), f.createIdentifier(changes.get(node)));
          summary.calls++;
          return f.updateCallExpression(node, expression, undefined, node.arguments.map(a => ts.visitNode(a, visit)));
        }
        if (imports?.has(node)) {
          const bindings = node.importClause.namedBindings;
          const added = [...imports.get(node)].filter(name => !bindings.elements.some(s => s.name.text === name))
            .map(name => f.createImportSpecifier(false, undefined, f.createIdentifier(name)));
          return f.updateImportDeclaration(node, node.modifiers, f.updateImportClause(node.importClause, false, node.importClause.name,
            f.updateNamedImports(bindings, [...bindings.elements, ...added])), node.moduleSpecifier, node.attributes);
        }
        return ts.visitEachChild(node, visit, context);
      })]);
      const extra = [];
      for (const [name, {declaration, types}] of functions ?? []) {
        if (declaration.parent === file) extra.push(cloneVariant(name, declaration, types));
      }
      writeFileSync(file.fileName, ts.createPrinter().printFile(f.updateSourceFile(transformed.transformed[0], [...transformed.transformed[0].statements, ...extra])));
      transformed.dispose();
    }
    if (pass === 11) throw new Error('Numeric monomorphization did not converge');
  }
  // Once every use has a concrete variant, discard only unreferenced private
  // generic templates. This is ordinary monomorphization dead-template cleanup.
  summary.prunedTemplates = [];
  for (let pass = 0; pass < 12; pass++) {
    const program = ts.createProgram([resolve(stage, entry)], {...options, noEmit: true});
    const checker = program.getTypeChecker(); let pruned = 0;
    for (const file of program.getSourceFiles()) {
      if (file.isDeclarationFile || !file.fileName.startsWith(stage + '/')) continue;
      const candidates = new Map();
      function templates(node) {
        if (ts.isFunctionDeclaration(node) && node.typeParameters?.length && !node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
          candidates.set(checker.getSymbolAtLocation(node.name), {node, count:0});
        ts.forEachChild(node,templates);
      }
      templates(file);
      function references(node) {
        if (ts.isIdentifier(node)) {const value = candidates.get(checker.getSymbolAtLocation(node)); if (value && node !== value.node.name) value.count++;}
        ts.forEachChild(node, references);
      }
      references(file);
      const dead = new Set([...candidates.values()].filter(x => !x.count).map(x => x.node));
      if (dead.size) {
        const cleaned = ts.transform(file,[context => node => ts.visitNode(node,function visit(node) {
          if (dead.has(node)) return undefined;
          return ts.visitEachChild(node,visit,context);
        })]);
        writeFileSync(file.fileName,ts.createPrinter().printFile(cleaned.transformed[0]));cleaned.dispose();
        for (const node of dead) summary.prunedTemplates.push({file:file.fileName.slice(stage.length + 1), name:node.name.text});
        pruned += dead.size;
      }
    }
    if (!pruned) break;
  }
  {
    const program = ts.createProgram([resolve(stage, entry)], {...options, noEmit:true}), checker=program.getTypeChecker();
    for (const file of program.getSourceFiles()) {
      if (file.isDeclarationFile || !file.fileName.startsWith(stage+'/')) continue;
      const used=new Set();
      function references(node) {
        if (ts.isImportDeclaration(node)) return;
        if (ts.isExportSpecifier(node) && !node.parent.parent.moduleSpecifier)
          used.add(checker.getExportSpecifierLocalTargetSymbol(node));
        if (ts.isIdentifier(node)) used.add(checker.getSymbolAtLocation(node));
        ts.forEachChild(node, references);
      }
      references(file);let changed=false;
      const statements=file.statements.map(node=>{
        if(!ts.isImportDeclaration(node)||!node.importClause?.namedBindings||!ts.isNamedImports(node.importClause.namedBindings))return node;
        const kept=node.importClause.namedBindings.elements.filter(spec=>used.has(checker.getSymbolAtLocation(spec.name)));
        if(kept.length===node.importClause.namedBindings.elements.length)return node;
        changed=true;
        if(!kept.length&&!node.importClause.name)return node.importClause.isTypeOnly?undefined:f.updateImportDeclaration(node,node.modifiers,undefined,node.moduleSpecifier,node.attributes);
        return f.updateImportDeclaration(node,node.modifiers,f.updateImportClause(node.importClause,node.importClause.isTypeOnly,node.importClause.name,kept.length?f.updateNamedImports(node.importClause.namedBindings,kept):undefined),node.moduleSpecifier,node.attributes);
      }).filter(Boolean);
      if(changed)writeFileSync(file.fileName,ts.createPrinter().printFile(f.updateSourceFile(file,statements)));
    }
  }
  writeFileSync(resolve(stage, 'storage-specialization.json'), JSON.stringify(summary, null, 2));
  return summary;
}
