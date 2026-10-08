import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // Examples import the package by name, exactly like applications do.
    alias: [
      { find: /^claypt\/oidn$/, replacement: path.resolve(__dirname, 'src/oidn.ts') },
      { find: /^claypt$/, replacement: path.resolve(__dirname, 'src/main.ts') }
    ]
  },
  server: {
    host: true,
    port: 3001
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      name: 'ClayPT',
      fileName: (format: string) => `claypt.${format}.js`
    }
  }
});
