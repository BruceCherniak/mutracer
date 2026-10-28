# Native viewer third-party notices

The native viewer is part of MuTracer under the repository [MIT License](../../LICENSE).
It links the native library; see its [notices](../THIRD_PARTY_NOTICES.md) and the
[shared renderer notices](../../THIRD_PARTY_NOTICES.md). Viewer-specific license
texts are in [LICENSES/](./LICENSES).

## oidn-webgpu denoising

The viewer links the native library's oidn-webgpu Rust runtime, embeds its standard
OIDN model and bundles `rt_hdr_alb_nrm_small.tza` for live previews; see the
[runtime and model notices](../THIRD_PARTY_NOTICES.md#oidn-webgpu-native-runtime).
The viewer does not bundle the Open Image Denoise SDK or device modules.

## Optional NVIDIA DLSS Ray Reconstruction

The optional Windows DLSS build links NVIDIA's NGX loader into
`mutracer_ngx.dll` and includes `nvngx_dlssd.dll`, supplied separately from the
[NVIDIA DLSS SDK](https://github.com/NVIDIA/DLSS). Copyright NVIDIA Corporation
and affiliates. These binary components are governed by the NVIDIA RTX SDKs
license, not MuTracer's MIT license. The optional app includes the supplied
license at `licenses/NVIDIA-DLSS/LICENSE.txt`. Default builds contain neither
the NGX shim nor the DLSS runtime.

## Windows DirectX Shader Compiler

The Windows viewer bundles `dxcompiler.dll` and `dxil.dll` from Microsoft's
[DirectX Shader Compiler v1.8.2505.1](https://github.com/microsoft/DirectXShaderCompiler/releases/tag/v1.8.2505.1).
The [LLVM](./LICENSES/DXC-LLVM.txt), [Microsoft](./LICENSES/DXC-MS.txt) and
[MIT](./LICENSES/DXC-MIT.txt) license texts accompany the app in `licenses/DXC/`.
This runtime is not part of the npm library.

## Native glTF codecs

The viewer uses the native SDK glTF importer; see its [codec notices](../THIRD_PARTY_NOTICES.md#native-gltf-codecs).

## Example downloads and EXR environments

Example models and thumbnails are downloaded on demand and retain the licenses
and attribution linked in each catalog entry; they are not bundled with the app.
URL resolution uses [url 2.5.8](https://github.com/servo/rust-url) under
MIT/Apache-2.0. EXR environments use
[exr 1.74.2](https://github.com/johannesvollmer/exrs) and its decoding dependencies.
Their copyright notices and selected license texts accompany the app in
[EXR-Downloads.txt](./LICENSES/EXR-Downloads.txt).

## Poly Haven texture downloads

The viewer downloads CC0 textures from [Poly Haven](https://polyhaven.com/textures).
Its native HTTPS client uses [ureq](https://github.com/algesten/ureq) (MIT/Apache-2.0),
[rustls](https://github.com/rustls/rustls) (Apache-2.0/ISC/MIT), and their HTTP/TLS
dependencies. Their copyright notices and license texts are retained in
[HTTP-TLS.txt](./LICENSES/HTTP-TLS.txt), which accompanies the native app.


## Microsoft Visual C++ Runtime

The Windows viewer ships app-local release CRT DLLs from the installed MSVC
redistributable. Copyright Microsoft Corporation; Microsoft Software License
Terms apply. The package records their component and files in
`licenses/MSVC/RUNTIME.txt`; see the
[Microsoft redistribution list](https://learn.microsoft.com/visualstudio/releases/2022/redistribution).
