# Tests

```bash
npm test                                   # all tests
npm test -- tests/unit/geometry.test.ts    # one file
```

- `unit/`: scene primitives, geometry helpers, BVH construction, light and
  material packing, sampling, shader-cache keys, WGSL validity of generated
  shaders, renderer lifecycle and denoiser setup.
- `integration/`: loaders run on small in-memory fixtures.

Tests run in Node without a GPU. They check behavior and contracts, not image
quality. Check GPU output separately by rendering the examples, or a fixed
scene with a fixed sample count, before and after a change (see
[`AGENTS.md`](../AGENTS.md#checks)).

`npm run dev` also serves [`gpu/jnlm.html`](./gpu/jnlm.html). Open
`http://localhost:3001/tests/gpu/jnlm.html` in a browser with a real WebGPU
adapter. It runs the actual WebGPU and WebGL 2 denoising passes on deterministic
fixtures, checking noise reduction, bright and dark texture contrast, normal
detail, and coverage edges. These tests are separate from the Node test suite.

[`gpu/progressiveRendering.html`](./gpu/progressiveRendering.html) measures ten
preview/final round trips after warming both targets. It counts WebGPU
`createTexture` / `createBuffer`, or WebGL `createTexture` / `createFramebuffer`
with `?webgl`, and records `presentedTarget` / `presentedComplete` per frame.
Preview resolution is held fixed during this probe; adaptive preview rebuilding
is checked separately. The reusable `measureProgressiveSwitches` helper can also
be run against each example's scene and camera. HDR equivalence requires a
separate fixed-resolution, fixed-spp `renderOfflineFrame` / `readPixels('hdr')`
comparison against pixels captured before a refactor.

Use small generated fixtures; do not commit models or images for tests.
