import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  resolve: {
    // Examples import the package by name, exactly like applications do.
    alias: [
      ...(command === 'build' ? [{ find: /^\.\/oidnBundledWeights(?:\.js)?$/, replacement: path.resolve(__dirname, 'src/oidnBundledWeights.cdn.ts') }] : []),
      { find: /^mutracer\/oidn$/, replacement: path.resolve(__dirname, 'src/oidn.ts') },
      { find: /^mutracer$/, replacement: path.resolve(__dirname, 'src/main.ts') }
    ]
  },
  server: {
    host: true,
    port: 3001
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      name: 'MuTracer',
      fileName: (format: string) => `mutracer.${format}.js`
    }
  }
}));
