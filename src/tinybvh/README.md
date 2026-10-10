# TinyBVH adapter

MuTracer builds bottom-level BVHs with [TinyBVH](https://github.com/jbikker/tinybvh)
compiled to WebAssembly. `tinybvh_wrapper.cpp` exposes a small C API that writes
BVH2, BVH4, BVH_GPU or CWBVH nodes in the exact layouts consumed by the WebGL
and WebGPU traversal shaders. `tinybvh.wasm` is checked in, so building the
library does not need Emscripten.

The renderer uses BVH2 by default (`Renderer.bvhBuilder = 'tinybvh'`) and
builds missing BVHs automatically before the first frame. Call
`precomputeTinyBvh(meshes, layout)` to build ahead of time or to try another
layout. CWBVH is experimental: its benefit depends on the GPU and the scene.

CWBVH notes. The adapter follows TinyBVH's GPU traversal
([`kernels/traverse_cwbvh.cl`](https://github.com/jbikker/tinybvh/blob/0e4584287823252cf83f0e9cd072848bec5f79c5/kernels/traverse_cwbvh.cl)):
interior hits are kept as an 8-bit node group and triangle hits as a 24-bit
triangle group. TinyBVH 1.8.0 collapses to `MBVH<8>` greedily; the adapter
replaces that step with the bottom-up/top-down dynamic program of the
[Ylitie–Karras–Laine paper](https://research.nvidia.com/sites/default/files/publications/ylitie2017hpg-paper.pdf)
(`cnode = 1`, `cprim = 0.3`, `Pmax = 3`). The three-primitive leaf limit keeps
the 24 triangle bits from overlapping the 8 interior bits. After serialization
the adapter computes the exact traversal stack depth used by the shader.

## Rebuilding the WASM module

The build scripts download `tiny_bvh.h` at the pinned revision and compile the
wrapper with Emscripten's `em++`:

```bash
npm run build:tinybvh
```

On Windows use the PowerShell builder; pass `-Empp` when `em++` is not on
`PATH`:

```powershell
npm run build:tinybvh:windows -- -Empp C:\path\to\emscripten\em++.exe
```

TinyBVH is MIT licensed; see [`LICENSE`](./LICENSE).
