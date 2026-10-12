import path from 'node:path';
import { defineConfig } from 'vitest/config';
import viewerConfig from './vite.config';

export default defineConfig({
  root: path.resolve(__dirname, '..'),
  resolve: viewerConfig.resolve,
  test: {
    environment: 'node',
    include: ['viewer/tests/**/*.test.ts']
  }
});
