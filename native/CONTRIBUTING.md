# Native contributor guide

Public behavior, costs and limits belong in [README.md](./README.md) and the C
headers. This guide covers implementation, validation and maintenance. License
notices are separate for the [native library](./THIRD_PARTY_NOTICES.md) and
[viewer](./viewer/THIRD_PARTY_NOTICES.md).

## Directory layout

- `src/`: TypeScript AOT entry points, runtime adapters and shader generators.
- `host/src/`: Rust library; `host/diagnostics/`: standalone diagnostic executables and shaders.
- `include/`: public C headers; `schemas/`: frozen wire-property IDs and error codes.
- `docs/`: user-facing reference for the C API, starting with the scene format.
- `scripts/`: compiler lowering, contract generators, CI and viewer packaging.
- `examples/`: C consumers; `tests/`: AOT fixtures and the C module test harness.
- `validation/`: render/contract checks and browser reference tools;
  `validation/compiler/` holds whole-browser-API and async compilation probes.
- `benchmark/`: performance and correctness comparison tools.
- `viewer/`: standalone app; `toolchain/`: pinned compiler installation;
  `LICENSES/`: license texts.

The existing `npm run native:*` commands remain the entry points. Additional
precision checks run with `node native/validation/matrix-verify.mjs` and
`node native/validation/vector-verify.mjs`. `native:check` is a compiler-capability
probe that reports the incomplete browser API port and exits with status 1;
`native:ci` validates the supported native implementation.

## Build and CI

Use scriptc **0.3.2**, Rust with locked dependencies and a C++20 compiler. Set
`MUTRACER_SCRIPTC` to the compiler and `MUTRACER_NATIVE_OUTPUT` to an evidence
folder outside the checkout. `npm run native:scene` builds the composed AOT
archive and verifies raw-scene preparation and rendering on 33 fixtures.
`native:context`, `native:jobs`, `native:camera` and `native:settings` build on that
gate and validate retained scenes, polling/cancellation, camera updates and render
settings respectively. Use `MUTRACER_NATIVE_SAMPLES` to select the fixture sample
count; cross-stage byte comparisons must use the same count and seed.

The native CI jobs install platform optional packages from `native/toolchain/`.
For the same local run:

```sh
npm ci --prefix native/toolchain --include=optional
MUTRACER_NATIVE_OUTPUT=/absolute/evidence npm run native:ci
```

`npm run native:ci:hosts` also runs the context, job, camera and settings C hosts
(`native:settings` chains the other three) against the fixtures, archive and Cargo
target that the CI run just produced, at 8 samples. Run the `native:*` commands
separately only when iterating on one host; each of them rebuilds and rerenders
its whole chain.

The GitHub Actions `CI` workflow runs on pull requests, pushes to `main` and `dev`, and
manual dispatches. It validates native code and builds standalone viewers for
macOS arm64, Linux x64 and Windows x64, including OIDN and licenses. Download
`native-macos-arm64`, `native-linux-x64` or `native-windows-x64` from the run's
artifacts for the app archive and SHA-256 checksum (retained for 14 days).
The corresponding `native-PLATFORM-diagnostics` artifact retains logs and check
summaries for seven days, including failed runs.
Manual dispatch defaults to `release` (all three platforms); `native_platform` can
select one target for diagnosis. Windows x64 remains experimental; its app is
available from CI artifacts. A single-target dispatch never publishes a release.

Windows builds need an x64 MSVC Developer environment for OIDN, MinGW-w64 GCC,
Ninja, CMake and Zig 0.15.2 for scriptc's library archiver. Install Rust's
`stable-x86_64-pc-windows-gnu` toolchain and select it with `RUSTUP_TOOLCHAIN`.
The scriptc 0.3.2 Windows archive references MinGW CRT helpers despite its `msvc`
package suffix; the host, viewer and C harnesses use the GNU toolchain to match.
Linux builds need a C++20 compiler, CMake, patchelf, and the X11/Wayland development
libraries installed by the workflow. `npm run native:viewer:package` archives the
built app, extracts it to a new directory and validates the bundled sample and
CPU OIDN without an override library path. It also checks rendering and all AOVs
when an adapter exists. Set `MUTRACER_NATIVE_GUI_SMOKE=1` to require a real window
and displayed frames on those adapters; Linux uses `xvfb-run`.

