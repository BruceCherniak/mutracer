import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';

export function stripShaderFormatting(source: string) {
  return source.replace(/\/\/[^\r\n]*/g, '').replace(/^[\t ]+/gm, '');
}

/** Evaluate a separate shader-module graph with formatting stripped from each
 * string/template fragment BEFORE interpolation and variant generation.
 * Ordinary CPU dependencies use their original source. This catches rewrites
 * that silently stop matching when a shader chunk's formatting changes. */
export function shaderSourceLoader(stripFormatting: boolean) {
  const cache = new Map<string, {exports: any}>();
  function load(filename: string): any {
    const cached = cache.get(filename);
    if (cached) return cached.exports;
    const module = {exports: {}};
    cache.set(filename, module);
    const shaderSource = /\/renderer\/(?:wgsl\/|glsl\/|scratchSampling\.ts|(?:WGPUFullQuadPass|WGPUBloomPass|WGPUMinMaxMap)\.ts|webglShaders\.ts|WebGLJNLMDenoiser\.ts|WebGLRayTraceOutputPass\.ts)/.test(filename);
    const transform: ts.TransformerFactory<ts.SourceFile> = context => {
      const visit: ts.Visitor = node => {
        if (ts.isStringLiteral(node)) return ts.factory.createStringLiteral(stripShaderFormatting(node.text));
        if (ts.isNoSubstitutionTemplateLiteral(node)) return ts.factory.createNoSubstitutionTemplateLiteral(stripShaderFormatting(node.text));
        if (ts.isTemplateHead(node)) return ts.factory.createTemplateHead(stripShaderFormatting(node.text));
        if (ts.isTemplateMiddle(node)) return ts.factory.createTemplateMiddle(stripShaderFormatting(node.text));
        if (ts.isTemplateTail(node)) return ts.factory.createTemplateTail(stripShaderFormatting(node.text));
        return ts.visitEachChild(node, visit, context);
      };
      return node => ts.visitNode(node, visit) as ts.SourceFile;
    };
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
      transformers: stripFormatting && shaderSource ? {before: [transform]} : undefined
    }).outputText;
    const require = (specifier: string) => specifier.startsWith('.')
      ? load(resolve(dirname(filename), specifier.replace(/\.js$/, '.ts')))
      : createRequire(filename)(specifier);
    runInThisContext(`(function(require, module, exports) {\n${code}\n})`, {filename})(require, module, module.exports);
    return module.exports;
  }
  return (relativePath: string) => load(resolve(process.cwd(), relativePath));
}
