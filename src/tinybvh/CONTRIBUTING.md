# TinyBVH adapter development

The Web and native builders share the version and SHA-256 hashes in
[`upstream.json`](./upstream.json). No SDK or header download is needed to consume
the browser library, which includes the prebuilt Wasm module.

## Preparing headers

With Node.js 20 or newer, run from the repository root:

```sh
npm run fetch:tinybvh
```

This downloads the six upstream headers at the pinned commit and verifies their
SHA-256 hashes. Headers are cached in `.cache/tinybvh/<revision>/`, outside Git.
Valid cached files are reused without network access; missing or corrupt files
require a download. Keep this directory when building offline.

The Web Wasm rebuild, native viewer build, native CI and scene validation prepare
headers automatically. Before direct Cargo builds, run the preparation command
above. Cargo itself does not download headers.

## Rebuilding the WASM module

The build scripts prepare the headers and compile the wrapper with Emscripten's
`em++`:

```bash
npm run build:tinybvh
```

Alternatively, use the official Emscripten Docker image (the checked-in module
was built with 6.0.12), including on Apple Silicon:

```bash
docker run --rm -v "$PWD:/src" -w /src emscripten/emsdk:6.0.12 ./scripts/build-tinybvh.sh
```

On Windows use the PowerShell builder; pass `-Empp` when `em++` is not on
`PATH`:

```powershell
npm run build:tinybvh:windows -- -Empp C:\path\to\emscripten\em++.exe
```

## Renderer layout conversion

CWBVH notes. The adapter follows TinyBVH's GPU traversal
([`kernels/traverse_cwbvh.cl`](https://github.com/jbikker/tinybvh/blob/c9be3103cc9693b456b0a0353927c11cac7d710f/kernels/traverse_cwbvh.cl)):
interior hits are kept as an 8-bit node group and triangle hits as a 24-bit
triangle group. The adapter replaces the default `MBVH<8>` collapse with the
bottom-up/top-down dynamic program of the
[Ylitie–Karras–Laine paper](https://research.nvidia.com/sites/default/files/publications/ylitie2017hpg-paper.pdf)
(`cnode = 1`, `cprim = 0.3`, `Pmax = 3`). The three-primitive leaf limit keeps
the 24 triangle bits from overlapping the 8 interior bits. After serialization
the adapter computes the exact traversal stack depth used by the shader.

Upstream 1.9 enables precomputed CWBVH triangles by default. The adapter reads
primitive IDs from the fourth block in that format (third block for the older
uncompressed format), then writes the renderer's existing index/height records.
Its IEEE-biased box exponents must also be converted back to the signed-byte
exponents expected by both shaders, including the direct tiny-root path.
The DP uses binary node IDs, so reserve the full binary-sized MBVH node pool;
upstream's tightly sized collapsed pool cannot hold those sparse IDs.
Upstream's new BVH_GPU packs leaf references into child pointers. Serialize the
official binary tree into MuTracer's existing 64-byte GPU nodes instead, preserving
full-width leaf counts and offsets without changing either traversal shader.
Keep aligned vertex storage alive until all conversions finish. Check every
layout with spatial splits on/off, conservative bounds, triangle identity and
actual WebGPU/WebGL rendering after changing upstream.
