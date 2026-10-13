import ts from 'typescript';

// Keep newlines (including GLSL directive boundaries) and expression spacing.
// The NUL separator stands for a template interpolation; comments containing
// one stay intact so an interpolation inside a comment cannot become code.
export function stripShaderFormatting(source, trimFirstLine = true) {
  let result = '';
  for (let i = 0; i < source.length;) {
    const start = i;
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
    } else if (source.startsWith('/*', i)) {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      // Preserve malformed input so shader validation still reports it.
      if (depth > 0) { result += source.slice(start); break; }
    } else if (source[i] === '"' || source[i] === "'") {
      // Preserve quoted preprocessor operands, including URLs and escapes.
      const quote = source[i++];
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i++] === quote) break;
      }
      result += source.slice(start, i);
      continue;
    } else {
      result += source[i++];
      continue;
    }
    const comment = source.slice(start, i);
    result += comment.includes('\0') ? comment
      : comment.startsWith('/*') ? ' ' + comment.replace(/[^\r\n]/g, '') : '';
  }
  return trimFirstLine ? result.replace(/^[\t ]+/gm, '')
    : result.replace(/([\r\n])[\t ]+/g, '$1');
}

/** Only shader modules and explicitly marked/tagged shader templates are
 * transformed. Ordinary JS strings, imports and source license comments stay
 * untouched. The same transformer is used by ESM, Vite and contract tests. */
export function createShaderFormattingTransformer() {
  return context => sourceFile => {
    const filename = sourceFile.fileName.replace(/\\/g, '/');
    if (!filename.includes('/src/renderer/')) return sourceFile;
    const dedicatedShader = /\/renderer\/(?:wgsl|glsl)\//.test(filename);
    const original = (replacement, node) =>
      ts.setTextRange(ts.setOriginalNode(replacement, node), node);
    function visit(node, inShader = false) {
      if (ts.isTaggedTemplateExpression(node)) {
        // glsl reads cooked strings; other tags may inspect raw source.
        if (!ts.isIdentifier(node.tag) || node.tag.text !== 'glsl') return node;
        return ts.factory.updateTaggedTemplateExpression(node, node.tag,
          node.typeArguments, visit(node.template, true));
      }
      const isTemplate = ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
      const marked = isTemplate && /\/\*\s*(?:wgsl|glsl)\s*\*\/\s*$/.test(
        sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile)));
      const shader = inShader || dedicatedShader || marked;
      if (isTemplate && shader) {
        if (ts.isNoSubstitutionTemplateLiteral(node)) {
          // A fragment may be inserted mid-line. Its initial spaces can be
          // required token separators; only remove indentation after newlines.
          const text = stripShaderFormatting(node.text, false);
          return text === node.text ? node : original(ts.factory.createNoSubstitutionTemplateLiteral(text), node);
        }
        const parts = [node.head.text, ...node.templateSpans.map(span => span.literal.text)];
        // Shader source cannot contain NUL. Fail instead of corrupting a template.
        if (parts.some(part => part.includes('\0'))) throw new Error(`NUL in shader template: ${filename}`);
        const compact = stripShaderFormatting(parts.join('\0'), false).split('\0');
        const head = compact[0] === node.head.text ? node.head
          : original(ts.factory.createTemplateHead(compact[0]), node.head);
        const spans = node.templateSpans.map((span, index) => {
          const text = compact[index + 1];
          const literal = text === span.literal.text ? span.literal : original(
            ts.isTemplateTail(span.literal) ? ts.factory.createTemplateTail(text)
              : ts.factory.createTemplateMiddle(text), span.literal);
          return ts.factory.updateTemplateSpan(span, visit(span.expression, true), literal);
        });
        return ts.factory.updateTemplateExpression(node, head, spans);
      }
      return ts.visitEachChild(node, child => visit(child, inShader), context);
    }
    return visit(sourceFile);
  };
}

export function shaderFormattingPlugin() {
  return {
    name: 'mutracer-shader-formatting',
    apply: 'build',
    enforce: 'pre',
    transform(source, id) {
      const filename = id.split('?')[0].replace(/\\/g, '/');
      if (!filename.includes('/src/renderer/') || !filename.endsWith('.ts')) return null;
      const result = ts.transpileModule(source, {
        fileName: filename,
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          useDefineForClassFields: true,
          sourceMap: true,
          inlineSources: true
        },
        transformers: { before: [createShaderFormattingTransformer()] }
      });
      return { code: result.outputText, map: result.sourceMapText };
    }
  };
}
