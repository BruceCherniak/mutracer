# Native contributor guide

This guide covers building, validating and maintaining the native SDK and viewer.
Per-call and per-field API details belong on the declarations (C headers and
Rust doc comments); workflows, behavior across calls, costs and limits belong in
[README.md](README.md) and [docs/](docs). License notices are separate for the
[native library](THIRD_PARTY_NOTICES.md) and the
[viewer](viewer/THIRD_PARTY_NOTICES.md).

## Layout

- `src/`: TypeScript AOT entry points, runtime adapters and shader generators.
- `host/src/`: Rust library; `host/diagnostics/`: standalone diagnostic
  executables and shaders; `host/fuzz/`: fuzz targets.
- `include/`: public C headers; `schemas/`: frozen wire-property IDs and error
  codes.
- `docs/`: user guides and the scene format reference.
- `scripts/`: compiler lowering, contract generators, CI and viewer packaging.
- `examples/`: C consumers and validation hosts; `tests/`: AOT fixtures and the
  C module test harness.
- `validation/`: render and contract checks and browser reference tools;
  `validation/compiler/` holds whole-browser-API and async compilation probes.
- `benchmark/`: performance and correctness comparisons.
- `viewer/`: standalone app; `toolchain/`: pinned compiler; `LICENSES/`:
  license texts.

## Setup

```bash
npm ci
npm ci --prefix native/toolchain --include=optional
export MUTRACER_SCRIPTC="$(node native/toolchain/compiler.mjs)"
export MUTRACER_NATIVE_OUTPUT=/absolute/evidence/directory
```

- Use scriptc 0.4.4, Rust with locked dependencies and a C++20 compiler. Root
  Web dependencies do not include the compiler; `toolchain/compiler.mjs`
  resolves the platform package and restores its executable permissions.
