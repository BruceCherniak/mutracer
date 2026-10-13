import ts from 'typescript';
import { createShaderIdentifierMap, readShaderSourceFiles, renameShaderIdentifiers } from './shader-identifiers.mjs';
import { isRendererSource, shaderTemplateLanguage, shaderTemplateParts } from './shader-template-context.mjs';

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
export function createShaderFormattingTransformer(identifiers = new Map()) {
  return context => sourceFile => {
    const filename = sourceFile.fileName.replace(/\\/g, '/');
    if (!isRendererSource(filename)) return sourceFile;
    const original = (replacement, node) =>
      ts.setTextRange(ts.setOriginalNode(replacement, node), node);
    function visit(node, inherited) {
      if (ts.isTaggedTemplateExpression(node)) {
        // glsl reads cooked strings; other tags may inspect raw source.
        if (!ts.isIdentifier(node.tag) || node.tag.text !== 'glsl') return node;
        return ts.factory.updateTaggedTemplateExpression(node, node.tag,
          node.typeArguments, visit(node.template, 'glsl'));
      }
      const isTemplate = ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
      const language = isTemplate && shaderTemplateLanguage(node, sourceFile, inherited);
      if (isTemplate && language) {
        if (ts.isNoSubstitutionTemplateLiteral(node)) {
          // A fragment may be inserted mid-line. Its initial spaces can be
          // required token separators; only remove indentation after newlines.
          const text = renameShaderIdentifiers(stripShaderFormatting(node.text, false), identifiers);
          return text === node.text ? node : original(ts.factory.createNoSubstitutionTemplateLiteral(text), node);
        }
        const parts = shaderTemplateParts(node);
        // Shader source cannot contain NUL. Fail instead of corrupting a template.
        if (parts.some(part => part.includes('\0'))) throw new Error(`NUL in shader template: ${filename}`);
        const compact = renameShaderIdentifiers(stripShaderFormatting(parts.join('\0'), false), identifiers).split('\0');
        const head = compact[0] === node.head.text ? node.head
          : original(ts.factory.createTemplateHead(compact[0]), node.head);
        const spans = node.templateSpans.map((span, index) => {
          const text = compact[index + 1];
          const literal = text === span.literal.text ? span.literal : original(
            ts.isTemplateTail(span.literal) ? ts.factory.createTemplateTail(text)
              : ts.factory.createTemplateMiddle(text), span.literal);
          return ts.factory.updateTemplateSpan(span, visit(span.expression, language), literal);
        });
        return ts.factory.updateTemplateExpression(node, head, spans);
      }
      return ts.visitEachChild(node, child => visit(child, inherited), context);
    }
    return visit(sourceFile);
  };
}

export function shaderFormattingPlugin({ sourceRoot } = {}) {
  let identifiers;
  return {
    name: 'mutracer-shader-formatting',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      const files = readShaderSourceFiles(sourceRoot);
      for (const file of files) this.addWatchFile(file.filename);
      identifiers = createShaderIdentifierMap(files);
    },
    // A graph change can alter names in otherwise unchanged chunks. Re-run the
    // transform for cached renderer modules during production watch builds.
    shouldTransformCachedModule({ id }) {
      return isRendererSource(id.split('?')[0]);
    },
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
        transformers: { before: [createShaderFormattingTransformer(identifiers ??=
          createShaderIdentifierMap(readShaderSourceFiles(sourceRoot)))] }
      });
      return { code: result.outputText, map: result.sourceMapText };
    }
  };
}
