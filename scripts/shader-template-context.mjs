import ts from 'typescript';

export function isRendererSource(filename) {
  return filename.replace(/\\/g, '/').includes('/src/renderer/');
}

/** Shared selection for source analysis and emission. */
export function shaderTemplateLanguage(node, sourceFile, inherited) {
  if (!isRendererSource(sourceFile.fileName)) return undefined;
  const marked = /\/\*\s*(wgsl|glsl)\s*\*\/\s*$/.exec(
    sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile)));
  const dedicated = /\/renderer\/(wgsl|glsl)\//.exec(sourceFile.fileName.replace(/\\/g, '/'));
  return inherited || marked?.[1] || dedicated?.[1];
}

export function shaderTemplateParts(node) {
  return ts.isNoSubstitutionTemplateLiteral(node) ? [node.text]
    : [node.head.text, ...node.templateSpans.map(span => span.literal.text)];
}
