// Import without browser globals to verify all relative ESM paths resolve.
// The optional oidn entry awaits an upstream oidn-web ESM fix.
const library = await import('../lib/main.js');
if (typeof library.Renderer !== 'function') throw new Error('Missing Renderer export');
console.log(`Library ESM resolves in Node (${Object.keys(library).length} exports).`);

// Inspect every declaration, including re-exported and implementation modules.
const { readdirSync, readFileSync } = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { default: ts } = await import('typescript');
const declarationsRoot = fileURLToPath(new URL('../lib/', import.meta.url));
function checkDeclarations(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { checkDeclarations(file); continue; }
    if (!file.endsWith('.d.ts')) continue;
    const source = readFileSync(file, 'utf8');
    if (source.includes('@internal')) throw new Error(`Internal declaration leaked: ${file}`);
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      const member = ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
        ts.isPropertySignature(node) || ts.isMethodSignature(node);
      if (member && node.name?.getText(ast).replace(/^['"]|['"]$/g, '').startsWith('_') &&
        !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword)) {
        throw new Error(`Public underscore member leaked: ${file}: ${node.name.getText(ast)}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
checkDeclarations(declarationsRoot);
console.log('Library declarations contain no @internal or public underscore members.');
