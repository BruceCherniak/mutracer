# Denoising

Denoising never changes a render's accumulation: raw HDR and guide readback keep
following the samples. Output can differ from the browser library's denoisers.

## Denoise a render

Set a built-in backend with `Render::set_denoiser` / `mt_render_set_denoiser`, or a
[custom filter](#custom-denoisers). The schedule (`DenoiseSchedule` /
`mt_denoise_schedule`) is Converged (default), Progressive or EverySample.

- `converge` denoises after its last sample and waits for the result.
- With Progressive and EverySample, sampling pauses while a filter runs and the
  last filtered image stays presented until the next one. Keeping it costs 48
  bytes per render pixel of GPU memory, plus 48 for shadow catcher scenes.
  oidn-webgpu also retains 16 bytes per pixel for HDR pixel readback.
- A host that stops refining (for example when paused) calls `denoise_current`
  to filter the current samples.
- Read the result with `PixelKind::Denoised` / `MT_IMAGE_DENOISED`.
  `mt_render_info` reports the denoised sample count, time, device and
  failures.

## oidn-webgpu

Select `DENOISE_OIDN_WEBGPU` in Rust or `MT_DENOISE_OIDN_WEBGPU` in C as the
backend of `set_denoiser`. It uses the rendering device and keeps inputs and
output on the GPU. Reading `Denoised` pixels still transfers that requested
image to the CPU.

```rust
render.set_denoiser(Some(DenoiserOptions {
    backend: DENOISE_OIDN_WEBGPU,
    max_tile_size: 512,
    ..Default::default()
}))?;
```

A standard model is bundled, so no weight download is needed. For custom weights,
use `DenoiserOptions::library` / `mt_render_denoiser.library` with an HDR/PU TZA
that takes color, albedo and normal. The render backend supplies sampled guides;
clean-aux weights that require prefiltered guides are not supported.

Rust callers can lower `max_tile_size` to reduce temporary GPU memory at the
cost of overlapping work. The C render interface uses whole-image inference.
Preparing the first image or a new size can block; later frames reuse that
preparation.

Color is normalized like `MT_IMAGE_HDR`, guides are per-sample averages, and
color alpha passes through unchanged. The filter uses HDR/PU with input scale 1;
OIDN uses its automatic exposure by default, so the results can differ.
Matrix kernels require cooperative-matrix support; Windows requires Vulkan for
these kernels. DX12 and devices without that support use implicit GEMM.
A caller-owned device uses only the features enabled by its host.

After device loss, create a new engine.

## Custom denoisers

Install a Rust `CustomDenoiser` with `Render::set_custom_denoiser`, or an
`mt_custom_denoiser` callback with `mt_render_set_custom_denoiser`. A custom
filter and a built-in backend replace each other. `DenoiseInput` /
`mt_denoise_input` and the callback types document inputs, outputs, ownership and
cancellation.

- Inputs are the raw per-sample color, bottom row first. They are not
  normalized by surface hits like `MT_IMAGE_HDR` readback.
- Each call copies its inputs on the GPU, 48 bytes per render pixel, so later
  rendering cannot overwrite them. Readback and the filter run on a library
  thread. Cancellation, clearing, replacement and destruction never wait for it,
  and late results are discarded, so calls can overlap.
- Rust filters that return `DenoiseInputMode::ResidentGpu` from `input_mode`
  receive the copies as GPU buffers and return a GPU result, with no CPU
  transfer; the result keeps 16 more bytes per pixel. See
  [custom-gpu-denoiser.rs](../host/examples/custom-gpu-denoiser.rs).
  `gpu_inputs` instead uploads the CPU arrays again. C callbacks receive CPU
  arrays.
- The inputs are the accumulated color and guides; no depth, motion or other
  temporal inputs are provided.
- An error, invalid output or panic produces an engine error event and stops
  scheduled filtering until a filter is set again; `converge` returns an error.
  The unfiltered accumulation stays available.

## Denoise your own images

[mutracer-denoise.h](../include/mutracer-denoise.h) runs OIDN on caller-owned
color, normal and albedo images, such as `mt_context_read_pixels` output,
independently of any render. Calls block; run them on a worker if needed.
[examples/denoise-host.c](../examples/denoise-host.c) is a complete program.

## OIDN runtime

The optional SDK backends require OIDN 2.5.1 and matching device modules,
separately from the native library. Pass a library path, set
`MUTRACER_OIDN_LIBRARY`, or ship the library beside the executable as described
in `mutracer-denoise.h`.

The Auto backend tries Metal, CUDA, HIP, then CPU; explicit backends never fall
back. GPU backends need supported hardware and drivers, and HIP also needs the
matching AMD HIP runtime; see
[OIDN's system requirements](https://github.com/RenderKit/oidn/blob/v2.5.1/README.md#system-requirements).
