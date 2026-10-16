# TinyBVH adapter

MuTracer builds static bottom-level BVHs with [TinyBVH](https://github.com/jbikker/tinybvh)
compiled to WebAssembly. The module is included with the library; using MuTracer
does not require a C++ compiler or Emscripten.

Set `engine.bvhBuilder = 'tinybvh'` to build missing static BLASes before the
first frame. The default uses binned SAH; set `engine.bvhSpatialSplits = true`
for spatial splits, which take longer to build. `engine.bvhLayout` selects the
traversal layout. Changing builder settings replaces existing BLASes. CWBVH is
experimental: its benefit depends on the GPU and scene.

See [BVH usage and options](../../docs/bvh.md) and the
[adapter contributor guide](./CONTRIBUTING.md). TinyBVH is MIT licensed;
see [LICENSE](./LICENSE).
