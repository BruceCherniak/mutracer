# MuTracer contributor and agent guide

MuTracer is a browser path tracer published to npm as `@meimu/mutracer`. This file is for
people and coding agents changing the library. For using it, read
[`llms.txt`](./llms.txt) and [`docs/`](./docs).

## Layout

- `src/main.ts`: public API. `src/oidn.ts`: the `@meimu/mutracer/oidn` entry point.
- `src/Renderer.ts`: options, status, scene change detection, denoiser and
  offline rendering.
- `src/scene/`: scene description classes (`Mesh`, `Geometry`,
  `OpenPBRMaterial`, lights, `Camera`, `Texture`).
- `src/renderer/`: backends. `WGPU*` files and `wgsl/` are WebGPU; `WebGL*`
  files and `glsl/` are WebGL 2. Both backends share the CPU-side packing
  (`MergedMaterialData`, `lightSampling`, `bvhAccel`, `prepareMeshBVH`).
  `bvh.worker.ts` and `staticBvhPreparation.ts` prepare static BLASes.
- `src/tinybvh/`: TinyBVH WebAssembly adapter and its checked-in `.wasm`.
- `src/util/`: loaders, Three.js conversion, geometry helpers.
- `examples/`: Vite examples (`npm run dev`). `tests/`: Vitest.
- `viewer/`: React test-drive app (`npm run viewer`). Its dependencies are
  devDependencies and never ship in the npm package.
- `site/`: home page of the deployed site (`npm run site`). `npm run build:site`
  builds it with the viewer and the examples into `dist-site/` for Cloudflare.
- `LICENSES/`, `THIRD_PARTY_NOTICES.md`: third-party attributions.

## Checks

Run before committing:

```bash
npm run typecheck
npm run typecheck:examples
npm run typecheck:viewer
npm run typecheck:site
npm test
```

`npm run build` checks the bundled distribution; `npm run build:lib` builds
`lib/` (the npm entry points) and copies the WebAssembly module.

Unit tests do not cover GPU output. For changes to shaders, sampling or
post-processing, render the examples (or a fixed-seed scene with a fixed
sample count) on a real GPU before and after, and compare
`renderer.readPixels('hdr')` pixels. Test both WebGPU and WebGL 2 (`?webgl`).

## Rules

- Exports from `src/main.ts` and `src/oidn.ts` are public contracts. Keep
  TSDoc with defaults on every public option. Treat renames or removals as
  breaking changes.
- Keep the two backends in sync: a material, light or sampling change usually
  needs both the WGSL and the GLSL implementation. WebGPU-only features must
  fail soft on WebGL.
- Uniform and storage layouts are shared between TypeScript packing and shader
  structs; update both and run the contract tests.
- Write tests for behavior and public contracts (packing, parsing, lifecycle,
  generated shader validity). Do not add tests that only restate source text.
- Use Three.js `GLTFLoader` with `THREESceneSync` in examples and comparisons.
- Keep examples small: procedural or CC0 assets only, no large models.
- Code adapted from another project needs a compatible license, a source
  comment, an entry in `THIRD_PARTY_NOTICES.md` and the license text in
  `LICENSES/`. Do not copy code from sources whose license does not allow
  redistribution under MIT.

## Rendering changes

- Keep correctness fixes even when the visual change is small.
- When matching a reference renderer or paper, treat the reference as the
  behavior contract: align data semantics, pass order, random streams,
  candidate counts, and scene and display settings before judging image
  quality. Diagnose the remaining mismatches instead of withdrawing a
  mechanism the reference uses.
- Removing a rendering algorithm or image-quality mechanism is a maintainer
  decision. Keep the implementation and the A/B evidence, report regressions,
  and leave the decision to the maintainer.

## Documentation

- `README.md` is the overview, `docs/` holds the guides and `llms.txt` is the
  compact usage guide for coding agents. Keep `llms.txt` to one or two lines
  per topic with links into `docs/`.
- Document each behavior in one place and link to it elsewhere: scene update
  rules in `docs/updates.md`, BVH preparation in `docs/bvh.md`, options and
  defaults in TSDoc and `docs/api.md`.
- Order each guide as usage, options, then caveats. Put implementation details
  in a trailing "Implementation notes" section.
- Keep reusable documentation in `docs/`. Do not commit dated experiment logs
  or scene-specific evidence there.

## Commit messages

- For viewer changes, include the `viewer` scope in the commit subject, for
  example `fix(viewer): correct camera controls` or `feat(viewer): add model search`.
- Keep the commit subject concise. Put implementation details, the reason for
  the change, and validation results in the commit body (description).
