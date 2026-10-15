// Type information only. Native hosts must implement browser/GPU operations;
// these declarations do not provide a runtime or make those operations native.
/// <reference path="../node_modules/typescript/lib/lib.dom.d.ts" />
/// <reference path="../node_modules/typescript/lib/lib.dom.iterable.d.ts" />
/// <reference types="@webgpu/types" />

interface ImportMeta {
  readonly url: string;
}
