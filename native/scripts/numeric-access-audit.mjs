import {writeFileSync} from 'node:fs';
import {resolve, relative} from 'node:path';
import ts from 'typescript';

// Trace exported native entry points, constructors, getters and callbacks. A
// dispatcher called by a loop is just as hot as one written inside that loop.
export function auditNumericAccess(stage, entry, enforce = true) {
  // TypeScript canonicalizes Windows source-file names to forward slashes.
  stage = resolve(stage).replaceAll('\\', '/');
  entry = resolve(stage, entry).replaceAll('\\', '/');
  const config = ts.readConfigFile(resolve(stage, 'tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, stage).options;
  const program = ts.createProgram([resolve(stage, entry)], {...options, noEmit: true}), checker = program.getTypeChecker();
  const accessorFiles = /\/(math\/access|scene\/attributeData|scene\/texturePixels|renderer\/textureAtlasPixels)\.ts$/;
  const accessorNames = new Set(['read', 'write', 'size', 'attributeValue', 'attributeLength', 'pixelValue', 'pixelLength', 'writePixel', 'writeAtlasPixel']);
  const records = new Map(), roots = new Set(), sites = [], callbackLinks = [], calls = [];
  const callbackTargets = new Map();
  const belongs = n => n && n.getSourceFile().fileName.startsWith(stage + '/') && !n.getSourceFile().isDeclarationFile;
  function record(node) {
    if (!records.has(node)) records.set(node, {node, edges: [], sites: [], reachable: false, inLoop: false});
    return records.get(node);
  }
  function target(symbol) {
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declarations = symbol?.declarations?.flatMap(n => {
      if (!belongs(n)) return [];
      if (ts.isFunctionLike(n) && n.body || ts.isClassDeclaration(n)) return [n];
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isFunctionLike(n.initializer)) return [n.initializer];
      return [];
    }) ?? [];
    return [...declarations, ...callbackTargets.get(symbol) ?? []];
  }
  function connect(owner, node, loop) { if (belongs(node)) record(owner).edges.push({node, loop}); }
  function visit(node, owner, loop) {
    if (ts.isFunctionLike(node) && node.body) {
      if (node !== owner) { record(node); visit(node.body, node, false); return; }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const declaration = checker.getResolvedSignature(node)?.declaration;
      if (belongs(declaration)) connect(owner, declaration, loop);
      calls.push({owner, expression:node.expression, loop});
      if (belongs(declaration) && declaration.body) {
        for (let i = 0; i < (node.arguments?.length ?? 0); i++) {
          const parameter = declaration.parameters[i], argument = node.arguments[i];
          if (parameter && ts.isIdentifier(parameter.name)) callbackLinks.push({
            parameter:checker.getSymbolAtLocation(parameter.name), argument
          });
        }
      }
      const name = declaration?.name?.getText(declaration.getSourceFile());
      if (declaration && accessorFiles.test(declaration.getSourceFile().fileName) && accessorNames.has(name)) {
        const file = node.getSourceFile(), location = file.getLineAndCharacterOfPosition(node.getStart(file));
        const site = {file:relative(stage, file.fileName), line:location.line + 1, column:location.character + 1,
          expression:node.getText(file), type:node.arguments?.[0] ? checker.typeToString(checker.getTypeAtLocation(node.arguments[0])) : '',
          function:owner.name?.getText(owner.getSourceFile()) ?? '<module/callback>', localLoop:loop, reachable:false, calledFromLoop:false};
        record(owner).sites.push(site); sites.push(site);
      }
      if (ts.isNewExpression(node)) for (const value of target(checker.getSymbolAtLocation(node.expression))) connect(owner, value, loop);
      const callbackLoop = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ['map', 'forEach', 'filter', 'reduce', 'some', 'every', 'find', 'findIndex', 'sort'].includes(node.expression.name.text);
      for (const argument of node.arguments ?? []) {
        if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) connect(owner, argument, loop || callbackLoop);
        else for (const value of target(checker.getSymbolAtLocation(argument))) connect(owner, value, loop || callbackLoop);
      }
    }
    if (ts.isPropertyAccessExpression(node)) for (const value of target(checker.getSymbolAtLocation(node.name))) {
      if (ts.isGetAccessorDeclaration(value)) connect(owner, value, loop);
    }
    const nextLoop = loop || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
    ts.forEachChild(node, child => visit(child, owner, nextLoop));
  }
  for (const file of program.getSourceFiles()) {
    if (!belongs(file)) continue;
    record(file); roots.add(file); visit(file, file, false);
    if (file.fileName === entry) {
      const symbol = checker.getSymbolAtLocation(file);
      for (const exported of symbol ? checker.getExportsOfModule(symbol) : []) for (const node of target(exported)) roots.add(node);
    }
    // Class initialization bodies are run when their class is instantiated.
    for (const node of file.statements) if (ts.isClassDeclaration(node)) {
      const value = record(node);
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member)) value.edges.push({node:member, loop:false});
        else if (ts.isPropertyDeclaration(member) && member.initializer) visit(member.initializer, node, false);
      }
    }
  }
  // Follow user-defined callback parameters as well as built-in array methods.
  // Resolve after traversal, including callbacks forwarded through helpers.
  let changed = true;
  while (changed) {
    changed = false;
    for (const {parameter, argument} of callbackLinks) {
      const functions = ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
        ? [argument] : target(checker.getSymbolAtLocation(argument));
      let values = callbackTargets.get(parameter);
      if (!values) callbackTargets.set(parameter, values = new Set());
      for (const fn of functions) if (!values.has(fn)) { values.add(fn); changed = true; }
    }
  }
  for (const {owner, expression, loop} of calls)
    for (const fn of target(checker.getSymbolAtLocation(expression))) connect(owner, fn, loop);
  const queue = [...roots].map(node => ({node, loop:false}));
  while (queue.length) {
    const {node, loop} = queue.pop(), value = record(node);
    if (value.reachable && (!loop || value.inLoop)) continue;
    value.reachable = true; value.inLoop ||= loop;
    for (const edge of value.edges) queue.push({node:edge.node, loop:loop || edge.loop});
  }
  for (const value of records.values()) for (const site of value.sites) {
    site.reachable = value.reachable; site.calledFromLoop = value.reachable && (value.inLoop || site.localLoop);
  }
  const violations = sites.filter(site => site.calledFromLoop);
  const report = {entry:relative(stage, resolve(stage, entry)), remaining:sites.filter(site => site.reachable),
    unreachableTemplates:sites.filter(site => !site.reachable), violations};
  writeFileSync(resolve(stage, 'numeric-access-report.json'), JSON.stringify(report, null, 2));
  if (enforce && violations.length) throw new Error(`Numeric storage dispatcher remains in ${violations.length} loop call sites; see ${stage}/numeric-access-report.json`);
  return report;
}
