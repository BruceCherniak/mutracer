import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import { createShaderFormattingTransformer } from '../../scripts/shader-formatting.mjs';
import { loadShaderIdentifierMap } from '../../scripts/shader-identifiers.mjs';
export { stripShaderFormatting } from '../../scripts/shader-formatting.mjs';
export const shaderIdentifierMap = loadShaderIdentifierMap();

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
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
      transformers: stripFormatting ? {before: [createShaderFormattingTransformer(shaderIdentifierMap)]} : undefined
    }).outputText;
    const require = (specifier: string) => specifier.startsWith('.')
      ? load(resolve(dirname(filename), specifier.replace(/\.js$/, '.ts')))
      : createRequire(filename)(specifier);
    runInThisContext(`(function(require, module, exports) {\n${code}\n})`, {filename})(require, module, module.exports);
    return module.exports;
  }
  return (relativePath: string) => load(resolve(process.cwd(), relativePath));
}
