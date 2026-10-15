/// <reference path="./browser-types.d.ts" />

// Keep both published entry points in the compilation graph. This is an
// analysis entry, not a claim that the browser/GPU host is implemented.
export * from '../src/main.js';
export * from '../src/oidn.js';
