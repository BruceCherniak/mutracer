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
macOS Metal module and Windows/Linux CUDA/HIP modules remain from the matching
official SDK. macOS/Linux loader
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

The viewer uses the native SDK glTF importer; see its [codec notices](../THIRD_PARTY_NOTICES.md#native-gltf-codecs).

## Poly Haven texture downloads

The viewer downloads CC0 textures from [Poly Haven](https://polyhaven.com/textures).
Its native HTTPS client uses [ureq](https://github.com/algesten/ureq) (MIT/Apache-2.0),
[rustls](https://github.com/rustls/rustls) (Apache-2.0/ISC/MIT), and their HTTP/TLS
dependencies. Their copyright notices and license texts are retained in
[HTTP-TLS.txt](./LICENSES/HTTP-TLS.txt), which accompanies the native app.

