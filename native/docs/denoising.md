# Denoising

Denoising never changes a render's accumulation: raw HDR and guide readback keep
following the samples. Output can differ from the browser library's denoisers.

## Denoise a render

Set OIDN on a render with Rust `Render::set_denoiser(Some(DenoiserOptions))` or
C `mt_render_set_denoiser` (initialize `mt_render_denoiser` with
`mt_render_denoiser_default`). Pass None/NULL to disable it.

| Schedule | Runs |
| --- | --- |
| `Converged` (default) | Once, when the render reaches `max_samples` |
| `Progressive` | At 1 sample, then at twice the last denoised count (at least 4) up to `max_samples`; after 10 s without a result, at the next sample |
| `EverySample` | After every complete batch |

Progressive and every-sample sampling pauses while a filter runs, and the last
filtered image (with its coverage and catcher layers) stays presented until the
next result. Display settings still apply to it. Keeping a filtered result adds
48 bytes per render pixel of GPU memory, plus 48 for shadow catcher scenes,
until the filter is disabled or the render restarts.

- `converge` denoises after its last sample and waits for the result.
- `denoise_current` / `mt_render_denoise_current` filters the current samples
  without tracing, for example when the host has paused; call it again to
  collect the result.
- Read the result with `PixelKind::Denoised` / `MT_IMAGE_DENOISED` (HDR when no
  denoised image exists). `mt_render_info` reports the denoised sample count,
  filter time, device and failures.

## Custom denoisers

Install a Rust `Arc<dyn CustomDenoiser>` with `render.set_custom_denoiser`, or
an `mt_custom_denoiser` callback with `mt_render_set_custom_denoiser`. It uses
the same schedules and replaces OIDN; `set_denoiser` replaces a custom filter in
turn. None/NULL disables filtering.

**Inputs**: owned linear RGBA32F color, normal and albedo arrays, bottom row
first. Color is the raw per-sample average including the background, with path
coverage in alpha; it is not normalized by surface hits like
[HDR readback](display.md#gpu-images-rust). **Output**: the same size and
layout with finite values.

- Reading the inputs can block the API call; the callback runs on a library
  thread.
- Rust filters can request GPU input buffers with `gpu_inputs()`, use the
  supplied device and submission access, and return a CPU array or a `COPY_SRC`
  GPU buffer on that device. GPU input currently adds an upload after readback;
  GPU output adds a readback on the worker. C callbacks receive CPU arrays.
- Poll the cancellation token (`mt_denoise_cancelled`) to stop early. Cancel,
  clear, replacement and destruction do not wait for the callback; late results
  are discarded. A stuck callback keeps its inputs and filter alive.
- Callbacks can overlap after a replacement, so filters must allow concurrent
  calls. They may call the API but must not unwind across C. Window engines
  reject calls from worker threads.
- C ownership: input, output, error and cancellation pointers expire when the
  callback returns. Registration transfers `user`; `release` runs once, off the
  calling thread, after the last call finishes. Keep the callback code loaded
  until `release` returns, and omit `release` only for process-lifetime code
  and data.

An error, invalid output or caught panic produces a denoise report and an
engine error event, and stops scheduled filtering until the filter is set again;
`converge` returns an error. The unfiltered accumulation stays available.
Cancellation and timeout end `converge`'s wait even if the callback ignores
them.

## Denoise your own images

[mutracer-denoise.h](../include/mutracer-denoise.h) runs OIDN on images you
supply, independently of any render: `mt_denoiser_create`, `mt_denoiser_run`,
`mt_denoiser_destroy`.

- Inputs: color, normal and albedo as finite linear RGBA32F with matching size
  and row order, such as `mt_context_read_pixels` output. All three are
  required; at most 4,194,304 pixels.
- Output keeps the color alpha, can alias an input, and is left unchanged when
  a call fails.
- Calls block and use extra image memory; run them on a worker if needed. Any
  thread may call; overlapping operations return `MT_ERROR_BUSY`.

[examples/denoise-host.c](../examples/denoise-host.c) is a complete program.

## OIDN runtime

OIDN 2.5.1 and its matching device modules are not part of the native library.
The [native viewer](../viewer/README.md) bundles them. The library is found in
this order:

1. The explicit path (`library` option or `mt_denoiser_create` argument).
2. `MUTRACER_OIDN_LIBRARY`.
3. Beside the executable: `../Frameworks/libOpenImageDenoise.2.dylib` on macOS,
   `OpenImageDenoise.dll` on Windows, `libOpenImageDenoise.so.2` on Linux.

`mt_denoiser_create` returns `MT_ERROR_UNAVAILABLE` when the library or the
requested backend is unavailable; a render reports the failure in
`mt_render_info`.

| Backend | Behavior |
| --- | --- |
| Auto (default) | Tries Metal, CUDA, HIP, then CPU |
| CPU, Metal, CUDA, HIP | That backend only; never falls back |

GPU backends need supported hardware and drivers; HIP also needs the matching
AMD HIP runtime. See
[OIDN's system requirements](https://github.com/RenderKit/oidn/blob/v2.5.1/README.md#system-requirements).
