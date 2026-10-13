import path from 'node:path';
import { defineConfig } from 'vite';
import { shaderFormattingPlugin } from './scripts/shader-formatting.mjs';

export default defineConfig(({ command }) => ({
  plugins: [shaderFormattingPlugin()],
  // Keep the standalone library's Worker relative to the script on any host.
  base: './',
  experimental: {
    renderBuiltUrl(filename, { hostType }) {
      if (hostType === 'js' && filename.includes('bvh.worker-')) {
        return { runtime: `new URL(${JSON.stringify(filename)}, __mutracerLibraryUrl).href` };
      }
      return { relative: true };
    }
  },
  resolve: {
    // Examples import the package by name, exactly like applications do.
    alias: [
      ...(command === 'build' ? [{ find: /^\.\/oidnBundledWeights(?:\.js)?$/, replacement: path.resolve(__dirname, 'src/oidnBundledWeights.cdn.ts') }] : []),
      { find: /^@meimu\/mutracer\/oidn$/, replacement: path.resolve(__dirname, 'src/oidn.ts') },
      { find: /^@meimu\/mutracer$/, replacement: path.resolve(__dirname, 'src/main.ts') }
    ]
  },
  server: {
    host: true,
    port: 3001
  },
  build: {
    rollupOptions: {
      output: {
        banner: "/*! MuTracer: third-party license texts are in THIRD_PARTY_NOTICES.md and LICENSES/. */\nvar __mutracerLibraryUrl = typeof document !== 'undefined' ? (document.currentScript && document.currentScript.src || document.baseURI) : (typeof location !== 'undefined' ? location.href : undefined);"
      }
    },
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      name: 'MuTracer',
      // npm's ESM entry is lib/main.js; dist only supplies the CDN global build.
      formats: ['umd'],
      fileName: (format: string) => `mutracer.${format}.js`
    }
  }
}));