- Keep `MUTRACER_NATIVE_OUTPUT` outside the checkout.
- For direct Cargo builds, run `npm run fetch:tinybvh` to
  [prepare the headers](../src/tinybvh/CONTRIBUTING.md#preparing-headers) and
  set `MUTRACER_AOT_ARCHIVE` to the built archive.
- **Use separate `CARGO_TARGET_DIR` values for the `host` and `viewer`
  manifests.** Their different wgpu feature graphs can otherwise overwrite the
  host's unhashed multi-crate-type rlib and produce incompatible wgpu crates.
- Run rustfmt before committing Rust.

### Windows

Windows builds use the x64 MSVC Developer environment, Windows SDK, Rust's
`stable-x86_64-pc-windows-msvc` toolchain and Zig 0.15.2 for scriptc's archiver.
C/C++ consumers compile with `/MD`; no MinGW CRT or GCC C++ runtime is linked.

The scriptc 0.4.4 runtime pack still imports several GNU-compatible interfaces.
`windows-msvc-archive.mjs` edits only MuTracer's generated COFF archives: it
maps constructor sections to `.CRT$XCU`, uses MSVC's stack probe, and prefixes
runtime compatibility imports to avoid collisions with the independently linked
OIDN core. An appended, MSVC-compiled `windows-msvc-compat.c` object implements
those imports with UCRT and Win32. The installed runtime pack remains unchanged.

### Linux

Linux builds need a C++20 compiler, patchelf for the shared SDK, and the X11/Wayland
development libraries installed by the CI workflow. GPU package checks also
need `xvfb-run`.

## Commands

| Command | GPU | Checks |
| --- | --- | --- |
| `npm run native:ci` | No | Rust CPU suites, C picking consumer, AOT module/storage contracts and `native:scene:static` |
| `npm run native:ci:gpu` | Yes, with ray queries | `native:ci` plus GPU tests and packaged-app checks; run before a native release |
| `npm run native:ci:hosts` | Yes, with ray queries | `native:ci:gpu` plus the C hosts at 8 samples |
| `npm run native:scene` | Yes | Builds the AOT archive and library; verifies preparation and rendering on 33 fixtures |
| `npm run native:scene:static` | No | The same build with descriptor, packet, resource and WGSL contracts, without rendering |
| `npm run native:context`, `native:jobs`, `native:camera`, `native:settings`, `native:engine` | Yes | One C host each: retained scenes, polling and cancellation, camera updates, render settings, engine API |
| `node native/validation/scene-api-render.mjs` | Yes | C ABI, selected adapter, scene handles, exact AOV readback and custom-filter snapshots |
| `node native/validation/vulkan-render.mjs` | Yes | C Vulkan device negotiation/import, queue/image leases, host copies, post-processing and retirement, on Software and HWRT |
| `npm run native:modules:verify`, `native:storage:verify` | No | AOT module and storage contracts |
| `node native/validation/matrix-verify.mjs`, `vector-verify.mjs` | No | Precision checks |
| `npm run native:viewer:build` | No | Full AOT graph and platform app |
| `npm run native:viewer:package` | No | Archives the app, extracts it elsewhere and checks the sample and linked denoising runtime |
| `npm run native:viewer:package -- --gpu` | Yes | Also checks rendering, all AOVs and real-window startup |
| `npm run native:sdk:package` | No | Packages the SDK and checks C linking |
| `npm run native:check` | No | Compiler capability probe; reports the incomplete browser API port and exits with status 1 |

- The host commands build on `native:scene`, and `native:engine` chains the
  other four. Each rebuilds and rerenders its whole chain; prefer the focused
  checks below during local iteration.
- Before final native review, run the root typechecks, library and viewer tests,
  `npm run build` and the applicable native CI gate below. `native:ci` already
  runs both Rust CPU suites, `native:modules:verify` and `native:storage:verify`;
  do not repeat those separately on unchanged inputs. Compilation does not
  validate GPU output.

### Iteration

With `MUTRACER_AOT_ARCHIVE` set to a current built archive and separate persistent
host/viewer Cargo targets, run the affected Rust tests directly:

```sh
cargo test --locked --manifest-path native/host/Cargo.toml --lib TEST_FILTER
cargo test --locked --manifest-path native/viewer/Cargo.toml TEST_FILTER
```

Set `CARGO_TARGET_DIR` to the appropriate target before each command. Reuse it
across edits instead of creating a fresh target for each check. A changed AOT
input requires rebuilding the archive before testing its consumers. For a
compile-only check use `cargo check`; a subsequent `cargo test` already checks
compilation, so running both on unchanged inputs is unnecessary.

Run an affected GPU test directly with `-- --ignored --nocapture` while iterating
on rendering. Keep GPU work sequential. Run the applicable full `native:ci`,
`native:ci:gpu` or `native:ci:hosts` gate for the completed change; repeat it after
changes to inputs it validates, rather than after every intermediate edit.
Filtered Rust tests do not replace the final AOT, C consumer or GPU validation.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `MUTRACER_SCRIPTC` | scriptc 0.4.4 executable |
| `MUTRACER_NATIVE_OUTPUT` | Output and evidence directory |
| `MUTRACER_AOT_ARCHIVE` | Archive for direct Cargo builds |
| `MUTRACER_NATIVE_SAMPLES` | Fixture sample count; byte comparisons across stages need the same count and seed |
| `MT_LOOP_ITERATIONS`, `MT_LOOP_BATCHED`, `MT_LOOP_L0`, `MT_LOOP_REAL_CAP` | [HWRT loop test](#metal-hwrt-sample-miss) |
| `MUTRACER_TEST_CAPTURE` | Saves mismatching AOVs, descriptors and per-pixel audits |
| `MUTRACER_TEST_ADAPTER` | Explicit adapter index for `scene-api-render.mjs` and Rust AOV GPU tests; enumerate with the `adapter-validation` host example |
| `MUTRACER_VULKAN_INCLUDE` | Vulkan SDK include directory for `vulkan-render.mjs`; otherwise uses `VULKAN_SDK/Include` |
| `MUTRACER_OIDN_LIBRARY` | Optional external OIDN for Rust SDK tests |
| `MUTRACER_TEST_OIDN_CUDA`, `_HIP`, `_NO_GPU` | [OIDN backend requirements](#oidn) |
| `MUTRACER_KERNEL_FIXTURES` | [Native kernel](#shared-source-and-typed-resources) byte comparisons |
| `MUTRACER_NATIVE_PROFILE=1` | [Preparation profile](#performance) on stderr |
| `MUTRACER_GLTF_EVIDENCE` | glTF material fixture and native values for `validation/gltf-material-reference.mjs` |
| `MUTRACER_ANIMATION_EVIDENCE` | Animation test fixtures, poses, images and report |
| `MUTRACER_TEST_VULKAN_LIBRARY` | Optional Vulkan driver/loader library for the interop GPU test |
| `MUTRACER_VIEWER_METRICS` | [Real-window viewer metrics](#viewer) |
| `MUTRACER_NATIVE_GUI_SMOKE=1` | Same as `native:viewer:package -- --gpu` |

## CI and releases

`native:ci` validates CPU behavior and static shader contracts without creating
a GPU device. Rust's default suites ignore device-dependent tests; the CPU suite
still parses, validates and emits SPIR-V/HLSL with Naga for the generated
software and hardware WGSL. Reports mark GPU rendering and windows as
**not validated**. Finding a software adapter cannot turn CPU checks into a
rendering gate.

`native:ci:gpu` adds the ignored host GPU tests, animated-pose rendering, all 33
rendered fixtures, ray-query execution, the `viewer/examples/surface.rs` window,
HDR negotiation and lifecycle smoke, and the packaged render/AOV and
window-startup checks. Software or unknown adapters and missing ray-query
support are errors. GitHub-hosted CI does not run it.

- Each ignored host test runs in its own process. Other failures stop CI after
  all ignored tests finish.
- On hardware Metal, the known image mismatches in
  `hardware_renders_match_fresh_l0_contexts`,
  `hardware_shared_scene_renders_match_fresh_l0_contexts` and
  `hardware_loop_against_fresh_l0_contexts` are reported without stopping CI
  and leave `gpu.validated` false.
- The incremental oracle reports full-reference render errors as skipped cases;
  any skip leaves `gpu.validated` false. Review those records before a release.
- `native:ci:hosts` reuses the GPU run's fixtures, archive and Cargo target. C
  engine HWRT differences are counted in `gpu.cHosts.hardwareDifferences`, leave
  `gpu.validated` false, and keep per-fixture records and logs in `hosts/`.
- The engine host compares every image with a fresh context in the same
  process: Software must match byte for byte; HWRT differences are counted in
  `engine-verification.json`.
- CPU-only module and viewer builds run beside the GPU steps; step durations are
  recorded in `checks.json`.

The GitHub Actions `CI` workflow runs on pull requests, pushes to `main` and
`dev`, and manual dispatch. It validates CPU and static contracts and builds the
SDK and viewer for macOS arm64, Linux x64 and Windows x64, including oidn-webgpu
and licenses.

- Artifacts `native-macos-arm64`, `native-linux-x64` and `native-windows-x64`
  hold the app and SDK archives and SHA-256 checksums for 14 days;
  `native-PLATFORM-symbols` holds the separate SDK debug material for 14 days;
  `native-PLATFORM-diagnostics` keeps logs and check summaries for 7 days,
  including failed runs.
- Manual dispatch builds all three platforms by default (`release`);
  `native_platform` selects one for diagnosis and never publishes a release.
- Pushing a `native-v*` tag (for example `native-v0.1.0`) runs the same checks
  and, after the Web and native jobs pass, publishes the macOS and Linux
  app, SDK and separate symbol archives and checksums to that tag's GitHub
  Release. Tags with a suffix such as `-rc.1` create prereleases. Native
  releases never become the repository's latest release, and rerunning a tag
  replaces matching assets. Publishing uses
  `GITHUB_TOKEN` with `contents: write`.
- The macOS app is ad-hoc signed and not notarized.

### SDK release artifacts

After `native:ci`, run `native:sdk:package` with the same
`MUTRACER_NATIVE_OUTPUT` and its `CARGO_TARGET_DIR=.../host-target`.
For `native:scene:static` outputs, the default `.../cargo-target` applies.
`MUTRACER_NATIVE_DIST` selects the archive destination. Packages contain C headers
and shared/static libraries; debug symbols are archived separately in
`sdk-symbols/`. Packaging checks API availability and C linking without a GPU;
rendering still requires `native:ci:gpu` validation.

## Architecture

### Runtime, ownership and errors

- C context and job calls may come from any thread. Short registry operations
  serialize, and overlapping calls may return busy. A full commit builds its
  candidate outside the registry lock, so the old scene keeps rendering and
  polling.
- A process-wide dedicated worker owns the AOT runtime and its preparation
  roots. Copy AOT results before reset or collection, and initialize the module
  once. There is no dynamic-unload shutdown for that worker.
- A commit token identifies cancellation and publication. Cancel drains the
  current preparation step; destroy waits until the candidate's roots and
  resources retire. A candidate keeps its GPU resources until publication, and
  rejection preserves the old scene, settings and samples. Publication cancels
  and drains old render work. Incremental updates reject active jobs and pending
  full commits.
- Handles are monotonic, with no fixed context cap. Two resource generations
  and at most 32 pipeline variants coexist; keep commits transactional when
  changing that retention.
- TS errors carry an operation code and message in a bounded UTF-8 packet that
  Rust validates. Caught Rust panics mark the touched context failed while
  guards stay alive, avoiding poisoned locks; a successful full commit recovers.
  AOT OOM and abort traps terminate the process.
- Logs go through `mutracer-log.h` and are silent by default; standalone Rust
  tools enable stderr logging explicitly.

### Public headers and layouts

`include/` is the supported C API, except `mutracer-debug.h`, which holds
validation-only entry points. The layout generator writes caller-facing
descriptor offsets to `include/mutracer-layout.h`, and host records, resource IDs
and shader layouts to the uninstalled `src/mutracer-internal-layout.h`. The
hand-written structs in `include/mutracer-scene.h` assert their offsets against
the generated header, so a schema change that resizes a record or moves a
checked field fails to compile until the structs and `docs/scene-format.md` are
updated.

### Shared source and typed resources

Production rendering accepts only version-4 raw descriptors. The
validation-only Web oracle records writes through
`validation/resource-recorder.mjs`; production never reads those captures.

Shared TypeScript owns scene decoding and assembly, material, light and
environment packing, render settings, layouts, shader generation and
incremental preparation. The host uses typed resource IDs, texture formats,
layout entries and pipeline keys.

- After schema edits, update `scripts/generate-layout-schema.mjs`; its `--check`
  runs with typecheck.
- Material wire IDs in `schemas/material-properties.json` are frozen. Regenerate
  with `scripts/generate-material-properties.mjs` without renumbering.
- `scripts/storage-lowering.mjs` instantiates numeric generics and nested
  closures without changing arithmetic or control flow;
  `scripts/attribute-lowering.mjs` lowers proven concrete accesses;
  `scripts/vector-lowering.mjs` specializes shared math storage. The
  numeric-access report traces the production graph and rejects loop storage
  dispatch. Open unions, ordinary arrays and callbacks keep fallback
  implementations. Keep emitted compiler inputs separate from browser source.
- Bounds and generated tangents are the two native O(N) kernels; all other scene
  logic stays TS. Tangent normalization uses compiled TS `Math.hypot` to keep
  rounding. With `MUTRACER_KERNEL_FIXTURES=/absolute/manifest.json`, host tests
  compare kernel packets and production resources with compiled TS byte for
  byte. Qualify a replacement kernel on complex scenes and the same concrete
  specialization, not combined generic variants or procedural fixtures.
- The optional MaterialTable whole-module probe has known compiler blockers;
  all 14 required modules must build and verify.

### Engine API

The Rust `api` module commits each engine's scene once to an L0 context through
the crate-internal `CommitPath`: incremental on the calling thread, full
preparation on a library thread. Each render's L0 context is a target linked to
that scene (`context::set_target`), with camera and trace uniforms from the
`sceneTargetParameters` AOT entry, its own accumulation and, for another
sampling pattern or bevel sample count, its own shader variant. Every scene
publication drains linked targets and sets them again.

Tests compare every render's HDR, normal and albedo with a fresh L0 context
given the same overridden descriptor, settings and sample count, byte for byte
on Software. The HWRT variant is `--ignored` while the
[Metal sample miss](#metal-hwrt-sample-miss) is open. With
`MUTRACER_OIDN_LIBRARY` set, converged OIDN is compared with direct CPU
filtering of the same inputs.

### Incremental preparation

The staged TS adapters reuse the original camera math, material repacking,
environment distributions, light PMFs and emissive caches. Acknowledge candidate
state only after layout validation and GPU upload or reset. Transform and vertex
edits must use the latest accepted source state; reject unsupported shape or
shader-stack changes with a full-commit requirement. Keep shared tuple storage
when scriptc copies Map-indexed records.

### HWRT

HWRT uses authoritative hardware hits. Assert the actual backend after every
commit; a software fallback never counts as hardware success. All
acceleration-structure build paths submit BLASes and wait for completion
**before encoding TLAS construction**, because Metal's indirect instance
descriptors and empty HAL barriers make one encoder insufficient. This wait has
not fixed the [sample miss](#metal-hwrt-sample-miss). `PreferUpdate` is not a
refit; HAL refit stays opt-in and must keep its thread and resource lifetime
assumptions.

### TinyBVH

Raw scene commits and transform/vertex TLAS updates use the official TinyBVH
headers pinned in `src/tinybvh/upstream.json` (1.9.1, the same revision as Web;
all six cached headers are unmodified). The host compiles the browser's C++
wrapper directly. Keep pointer-width-safe result addresses and
`-ffp-contract=off` for conservative float bounds. See the
[adapter contributor guide](../src/tinybvh/CONTRIBUTING.md) for Wasm rebuilds
and CWBVH conversion.

- Native builds enable ARM NEON/Bonsai construction and upstream workers, with
  aligned float4 vertices kept through serialization. Web uses its scalar Wasm
  build and browser worker pool. Spatial splits are off natively, matching the
  browser default. Small BVHs stay on the calling thread.
- Stable-topology BLAS refits still use the TS `updatePreparedGeometries`; the
  TS SAH builder remains for browser fixtures and legacy stateless AOT
  comparison exports.
- The synchronous AOT steps return geometry, displacement and AABB jobs, keep
  source state across arena resets, and consume the host's BVH2 results.
- The 1.9 process-wide worker pool survives host threads and joins at shutdown.
  On Windows, a generated header copy skips pool cleanup after DLL process
  termination has stopped the other threads; static-executable teardown and
  explicit shutdown still join. Native CI checks DLL exit without a GPU.
- The license belongs in `native/LICENSES/` and is copied into the app bundle.

Check host exit, explicit shutdown, restart and process exit with
ThreadSanitizer:

```sh
c++ -std=c++20 -O1 -g -fsanitize=thread -ffp-contract=off \
  -I "$(node scripts/fetch-tinybvh.mjs)" native/host/tinybvh.cpp \
  native/tests/tinybvh-thread-exit.cpp -o /tmp/mutracer-tinybvh-thread-exit
TSAN_OPTIONS=halt_on_error=1 /tmp/mutracer-tinybvh-thread-exit
```

Compare native and Wasm builds on identical inputs, including degenerate
triangles and every displacement projection. SIMD/Bonsai and scalar builds can
choose different trees: validate primitive identity, conservative bounds and GPU
output, and compare bytes only between matching builder configurations. Full
and incremental results must agree on HDR, normal and albedo, survive failed
candidates and other contexts, and keep the HWRT identity mapping after TLAS leaf
reordering. Switching builders can change leaf order, packed displacement
heights and output; archive those differences rather than claiming pixel parity.

### Viewer

`npm run native:viewer:build` builds the full AOT graph and app with locked
dependencies. eframe/egui-wgpu and tracing share one adapter, device and queue.
`src/display-shader.ts` generates the display WGSL through the Web generator;
`scripts/generate-display.mjs --check` detects stale output.

- Preview capture, tone mapping, denoising and presentation stay on the GPU;
  export reads pixels back.
- The viewer renders through `api::Engine::on_device`, a `RenderLoop` with its
  default preview, and the engine `Display`. Descriptor assembly and full
  preparation run off the UI thread.
- New input waits until the selected channel's batch in flight is collected and
  shown (`Render::collect`) and while a full preparation runs, so held edits
  keep updating without cancelling preparations.
- Native queue submissions pause outside the UI callback so eframe can
  reconfigure the shared surface; CPU preparation continues.
- The immutable picking BVH is built on a worker while a model loads. Autofocus
  uses it, with no GPU readback or alpha-texture inspection.
- The viewer uses the published `oidn-webgpu-native = 0.1.1` Rust crate on the
  rendering device. Cargo verifies and links its bundled platform core; no
  upstream checkout, planner build or private FFI is needed. The adapter follows
  `native/README.md` upstream: load a Model, create a checked Denoiser, prepare
  host buffers, then encode into the host's command encoder. `denoise.rs` and
  `mt_denoiser_*` retain the optional caller-supplied OIDN SDK path. The Windows build uses the published MSVC core.

## Validation

Keep raw images, failure samples, hashes, logs and experiment reports outside
the repository.

### GPU output

Compare fixed-seed HDR, normal and albedo on real GPUs for both browser backends.
Use the independent high-sample Software reference for image statistics. When
statistics exceed the gate, find the first differing hit and path event; report
edge and tie cases and reject unexplained differences. Displacement random
streams depend on traversal order.

### Context, jobs and incremental commits

- `native:camera` compares six camera records on every fixture.
- `native:jobs` checks queued, running, cancelling, cancelled and completed
  states, completed-sample accounting, stale handles and accumulation
  equivalence. Poll submits at most one bounded batch and never waits for the
  GPU; callbacks only update owned completion flags.
- Test arbitrary calling threads, cancel and destroy during preparation, failed
  commit rollback and continued rendering of the previous scene.
- Use ThreadSanitizer and state which Rust/C++ dependencies it instruments; AOT,
  Metal and OIDN are outside that coverage.

### Viewer

The packaged executable accepts these smoke modes. GPU modes require actual
HWRT where noted and compare against fresh contexts on Software and HWRT.

| Flag | Checks |
| --- | --- |
| `[MODEL] --package-smoke DIR` | Portable CPU package |
| `--startup-smoke REPORT.json` | Opens a window, resizes it and presents frames; the report must confirm success |
| `[MODEL] --smoke-out DIR` | Load and render, editing, cancellation, HDR environments, backend assertions and native denoising (actual HWRT) |
| `--interaction-smoke DIR` | Continuous camera and held edits, retained previews, resize, stale-denoise rejection |
| `--material-smoke`, `--environment-smoke`, `--light-smoke`, `--transform-smoke`, `--geometry-smoke DIR` | Incremental commits against full preparation |
| `--parity-smoke DIR` | Camera and render settings against fresh contexts, retention after edits and backend replacement, display controls, transparent PNG, denoising alpha and guide channels |
| `--texture-smoke DIR` | All nine S/T wrap combinations and negative, zero and large repeats (needs an imported texture) |
| `--texture-editor-smoke DIR` | Shared material presets; upload, replacement, removal and sampling of all nine slots, including displacement scale and bias |
| `--studio-smoke DIR` | Rect lights against `node native/validation/viewer-studio-reference.mjs DIR` output; preset and parameter edits |
| `--focus-smoke DIR` | Autofocus against `node native/validation/viewer-focus-reference.mjs DIR` output: depth clusters, focus pulls, opaque geometry, stale queries, misses, manual overrides, orthographic views, all three AOVs, invalid input, rollback |
| `[MODEL] --edit-bench DIR` | Descriptor build and commit times of material, transform, camera, light and environment edits at 1280×720 on both backends, through a bare L0 context (`"path": "l0"`) and the engine (`"path": "l1"`), in `edit-bench.jsonl` |

The packaging script sets `MUTRACER_NATIVE_GPU_VALIDATION=1` only in its GPU
mode. Run the ignored `live_polyhaven_catalog_and_texture_download` test to
check the live Poly Haven service, and the ignored animation test with the
archive and viewer Cargo target configured:

```sh
cargo test --release --locked --manifest-path native/viewer/Cargo.toml \
  gpu_animated_poses -- --ignored --nocapture
```

It compares animated HDR, normal and albedo with fresh scenes on Software and
actual HWRT, then exercises playback, pause, seeking and clip switching.

Headless smokes do not cover file dialogs, panel changes, orbit/pan/zoom/fit,
pause/restart, resolution/exposure and PNG export; check those in the real
window. `MUTRACER_VIEWER_METRICS=/absolute/result.json` runs a 1280×720
real-window interaction and three-full-commit sequence, reports UI, picking and
frame intervals, and closes. Use the LEGO model, keep the Mac unlocked and
thermally nominal, and keep outliers.

To validate a package, copy the app to a new location and run all demo models
and Sponza without Node or build paths; inspect dependencies, licenses and the
signature.

### OIDN

Check CPU, Metal, CUDA, HIP and Auto; malformed inputs; rollback; in-place
output; and arbitrary calling threads. Set `MUTRACER_OIDN_LIBRARY` for the Rust
SDK tests.

- `MUTRACER_TEST_OIDN_HIP=1` (or `_CUDA=1`) on a supported machine requires that
  backend to run and asserts it.
- To require CPU fallback and explicit GPU rejection, set
  `MUTRACER_TEST_OIDN_NO_GPU=1` with `OIDN_DEVICE_METAL=0`,
  `OIDN_DEVICE_CUDA=0` and `OIDN_DEVICE_HIP=0`, and leave the GPU requirement
  flags unset.

### Robustness and fuzzing

Caught TypeScript exceptions must keep their operation code and message across
the packet boundary; test with the actual AOT archive, not JavaScript alone.
Fatal AOT traps abort the process, so fuzz in a separate process.

With nightly Rust and cargo-fuzz, set `MUTRACER_AOT_ARCHIVE` and a
`CARGO_TARGET_DIR` outside the checkout. Generate a seed with
`cargo run --manifest-path native/host/Cargo.toml --features fuzzing --bin fuzz-seed -- SEED_PATH`,
put it and small descriptor fixtures in external corpus directories, and run
each target for at least 30 minutes:

```sh
cargo +nightly fuzz run --fuzz-dir native/host/fuzz validate CORPUS_VALIDATE -- \
  -max_total_time=1860 -max_len=65536 -artifact_prefix=ARTIFACT_DIRECTORY/
cargo +nightly fuzz run --fuzz-dir native/host/fuzz commit CORPUS_COMMIT -- \
  -max_total_time=1860 -max_len=65536 -artifact_prefix=ARTIFACT_DIRECTORY/
```

The `commit` target needs a real adapter and checks both backends with bounded
dimensions, geometry and displacement work. Rust AddressSanitizer does not
instrument the scriptc archive or system drivers; report instrumentation
boundaries, and compile C++ separately with a compatible sanitizer before
claiming C++ coverage. Keep failing inputs, logs, the exact toolchain and hashes.

### C window consumer

On macOS, build the host cdylib with the current archive and run the C consumer
(AppKit glue is in `examples/window-appkit.m`):

```sh
node native/scripts/window-host.mjs /absolute/libmutracer_native_probe.dylib \
  /absolute/scene-input.bin /absolute/evidence/c-window
```

It opens a real window, presents through the C SDK and checks suspension,
resize, detach and reattach, clear and reload, diagnostics, callbacks and final
callback release. It needs an unlocked desktop and does not cover the Windows
and Linux handle paths; keep its report separate from the Rust surface gate.

## Performance

`MUTRACER_NATIVE_PROFILE=1` reports validation, source preparation, BLAS/TLAS,
composition, GPU setup and pipeline time (a subset of setup). Full-commit wall
time also includes flush, publication and retirement. Timestamp profiling is
separate from formal timing:

- Metal pass timestamps measure kernels. Acceleration-structure
  `completedWallMs` is wall time after earlier uploads drain, not a GPU
  timestamp. Invalid or missing timestamps produce a diagnostic and a missing
  measurement; rendering continues.
- Upload payload counts come from the write calls, separate from buffer
  capacity and acceleration-structure storage.
- Native peak RSS and the browser JS heap are different metrics.
- `prepare-diagnostics INPUT OUTPUT BACKEND ITERATIONS` profiles CPU-only
  preparation. `nativeGeometryKernelProfile` separates kernel bodies; its time is
  already part of preparation.

### Native versus Web rendering

```sh
node native/benchmark/benchmark.mjs --manifest /absolute/inputs.json \
  --library /absolute/libmutracer_native_probe.dylib --output /absolute/evidence --port 4201
```

- The manifest fixes raw descriptors, checksums and the expected backend and
  reason; the harness freezes binaries, bundles and configuration.
- Measure performance on complex models only; procedural fixtures are
  correctness checks. Web requests 1080 rows but renders 1088; compare requested
  sizes without rescaling.
- Use caffeinate with an unlocked display and wait for `thermalState=0` before
  each group. Default one round: Web and HWRT render six times and discard the
  first; Software renders once for bytes, without timing or GPU profiling; HWRT
  profiles twice after formal output is saved. Commit sequences keep twelve
  observations and discard the first two.
- Add three alternating Web/native rounds for threshold-adjacent results,
  benefits, regressions and outliers. Do not reuse Web timings across browser
  upgrades or bundle hash changes. `?index=N` resumes a group; `?edits=1`
  measures retained edits.

### Native versus Web denoising

```sh
cargo build --release --locked --manifest-path native/host/Cargo.toml \
  --features validation --bin denoise-benchmark
node native/benchmark/denoise.mjs --output /absolute/evidence \
  --native /absolute/denoise-benchmark --oidn /absolute/OIDN-library \
  --model /absolute/complex-model.gltf
```

Open the printed localhost URL in a WebGPU browser. The harness loads the model
with GLTFLoader/THREESync and captures the same 8-sample HDR, normal and albedo
inputs for native CPU, native CUDA and oidn-web.

- Three alternating rounds each discard the first run and two warmups, then
  measure seven runs.
- Web uses the standard model, fixed 512-pixel tiles and FP16 when supported.
  Native uses high quality with noisy guides; the diagnostic fixes HDR
  `inputScale=1` to match Web GPU-buffer inputs (applications keep automatic
  exposure).
- Wall times include input upload and result readback, not renderer readback or
  model loading. Web `residentMs` excludes result readback but may include
  pending uploads; it is not a GPU timestamp.
- Keep input and output bytes, verify the actual GPU, report cold start
  separately, and compare outputs as well as timings; this does not establish
  quality parity.

## Metal HWRT sample miss

A Metal HWRT sample can occasionally see an empty scene or fail to accumulate
without an error. On an Apple M4 Max with macOS 27.0.1 it has been seen at 8×8
and 96×64 while other GPU users, including ordinary background apps, are
active; about 620,000 dispatches at 1920×1080 over three hours, mostly under
extra GPU load, showed none, which does not rule it out elsewhere. It predates
incremental commits and also reproduces in a standalone wgpu program with two
live BLAS/TLAS pairs and alternating bindings. A persistent residency set and
the BLAS wait before TLAS construction have not fixed it. Keep such probes
outside the repository and distinguish resource lifetime changes from
residency.

Run the interleaved geometry and full-commit diagnostic with the linked archive:

```sh
cargo test --manifest-path native/host/Cargo.toml --lib \
  changed_blas_and_tlas_are_ready_after_interleaved_retained_edits -- --nocapture
```

It prints AOV and primary-hit coverage classifications and reports a mismatch
separately from the other checks.

To reproduce repeated full-preparation failures, run the ignored loop with the
archive and a separate host Cargo target:

```sh
MT_LOOP_ITERATIONS=2000 MT_LOOP_BATCHED=1 cargo test \
  --manifest-path native/host/Cargo.toml --lib \
  hardware_loop_against_fresh_l0_contexts -- --ignored --nocapture
```

- It fails on HDR, normal or albedo mismatches and records each sample's primary
  hits, missing writes and sequence counts on both sides, reading the history
  after each render without changing the batch's GPU submissions.
- `MT_LOOP_ITERATIONS` must be a positive safe integer (CI uses 200).
  `MT_LOOP_L0=1 MT_LOOP_REAL_CAP=1` selects a direct L0 control with one sample
  per job poll and the real Sobol cap.
- `MUTRACER_TEST_CAPTURE` saves mismatching AOVs, descriptors and per-pixel
  audit records to a directory outside the checkout.
- Use independent processes and keep hit classifications and per-sample query
  parameters. A stop-at-first-failure count is not a failure rate, and a
  zero-failure run does not establish a fix. Revisions from before incremental
  commits reject the later padded transform packet; record any adaptation.

### oidn-webgpu release integration

The Rust adapter uses only the published crate's documented Model, Denoiser,
PreparedDenoise and wgpu APIs. Build with the ordinary host/viewer Cargo locks;
Cargo handles the bundled core. To exercise the native GPU path with the linked
AOT archive and host Cargo target configured:

```sh
cargo test --release --locked --manifest-path native/host/Cargo.toml --lib \
  oidn_webgpu -- --include-ignored --nocapture
```

These checks compare accumulated GPU inputs with CPU HDR normalization followed
by a direct Rust API call, preserve alpha and retained output, and exercise
progressive/every-sample schedules, resizing, target replacement and device loss.
The viewer's relocated `native:viewer:package -- --gpu` gate also runs denoising
and real-window startup. Windows uses the same Rust runtime through its MSVC core. Hosted Windows CI
checks compilation and CPU contracts; it does not establish GPU correctness.
CPU CI excludes the optional image oracles even when WARP/llvmpipe is available;
`native:ci:gpu` runs them and requires a hardware adapter.

For the browser release, serve `tests/gpu/oidnNativeIntegration.html` and run
`captureOIDNRelease()` in its console, then repeat with `?webgl`. It exercises
Small, Standard and Clean Aux Large with local weights, checks GPU errors and
confirms that filtering leaves fixed-seed raw HDR unchanged. It does not replace
same-input output comparisons between runtimes.

On macOS and Linux, the 0.1.1 dependency's Cargo build output propagates its
install name or ELF SONAME into downstream cdylibs. `finalize-host-library.mjs`
restores MuTracer's identity after the host build in the scene/CI drivers, using
install_name_tool plus ad-hoc signing on macOS and patchelf on Linux.
After a direct Cargo shared-library build, call
`finalizeHostLibrary(CARGO_TARGET_DIR)` from that module before linking C
consumers. Rust rlib consumers and the statically linked viewer do not need it.


## Vulkan C interop validation

Linux/Windows include the Vulkan bridge in ordinary builds; the ignored interop
GPU test is part of `native:ci:gpu`. On macOS, compile that same bridge explicitly
with `--features vulkan-interop` and set `MUTRACER_TEST_VULKAN_LIBRARY` to a Vulkan
portability driver's library, for example a local MoltenVK dylib. With the AOT
archive and separate host Cargo target configured:

```sh
cargo test --locked --manifest-path native/host/Cargo.toml --features vulkan-interop \
  --lib external_vulkan_device_images_and_native_post_process -- --ignored --nocapture
```

The test creates the host instance/device from the C requirements, imports them,
checks queue/image leases, copies an image with host Vulkan commands across a
render resize, and exercises native plus Rust display passes, failure rollback
and retirement notifications. A portability-driver pass does not validate
Linux/Windows drivers or Vulkan HWRT. C callers also need their Vulkan SDK headers
when including `mutracer-vulkan.h`; the ordinary headers do not require them.

## glTF material comparison

Set `MUTRACER_GLTF_EVIDENCE` outside the checkout and run the host CPU test
`gltf_browser_reference_fixture`. After `npm run build:lib`, run
`node native/validation/gltf-material-reference.mjs EVIDENCE_DIRECTORY` to compare
24 scalar/color fields and ten texture bindings with GLTFLoader/THREESync.
Node substitutes decoded pixels for the two known 1×1 PNGs; it still uses the
actual loader extension handlers and browser material conversion. The comparison
records the deliberate volume thin-wall difference separately. Run the ignored
`gltf_layers_render_and_retained_texture_edit_match_full` test on a real GPU to
compare HDR, normal and albedo after extension texture edits with full preparation.

## Scene picking consumer

`native:ci` builds and runs `native/examples/scene-picking.c` without a GPU. For a
direct rerun, set `CARGO_TARGET_DIR` to the built host target and
`MUTRACER_NATIVE_OUTPUT` outside the checkout, then run
`node native/validation/scene-picking.mjs [PATH_TO_LAYERS_GLTF]`. The optional path
uses the fixture from `gltf_browser_reference_fixture` to check glTF C import and
picking together. Rust picking tests additionally compare 500 rays with an
independent double-precision brute-force oracle over transformed triangles.

## AOV integration checks

The scene API C host in `native:ci:hosts` compares explicit descriptor IDs with
scene-handle IDs, verifies AOV readback, and compares each C custom-filter depth
and uint32 ID snapshot with vertically flipped engine readback. It asserts the
actual render backend on both Software and HWRT. A direct rerun uses
`node native/validation/scene-api-render.mjs` with the release host target and an
external output directory configured.

The ignored `gltf_layers_render_and_retained_texture_edit_match_full` test also
checks AOV beauty preservation, stable imported IDs and reflectance invalidity
for unsupported glTF layers. The Vulkan interop test enables depth/ID outputs,
checks readback exclusion during an image lease, and reads them after release.
