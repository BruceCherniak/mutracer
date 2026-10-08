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

Use small generated fixtures; do not commit models or images for tests.
