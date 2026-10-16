# Native third-party notices

The native library is part of MuTracer under the repository [MIT License](../LICENSE).
Shared renderer attributions are in the [repository notices](../THIRD_PARTY_NOTICES.md).
The native viewer has [separate notices](./viewer/THIRD_PARTY_NOTICES.md).
Native-specific license texts are in [LICENSES/](./LICENSES).

## wgpu native ray-query probe

The experimental `native/host/ray-query-probe.wgsl` follows ray-query API usage
from the [wgpu v30.0.1 ray-traced triangle example](https://github.com/gfx-rs/wgpu/blob/v30.0.1/examples/features/src/ray_traced_triangle/shader.wgsl),
modified into analytic hit/miss, mask, distance and instance checks.
Copyright (c) 2025 The gfx-rs developers. MIT License
([`LICENSES/Wgpu-MIT.txt`](./LICENSES/Wgpu-MIT.txt)).


## TinyBVH native builder

`vendor/tinybvh/tiny_bvh*.h` contains the unmodified official
[jbikker/tinybvh](https://github.com/jbikker/tinybvh/tree/c9be3103cc9693b456b0a0353927c11cac7d710f)
1.9.1 headers at commit `c9be3103cc9693b456b0a0353927c11cac7d710f`, shared with the
browser Wasm builder. File hashes are in [`vendor/tinybvh/upstream.json`](./vendor/tinybvh/upstream.json).
Copyright (c) 2024-2026 Jacco Bikker / Breda University of Applied Sciences.
MIT License ([`LICENSES/TinyBVH-MIT.txt`](./LICENSES/TinyBVH-MIT.txt)).
`host/tinybvh.cpp` reuses `src/tinybvh/tinybvh_wrapper.cpp` for native builds
and adds the AABB-input bridge used for instances.

## Native OIDN loader

The shared native library/viewer adapter loads Open Image Denoise through
[libloading 0.8.9](https://github.com/nagisa/rust_libloading/tree/0.8.9),
Copyright © 2015 Simonas Kazlauskas, ISC License
([text](./LICENSES/Libloading-ISC.txt)). The library caller supplies the OIDN
runtime; the viewer bundles a runtime covered by its
[separate notices](./viewer/THIRD_PARTY_NOTICES.md).
