# Native viewer third-party notices

The native viewer is part of MuTracer under the repository [MIT License](../../LICENSE).
It links the native library; see its [notices](../THIRD_PARTY_NOTICES.md) and the
[shared renderer notices](../../THIRD_PARTY_NOTICES.md). Viewer-specific license
texts are in [LICENSES/](./LICENSES).

## Native Open Image Denoise runtime

The optional native viewer bundles [Open Image Denoise 2.5.1](https://github.com/RenderKit/oidn/releases/tag/v2.5.1)
under the Apache License 2.0, including its regular/small model weights and
native runtime dependencies. MuTracer rebuilds its core/API from the fixed
2.5.1 source with three optional large weight sets omitted; CPU modules and the
macOS Metal module remain from the matching official SDK. macOS/Linux loader
paths are adjusted to the bundled libraries. Copyright 2018 Intel Corporation.
The [license](./LICENSES/Apache-2.0.txt) and upstream bundled dependency notices
([OIDN](./LICENSES/OIDN-third-party-programs.txt),
[oneTBB](./LICENSES/OIDN-third-party-programs-oneTBB.txt),
[DPC++](./LICENSES/OIDN-third-party-programs-DPCPP.txt)) accompany the app in
`Contents/Resources/licenses/OIDN/` on macOS and `licenses/OIDN/` on Windows/Linux.
This runtime is not part of the npm library.

The shared native OIDN adapter and its loader attribution are covered by the
[native library notices](../THIRD_PARTY_NOTICES.md).

## Windows DirectX Shader Compiler

The Windows viewer bundles `dxcompiler.dll` and `dxil.dll` from Microsoft's
[DirectX Shader Compiler v1.8.2505.1](https://github.com/microsoft/DirectXShaderCompiler/releases/tag/v1.8.2505.1).
The [LLVM](./LICENSES/DXC-LLVM.txt), [Microsoft](./LICENSES/DXC-MS.txt) and
[MIT](./LICENSES/DXC-MIT.txt) license texts accompany the app in `licenses/DXC/`.
This runtime is not part of the npm library.

## Native glTF codecs

The native viewer uses [meshopt-rs 0.6.2](https://github.com/gwihlidal/meshopt-rs)
(MIT, Copyright 2018 Graham Wihlidal;
[license](./LICENSES/Meshopt-rs-MIT.txt)) and its bundled
[meshoptimizer 0.25](https://github.com/zeux/meshoptimizer/tree/v0.25)
(MIT, Copyright 2016-2025 Arseny Kapoulkine;
[license](./LICENSES/Meshoptimizer-MIT.txt)) for Meshopt decoding.
WebP decoding uses [image-webp 0.2.4](https://github.com/image-rs/image-webp)
under MIT ([license](./LICENSES/Image-webp-MIT.txt)). These codecs do not ship in
the npm library. The licenses accompany the native app.

