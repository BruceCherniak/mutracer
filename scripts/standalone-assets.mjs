import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build, normalizePath } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tinyBvhSource = normalizePath(path.join(root, 'src/tinybvh/TinyBvhBuilder.ts'));
const wasmSource = path.join(root, 'src/tinybvh/tinybvh.wasm');
const oidnSource = path.join(root, 'src/renderer/oidnNetwork.ts');
const renderSource = normalizePath(path.join(root, 'src/Render.ts'));
const wasmFile = 'assets/tinybvh.wasm';
const runtimeFile = 'assets/oidn-runtime.js';

/** Vite 4 library mode always inlines assets. The main build emits one binary;
 * its worker references that same file, bypassing Vite's asset URL transform. */
export function tinyBvhAssetPlugin({ worker = false } = {}) {
  let reference, fileName, workerAssetsDir;
  return {
    name: 'mutracer-standalone-tinybvh',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) { workerAssetsDir = config.build.assetsDir; },
    buildStart() {
      this.addWatchFile(wasmSource);
      const bytes = readFileSync(wasmSource);
      fileName = wasmFile;
      if (!worker) reference = this.emitFile({ type: 'asset', fileName, source: bytes });
    },
    shouldTransformCachedModule({ id }) { return id === tinyBvhSource; },
    transform(code, id) {
      if (id !== tinyBvhSource) return null;
      const output = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, sourceMap: true, inlineSources: true },
        transformers: { before: [context => source => {
          function visit(node) {
            if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
              && node.expression.text === 'URL' && node.arguments?.length === 2
              && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === './tinybvh.wasm') {
              return ts.factory.updateNewExpression(node, node.expression, node.typeArguments, [
                ...(worker ? [
                  ts.factory.createStringLiteral(path.posix.relative(workerAssetsDir, fileName)),
                  ts.factory.createPropertyAccessExpression(
                    ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('self'), 'location'), 'href')
                ] : [ts.factory.createPropertyAccessExpression(
                  ts.factory.createMetaProperty(ts.SyntaxKind.ImportKeyword, ts.factory.createIdentifier('meta')),
                  `ROLLUP_FILE_URL_${reference}`
                )])
              ]);
            }
            return ts.visitEachChild(node, visit, context);
          }
          return visit(source);
        }] }
      });
      return { code: output.outputText, map: output.sourceMapText };
    },
    resolveFileUrl({ fileName }) {
      if (fileName !== wasmFile) return null;
      return `new URL(${JSON.stringify(fileName)}, __mutracerLibraryUrl).href`;
    }
  };
}

/** UMD cannot split internal modules. Build OIDN as a self-contained ES module
 * and keep Render's existing dynamic import external to the UMD graph. */
export function oidnRuntimePlugin() {
  return {
    name: 'mutracer-standalone-oidn',
    apply: 'build',
    async buildStart() {
      const result = await build({
        configFile: false,
        root,
        publicDir: false,
        logLevel: 'silent',
        resolve: { alias: [{
          find: /^\.\/oidnBundledWeights(?:\.js)?$/,
          replacement: path.join(root, 'src/oidnBundledWeights.cdn.ts')
        }] },
        build: {
          write: false,
          target: 'es2020',
          rollupOptions: {
            input: oidnSource,
            preserveEntrySignatures: 'strict',
            output: {
              format: 'es', entryFileNames: 'oidn-runtime.js', inlineDynamicImports: true,
              banner: '/*! MuTracer: third-party license texts are in THIRD_PARTY_NOTICES.md and LICENSES/. */'
            }
          }
        }
      });
      const output = Array.isArray(result) ? result[0].output : result.output;
      const chunk = output.find(item => item.type === 'chunk' && item.isEntry);
      if (!chunk || output.length !== 1) throw new Error('Expected a self-contained OIDN runtime.');
      for (const filename of Object.keys(chunk.modules)) this.addWatchFile(filename);
      this.emitFile({ type: 'asset', fileName: runtimeFile, source: chunk.code });
    },
    shouldTransformCachedModule({ id }) { return id === renderSource; },
    resolveDynamicImport(specifier, importer) {
      if (importer === renderSource && specifier === './renderer/oidnNetwork.js') {
        return { id: runtimeFile, external: true };
      }
      return null;
    },
    renderDynamicImport({ targetModuleId }) {
      if (targetModuleId !== runtimeFile) return null;
      return { left: 'import(new URL(', right: ', __mutracerLibraryUrl).href)' };
    }
  };
}
