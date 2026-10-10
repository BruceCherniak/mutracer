import path from 'node:path';
import { defineConfig } from 'vite';

const repoRoot = path.resolve(__dirname, '..');

/** The home page. `npm run build:site` builds it together with the viewer and the examples. */
export default defineConfig({
  root: __dirname,
  base: './',
  server: {
    host: true,
    port: 3013,
    fs: { allow: [repoRoot] }
  },
  build: {
    outDir: path.join(repoRoot, 'dist-site'),
    emptyOutDir: true,
    target: 'es2022'
  }
});