Push a `native-v*` tag, for example `native-v0.1.0`, to run the same checks and
publish macOS and Linux app archives and checksums to that tag's GitHub Release after
Web and all native jobs pass. Tags such as `native-v0.1.0-rc.1` create prereleases. Native
releases do not replace the repository's latest release. Rerunning a tag's job
replaces matching assets on a mutable release. Publishing uses `GITHUB_TOKEN`;
the release job requires `contents: write`. The app is ad-hoc signed and is not
Apple-notarized.

The compiler resolver restores executable permissions for the platform archive's
compiler, TypeScript server, LLVM code generator and comptime helper. Root Web
dependencies do not include this compiler. CI skips GPU execution only when
adapter discovery reports no adapter; device initialization/execution failures
remain failures. Rust CPU tests, module contracts and storage checks still run.
The optional MaterialTable whole-module probe has known compiler blockers;
all 14 required modules must build and verify.

For direct Rust builds, first run `npm run fetch:tinybvh` to
[prepare the headers](../src/tinybvh/CONTRIBUTING.md#preparing-headers), then set
`MUTRACER_AOT_ARCHIVE` to the built archive. **Use
separate `CARGO_TARGET_DIR` values for the independent host and viewer manifests.**
Their different wgpu feature graphs can otherwise overwrite the host's unhashed
multi-crate-type rlib and cause incompatible wgpu crate identities.
Run both Rust suites, the root typechecks, library/viewer tests,
`native:modules:verify`, `native:storage:verify` and `npm run build` before stage
review. Run rustfmt before committing Rust. Compilation is not a GPU output gate.

## Runtime, ownership and errors

C context and job calls may originate on arbitrary threads. Short registry
operations serialize and overlapping calls may return busy. Full commit builds a
candidate outside the registry lock; the old scene can keep rendering/polling.
A process-wide dedicated worker owns the AOT runtime and its preparation roots.
Copy AOT results before reset/collection, and initialize the module only once.
There is no dynamic-unload shutdown API for that worker.

A context commit token identifies cancellation and publication. Cancel drains the
current preparation step; destroy waits until the candidate's roots/resources
retire. A candidate keeps its GPU resources until successful publication, and
rejection preserves the old scene/settings/samples. Publication cancels/drains
old render work. Incremental updates reject active jobs or pending full commits.
Handles are monotonic, with no fixed eight-context cap. Device memory remains
finite. Two resource generations and at most 32 pipeline variants may coexist;
preserve transactional behavior when changing their retention policy.

TS errors carry an operation code and message in a bounded UTF-8 packet. Rust
validates that packet and reports the specific cause. Caught Rust panics mark
the touched context failed while guards remain alive to avoid poisoned locks.
A successful full commit recovers the scene; AOT OOM/abort traps terminate the
process. Logs use `mutracer-log.h`, silent by default. Callbacks serialize on the
emitting thread, cannot reenter the library and must outlive unregistration.

Public headers in `include/` are the supported C API; `mutracer-debug.h` is
the exception and holds validation-only entry points. The layout generator
writes caller-facing descriptor offsets to `include/mutracer-layout.h` and host
protocol records, resource IDs and shader layouts to the uninstalled
`src/mutracer-internal-layout.h`. The hand-written record structs in
`include/mutracer-scene.h` assert their offsets against the generated public
header, so a schema change that resizes a record or moves a checked field
fails to compile until the structs and `docs/scene-format.md` are updated.

## Shared source and typed resources

Production native rendering accepts only version-4 raw descriptors. Prepared
capture replay and its file-backed resource loader have been removed. The
validation-only Web oracle records writes through
`validation/resource-recorder.mjs`; production never consumes those captures.

Shared TypeScript owns scene decoding/assembly, material/light/environment
packing, render settings, layouts, shader generation and incremental preparation.
The host uses typed resource IDs, texture formats, layout entries and pipeline
keys. Update `native/scripts/generate-layout-schema.mjs` after schema edits;
`--check` runs with typecheck. Material wire IDs in
`schemas/material-properties.json` are frozen;
regenerate with `scripts/generate-material-properties.mjs` without renumbering IDs.

`scripts/storage-lowering.mjs` instantiates numeric generics and nested closures without
changing arithmetic or control flow. `scripts/attribute-lowering.mjs` lowers proven
concrete accesses; `scripts/vector-lowering.mjs` specializes shared math storage.
The numeric-access report traces the complete production graph and rejects loop
storage dispatch. Open unions, ordinary arrays and callbacks retain fallback
implementations. Keep emitted compiler inputs separate from browser source.

Bounds and generated tangents are the two profiled native O(N) kernels. Tangent
normalization uses compiled TS Math.hypot to preserve rounding. All other scene
logic stays TS. With `MUTRACER_KERNEL_FIXTURES=/absolute/manifest.json`, host tests
compare kernel packets and production resources against compiled TS byte for
byte. `prepare-diagnostics INPUT OUTPUT BACKEND ITERATIONS` profiles CPU-only
preparation. `nativeGeometryKernelProfile` separates kernel bodies; its time is
already included in preparation, never an extra phase. Qualify a replacement on
complex scenes and the same concrete function specialization, not combined
generic variants or procedural fixtures.

## Incremental and GPU validation

`native:camera` compares six camera records on every fixture. `native:jobs` checks
queued/running/cancelling/cancelled/completed states, completed-sample accounting,
stale handles and accumulation equivalence. Poll submits at most one bounded
batch and never waits for the GPU; callbacks only update owned completion flags.
Test arbitrary calling threads, cancel/destroy during preparation, failed commit
rollback and continued rendering of the previous scene. Use ThreadSanitizer and
state which Rust/C++ dependencies it instruments; AOT, Metal and OIDN are outside
that coverage.

The staged TS adapters reuse the original camera math, material repacking,
environment distributions, light PMFs and emissive caches. Acknowledge candidate
state only after layout validation and GPU upload/reset. Transform and vertex
edits must use the latest accepted source state; reject unsupported shape or
shader-stack changes with a full-commit requirement. Retain shared tuple storage
when Map-indexed records are copied by scriptc.

HWRT uses authoritative hardware hits. Assert the actual backend after every
commit; software fallback cannot count as hardware success. All AS build paths
submit BLASes and wait for completion **before encoding TLAS construction**.
Metal's indirect instance descriptors and empty HAL AS barriers make one encoder
insufficient. This wait is preventive; it has not fixed the intermittent miss.
PreferUpdate is not a refit. HAL refit remains opt-in and must preserve its
thread/resource lifetime assumptions.

Compare fixed-seed HDR/normal/albedo on real GPUs for both browser backends.
Use the independent high-sample software reference for image statistics. Diagnose
first hits and the first differing path event when statistics exceed the gate;
report edge/tie cases and reject unexplained differences. Displacement random
streams depend on traversal order. Keep all raw images, failure samples, hashes,
logs and experiment reports outside the repository.

## Viewer and OIDN validation

`npm run native:viewer:build` builds the full AOT graph and platform app with locked
Rust dependencies; macOS uses ad-hoc signing. eframe/egui-wgpu and tracing share one
adapter/device/queue. `src/display-shader.ts` generates the display WGSL through the
Web TS generator; `scripts/generate-display.mjs --check` detects stale output. Normal
preview capture, tonemap and presentation stay on the GPU. Only OIDN/export reads
pixels back. The immutable owned picking BVH is built while loading a model on
a worker. Descriptor assembly and full commits also run off the UI thread.
The viewer pauses native queue submissions outside its UI callback so eframe can
reconfigure the shared surface safely; CPU preparation continues while paused.

The packaged executable accepts `[MODEL] --package-smoke DIRECTORY` for the
portable package gate. `--startup-smoke REPORT.json` opens a window and closes
after resizing the window and presenting rendered frames; its report must confirm
success. The stronger
`[MODEL] --smoke-out DIRECTORY` requires actual HWRT for load/render,
editing, cancellation, HDR environments, backend assertions and native OIDN.
`--interaction-smoke DIRECTORY` checks continuous camera/held edits, retained
previews, resize and stale-OIDN rejection. Material, environment, light, transform
and geometry each have a corresponding `--NAME-smoke DIRECTORY` that compares
incremental commits with full preparation. `--parity-smoke DIRECTORY` compares
viewer camera/render settings against fresh contexts on both backends, checks
settings retention after edits/backend replacement, and exercises display controls,
transparent PNG export, OIDN alpha preservation and guide channels. It needs the
bundled OIDN runtime. For Studio, first run
`node native/validation/viewer-studio-reference.mjs DIRECTORY`, then
`--studio-smoke DIRECTORY`: it compares native rect-light records with the Web
placement/ambient oracle and tests preset/parameter edits against fresh contexts
on Software and actual HWRT. Test all three AOVs, invalid input,
rollback and restoration. `[MODEL] --edit-bench DIRECTORY` records descriptor
build and commit times of material, transform, camera, light and environment
edits at 1280×720 on both backends in `edit-bench.jsonl`; set
`MUTRACER_NATIVE_PROFILE=1` for a per-commit phase breakdown on stderr.

Inspect the real window as well: file dialogs, panel changes, orbit/pan/zoom/fit,
pause/restart, resolution/exposure and PNG export are not covered by headless
smokes. `MUTRACER_VIEWER_METRICS=/absolute/result.json` runs a 1280×720 real-window
interaction/three-full-commit sequence, reports UI/picking/frame intervals and
closes automatically. Use LEGO, keep the Mac unlocked and nominal, and retain
outliers. This opt-in contributor instrument does not change normal usage.

OIDN uses the library's `denoise.rs` for both the C ABI and viewer worker. The
build pins 2.5.1 source/weights and official ABI-matched CPU modules (plus Metal
on macOS and CUDA/HIP on Windows/Linux), omits three large models and packages
component notices. Check CPU/Metal/CUDA/HIP/Auto,
malformed inputs, rollback, in-place output and arbitrary calling threads.
Set `MUTRACER_OIDN_LIBRARY` for the Rust SDK tests and
`MUTRACER_TEST_OIDN_HIP=1` on a supported AMD machine to require HIP execution
and backend assertions (`MUTRACER_TEST_OIDN_CUDA=1` does the same for CUDA).
To require CPU fallback and explicit GPU rejection, set
`MUTRACER_TEST_OIDN_NO_GPU=1` with `OIDN_DEVICE_METAL=0`, `OIDN_DEVICE_CUDA=0`
and `OIDN_DEVICE_HIP=0`, leaving the GPU requirement flags unset.
Rust/TS rendering accumulation is independent of optional denoising. Copy the
app to a new location and run all demo models plus Sponza without Node or build
paths. Inspect dependencies, licenses and signature. Denoising parity with the
browser model is not guaranteed.

## Native TinyBVH boundary

Raw scene commits and transform/vertex update TLAS construction use the official
TinyBVH headers pinned in `src/tinybvh/upstream.json`. The host compiles the browser's
existing C++ wrapper directly; preserve pointer-width-safe result addresses and
`-ffp-contract=off` for conservative float bounds. Native and Web now pin
TinyBVH 1.9.1 to the same upstream revision; all six cached upstream headers are unmodified.
See the shared [adapter contributor guide](../src/tinybvh/CONTRIBUTING.md) for Wasm rebuilding
and CWBVH conversion.

Windows compiles a generated header copy whose pool exit hook skips cleanup
after DLL process termination has stopped the other threads. The verified
upstream cache stays unmodified; normal static-executable teardown and explicit
pool shutdown still join workers. Native CI checks DLL exit without a GPU.

The native bridge enables full ARM NEON/Bonsai construction and upstream workers
with aligned float4 vertices retained through serialization. Web uses its scalar
Wasm build and existing browser worker pool. Native spatial splits stay disabled,
matching the browser default; Web spatial splits remain opt-in. Upstream chooses
threaded work by size; small BVHs stay on the calling thread. Stable-topology
refits still use the original TS updater. The 1.9 process-wide worker pool
survives a host thread and joins at shutdown. Check host exit, explicit shutdown,
restart and process exit with ThreadSanitizer:

```sh
c++ -std=c++20 -O1 -g -fsanitize=thread -ffp-contract=off \
  -I "$(node scripts/fetch-tinybvh.mjs)" native/host/tinybvh.cpp \
  native/tests/tinybvh-thread-exit.cpp -o /tmp/mutracer-tinybvh-thread-exit
TSAN_OPTIONS=halt_on_error=1 /tmp/mutracer-tinybvh-thread-exit
```

The synchronous AOT steps return geometry/displacement/AABB jobs, retain source
state across arena resets, and consume the host's BVH2 results. Shared TS code
packs instance records, materials, lights and shader resources. Stable-topology
BLAS refit still reuses `updatePreparedGeometries`; the TS SAH builder remains
available to browser fixtures and legacy stateless AOT comparison exports.

Compare native and Wasm on identical inputs, including degenerate triangles and
all displacement projections. SIMD/Bonsai and scalar builds can choose different
trees: validate primitive identity, conservative bounds and GPU output, and keep
byte comparisons for matching builder configurations. Full and incremental
results must agree on HDR/normal/albedo, survive failed candidates/other contexts,
and preserve HWRT identity mapping after TLAS leaf reordering. Compare against
the chosen builder reference: switching from built-in SAH to TinyBVH can change
leaf order, packed displacement heights and output. Archive those differences;
do not silently change the rendering algorithm or claim universal pixel parity.
The native TinyBVH license belongs under `native/LICENSES/` and is also copied
into the application bundle.

## Performance comparisons

For native CPU/CUDA versus oidn-web denoising, build the diagnostic with
`cargo build --release --locked --manifest-path native/host/Cargo.toml --features validation --bin denoise-benchmark`,
then run `node native/benchmark/denoise.mjs --output /absolute/evidence
--native /absolute/denoise-benchmark --oidn /absolute/OIDN-library --model /absolute/complex-model.gltf`.
Open its localhost URL in a WebGPU browser. The harness loads the model with
GLTFLoader/THREESync and captures the same 8-sample HDR/normal/albedo inputs for
all three paths. It runs three alternating rounds, each discarding the first
execution and two warmups before seven measurements. Web uses the standard
model, fixed 512-pixel tiles and FP16 when supported. Native uses high quality
with noisy guides; the diagnostic fixes HDR inputScale=1 to match Web GPU-buffer
inputs. Normal application calls retain automatic HDR exposure. Both wall times
include host input upload and result readback; renderer readback and model loading
are excluded. The Web `residentMs` diagnostic excludes result readback but may
include pending uploads; it is not a pure GPU timestamp. Retain input/output
bytes, verify the actual GPU, and report cold start separately. Compare outputs
as well as timings; this benchmark does not establish denoising quality parity.

```sh
node native/benchmark/benchmark.mjs --manifest /absolute/inputs.json \
  --library /absolute/libmutracer_native_probe.dylib --output /absolute/evidence --port 4201
```

The manifest fixes raw descriptors, checksums and expected backend/reason. The
harness freezes binaries, bundles and configuration. Use only complex models for
performance. Procedural fixtures are correctness checks. Web requests 1080 rows
but renders 1088 internally; compare requested sizes without pixel rescaling.

Use caffeinate with an unlocked display and wait for thermalState=0 before every
group. Default one round; Web/HWRT render six times and discard the first. Software
renders once for bytes and records no render performance or GPU profiling. HWRT
profiles twice after formal output is durable. Commit sequences retain twelve
observations, discarding the first two. Supplement threshold-adjacent results,
benefits/regressions or outliers to three alternating Web/native rounds under
the plan's noise rule. Do not reuse Web timing across browser upgrades or bundle
hash changes. `?index=N` resumes a group; `?edits=1` measures retained edits.

`MUTRACER_NATIVE_PROFILE=1` reports validation, source preparation, BLAS/TLAS,
composition, GPU setup and pipeline time. Pipeline is a subset of setup. Full
commit wall time includes flush/publication/retirement that the inner profile
excludes. Timestamp profiling is separate from formal timing. Metal pass timestamps
measure kernels; AS `completedWallMs` is wall time after draining earlier uploads,
not a GPU timestamp. Invalid timestamps are missing diagnostics, not render errors.
Upload payload counts come from write calls, separate from buffer capacity and
AS internal storage. Native peak RSS and browser JS heap are different metrics.

## Robustness and diagnostics

Caught TypeScript exceptions must retain their operation code and message across
the packet boundary. Exercise the actual AOT archive; a JavaScript-only test is
insufficient. Fatal AOT traps abort the process, so fuzz in a separate process.

With nightly Rust and cargo-fuzz installed, set `MUTRACER_AOT_ARCHIVE` to the
compiled archive and `CARGO_TARGET_DIR` to an evidence directory outside the
checkout. Generate a valid seed with `cargo run --manifest-path
native/host/Cargo.toml --features fuzzing --bin fuzz-seed -- SEED_PATH`. Put that
seed and small descriptor fixtures in external corpus directories. Run each
target for at least 30 minutes:

```sh
cargo +nightly fuzz run --fuzz-dir native/host/fuzz validate CORPUS_VALIDATE -- \
  -max_total_time=1860 -max_len=65536 -artifact_prefix=ARTIFACT_DIRECTORY/
cargo +nightly fuzz run --fuzz-dir native/host/fuzz commit CORPUS_COMMIT -- \
  -max_total_time=1860 -max_len=65536 -artifact_prefix=ARTIFACT_DIRECTORY/
```

The commit target needs a real adapter and checks both actual backends with
bounded dimensions, geometry and displacement work. Rust AddressSanitizer does
not instrument the scriptc archive or system drivers; report instrumentation
boundaries. Compile C++ separately with a compatible sanitizer runtime before
claiming C++ coverage. Preserve failing inputs, logs, exact toolchain and hashes.

Library diagnostics use `mutracer-log.h`; standalone Rust tools explicitly enable
stderr logging. Missing or invalid GPU timestamps produce a diagnostic and a
missing measurement, while rendering continues. Upload payload counts belong at
the actual write calls; buffer capacity and required AS storage are separate.

## HWRT reproduction

Run the small interleaved geometry/full-commit diagnostic with the linked AOT archive:

```sh
cargo test --manifest-path native/host/Cargo.toml --lib \
  changed_blas_and_tlas_are_ready_after_interleaved_retained_edits -- --nocapture
```

It prints AOV and primary-hit coverage classifications; a mismatch is reported
separately from the other task checks while the known Metal HWRT bug is open.
Use independent processes and retain hit classifications and per-sample query
parameters. A stop-at-first-failure count is not a failure-rate estimate. The
closest Phase 1 equivalent rejects the later padded transform packet, so record
adaptations explicitly. The issue predates Phase 3 and also reproduces in a
standalone wgpu program with two live BLAS/TLAS pairs and alternating bindings.
A persistent residency set has not fixed the real host test. Keep those probes
outside the repository and distinguish resource lifetime changes from residency.
Phase 3 acceptance still requires the plan's repair gate.
