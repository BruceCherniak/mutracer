# Contributing

Use Node 22 or later (`.nvmrc` pins 24, the current LTS) and install
dependencies with `npm install`.
Run `npm run dev` for examples, `npm run viewer` for the test-drive app, or
`npm run site` for the home page.

Before submitting a change, run:

```bash
npm run typecheck
npm run typecheck:examples
npm run typecheck:viewer
npm run typecheck:site
npm test
```

For distribution changes, also run `npm run build`, `npm run build:lib` and
`npm pack --dry-run`.

Tests cannot verify GPU output. For shader, sampling or post-processing changes,
render a fixed-seed scene with a fixed sample count before and after on a real
GPU. Compare `renderer.getRawOutput()` pixels on both WebGPU and WebGL 2
(`?webgl` where supported), and report validation errors or visual regressions.

See [AGENTS.md](./AGENTS.md) for contributor rules, public API contracts,
backend parity, attribution and commit guidance.
