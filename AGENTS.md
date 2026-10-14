# MuTracer contributor and agent guide

MuTracer is a browser path tracer published to npm as `@meimu/mutracer`. This file is for
people and coding agents changing the library. For using it, read
[`llms.txt`](./llms.txt) and [`docs/`](./docs).

## Layout

- `src/main.ts`: public API. `src/oidn.ts`: the `@meimu/mutracer/oidn` entry point.
- `src/Engine.ts`: device, committed scene/camera and shared resources.
- `src/Display.ts`: canvas, display settings and image export.
- `src/Render.ts`: independent accumulation, denoising and convergence.
- `src/scene/`: scene description classes (`Mesh`, `Geometry`,
  `OpenPBRMaterial`, lights, `Camera`, `Texture`).
- `src/renderer/`: backends. `WGPU*` files and `wgsl/` are WebGPU; `WebGL*`
  files and `glsl/` are WebGL 2. Both backends share the CPU-side packing
  (`MaterialTable`, `lightSampling`, `bvhAccel`, `prepareMeshBVH`).
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

`npm test` runs only library tests. For viewer changes, also run
`npm run test:viewer` (the independent suite in `viewer/tests/`, using source aliases
without requiring a prior library build).

`npm run build` checks the bundled distribution; `npm run build:lib` builds
`lib/` (the npm entry points) and copies the WebAssembly module.

Unit tests do not cover GPU output. For changes to shaders, sampling or
post-processing, render the examples (or a fixed-seed scene with a fixed
sample count) on a real GPU before and after, and compare
`render.readPixels('hdr')` pixels. Test both WebGPU and WebGL 2 (`?webgl`).

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
- Use Three.js `GLTFLoader` with `THREESync` in examples and comparisons.
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
- Document only what a library user can observe or act on: behavior, cost
  scaling, limits, precision, and when work is copied or rebuilt. Leave out how
  the code achieves it (internal caches, allocation and reuse strategy,
  generated or schema-driven code, internal class and function names,
  optimizations without a user-visible effect). Ask whether a user would write
  different code after reading the sentence; if not, it belongs in a code
  comment or the commit body, not in `docs/`.
- Keep reusable documentation in `docs/`. Do not commit dated experiment logs
  or scene-specific evidence there.

## Multi-session tasks

- A task split across several sessions keeps one progress file beside its plan
  in `plans/`. It is a snapshot of the current state, not a log. It holds only:
  the status of each task with its commit, the remaining work in order, open
  problems and known limitations with their evidence locations, the
  maintainer's current decisions, fixed references (worktree, branch,
  hardware, reference commits), and the handoff the next session needs, each
  written once. Keep it within 150 lines and 15,000 characters.
- When a session ends, rewrite the affected entries in place. Do not append
  per-session narratives, restate rules or authorizations, or keep superseded
  state or withdrawn decisions.
- Put process details, failed attempts, command output, per-image numbers,
  checksums and the reasoning behind each result in that session's evidence
  directory outside the repository, as named by the plan, and link to it from
  the progress file. Durable conclusions belong in `docs/` or the plan.
- A new session reads this file, the plan and the progress file, then starts.
  It looks up evidence directories or archived records only for the specific
  item it needs.

## Commit messages

- For viewer changes, include the `viewer` scope in the commit subject, for
  example `fix(viewer): correct camera controls` or `feat(viewer): add model search`.
- Keep the commit subject concise. Put implementation details, the reason for
  the change in the commit body (description).
