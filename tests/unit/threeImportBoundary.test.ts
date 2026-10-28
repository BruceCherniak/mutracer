import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

function files(root: string): string[] {
  return readdirSync(root, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? files(resolve(root, entry.name)) : entry.name.endsWith('.ts') ? [resolve(root, entry.name)] : []);
}
it('keeps Three.js dependencies inside the two integration modules', () => {
  const root = resolve('src'), allowed = new Set(['util/fromTHREE.ts', 'util/threeDeformation.ts']), violations: string[] = [];
  for (const path of files(root)) {
    const name = relative(root, path).replaceAll('\\', '/');
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier :
        ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteral(specifier) && /^three(?:\/|$)/.test(specifier.text) && !allowed.has(name)) violations.push(name);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});
it('keeps RenderLoop on public first-layer APIs and pure policy imports', () => {
  const source = ts.createSourceFile('RenderLoop.ts', readFileSync(resolve('src/RenderLoop.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.includes('/renderer/') && node.moduleSpecifier.text !== './renderer/progressiveScheduler.js') violations.push(node.moduleSpecifier.text);
    if (ts.isPropertyAccessExpression(node) && node.name.text.startsWith('_') && ['engine', 'final', 'preview', 'display'].some(name => node.expression.getText(source).endsWith(name))) violations.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source); expect(violations).toEqual([]);
});
