# Display

An engine's Display (`engine.display()` / `mt_engine_display`) composes a
render's image with tone mapping and effects, presents it, and exports RGBA8 or
PNG with `mt_display_read_pixels`. Display settings never restart accumulation
or change HDR readback.

## Display settings

Set Rust `DisplaySettings` or C `mt_display_settings` before presenting or
exporting:

```c
mt_display_settings settings;
mt_display_settings_default(&settings);
settings.vignette = 0.4f;
settings.bloom_intensity = 0.2f;
mt_display_set_settings(display, &settings, error, sizeof error);
```

The settings cover tone mapping (AgX by default, ACES, Cineon, Reinhard,
Linear), exposure, contrast, saturation, temperature, tint, vignette, bloom,
shadow catcher color and alpha, the output channel, and the HDR window request.
The header lists each default and range. C callers initialize the 68-byte record
with `mt_display_settings_default`; `struct_size` must match.

- **Bloom** is off by default (intensity 0); threshold 1, radius 0.6. It starts
  at 10 samples and refreshes every 10 samples, or when its threshold, radius or
  denoised input changes.
- **Shadow catchers**: materials marked as catchers show the background with
  received shadows in the catcher color (default black). Lowering the catcher
  alpha (0–1, default 1) removes faint shadows first. The `ShadowCatcher` /
  `MT_CHANNEL_SHADOW_CATCHER` channel shows raw coverage, background and shadow
  opacity; `Shadow` / `MT_CHANNEL_SHADOW` is the same as `Final`.
- Effects apply before custom passes and display scaling. Normal and albedo
  channels bypass them.
- An opaque solid background keeps its color regardless of exposure, grading
  and vignette, but can receive bloom and catcher shadows. Transparent and
  mapped backgrounds go through the display transforms. Output is sRGB encoded.
- OIDN filters the HDR color; catcher shadow opacity is not filtered, so shadow
  noise can remain after denoising.

Memory per render pixel, kept until the render is resized or disposed: bloom
about 51 bytes, shadow catcher scenes 48 bytes. Very small images cost more per
pixel.

## GPU images (Rust)

`Render::get_output_texture(OutputKind::Hdr | OutputKind::Display)` borrows an
image on the engine's device without CPU readback. Use it in commands submitted
before the next refine, converge, present, resize, restart, disposal or device
loss. Do not keep, write or destroy it. To share your own device and queue,
create the engine with `Engine::on_device`.

- **Hdr**: top-row-first RGBA32Float ray color and path coverage, before
  denoising and display settings. RGB is normalized by surface hits, as on
  WebGPU. Sampling it needs an unfilterable texture binding unless float32
  filtering is enabled.
- **Display**: the latest composition, including passes, as straight-alpha sRGB
  RGBA8Unorm at the render size.
- It returns `None` before a complete sample; Display also needs a previous
  presentation or export. Borrowing can enqueue a GPU resolve.

CPU HDR readback (`read_pixels(PixelKind::Hdr)` / `mt_render_read_pixels` with
`MT_IMAGE_HDR`) matches browser WebGPU readback: the same normalization, except
that an opaque visible flat background restores per-sample RGB; alpha stays path
coverage. It waits for the current batch and temporarily copies up to 48 GPU
bytes per pixel. CPU and GPU rounding can differ.

## Custom display passes (Rust)

`Display::add_post_process` adds a synchronous pass. This identity pass copies
its input to its output:

```rust
let display = engine.display();
let pass = display.add_post_process(|ctx| {
    ctx.encoder.copy_texture_to_texture(
        ctx.input.as_image_copy(), ctx.output.as_image_copy(), ctx.input.size(),
    );
    Ok(())
})?;
display.present(&render)?;
// Remove it with pass.remove() or by dropping pass.
```

- Passes run in registration order after composition and before display
  scaling, on every presentation and export. Registration and removal apply at
  the next composition; a finished render loop wakes to present them.
- Each pass receives the selected render (or its fallback), its size, and
  straight-alpha RGBA8Unorm input and output textures borrowed for the call.
  Write the whole output with commands in the supplied encoder, following
  wgpu's validation rules. Passes do not trace or invalidate denoising.
- An error or panic discards the whole chain for that composition, shows the
  unprocessed image and reports an engine error.
- Inside a pass, inspecting renders and registering passes is allowed; nested
  composition, and changing or releasing the selected image, are rejected.
- Caches per render pixel: HDR borrowing 16 bytes; display composition 4, plus
  8 while passes run. They last until the size changes or the render is
  released.

The C API offers CPU export only.

## Window presentation (Rust)

Create a wgpu surface from a window you own (for example
`Arc<winit::window::Window>`), request an adapter with `compatible_surface`, and
create the engine with `Engine::on_device` using that adapter's device and
queue. The instance, adapter and surface must belong together.

```rust
use mutracer_native_probe::api::SurfaceOptions;

let display = engine.display();
display.set_size(width, height)?; // physical pixels
display.attach_surface(surface, SurfaceOptions::default())?;
render_loop.tick()?; // present and tick now also draw to the window
// On resize, including zero size when minimized:
display.resize_surface(new_width, new_height)?;
```

[viewer/examples/surface.rs](../viewer/examples/surface.rs) is a complete host.

- The host owns the event loop and follows its window system's presentation
  rules (such as winit `pre_present_notify`). While a surface is attached, call
  the engine and its objects, including disposal, on the window thread.
- Share one `SubmissionGate` across engines that use the same device, and
  coordinate other queue users with surface configuration.
- Defaults: SDR RGBA/BGRA8, vsync, automatic alpha preferring an opaque window.
  `SurfaceOptions` can select a supported format, present mode, alpha mode and
  queued-frame limit.
- Presenting adds a fullscreen GPU draw and window framebuffers, with no CPU
  readback; acquiring frames and reconfiguring can block. Effects, passes and
  scaling apply; pixel and PNG exports are unchanged.

Check `surface_info().status` after presenting; `Display::present` reports the
offscreen image even when the window frame was skipped.

| Status | Action |
| --- | --- |
| Timeout | Schedule a later frame |
| Occluded | Wait for an expose or restore event instead of polling |
| Outdated | Reconfigured and retried once automatically |
| Lost | Recreate the surface and attach it again; the engine stays usable |

A zero window size suspends presentation and keeps the last positive size; a
positive size resumes it, and scale-sized renders resize at their next refine.
Attaching, resizing and pending window frames wake a finished render loop.
`detach_surface` returns the surface and keeps offscreen rendering. Device loss
releases the attachment and is [terminal](engine.md#device-loss).

## HDR window output (Rust)

Request HDR before or after attaching a surface:

```rust
let mut settings = display.settings();
settings.hdr_output_enabled = true;
display.set_settings(settings)?;
render_loop.tick()?;
let info = display.surface_info().unwrap();
// info.hdr_active reports whether HDR output is in use.
```

- The default is off. With `SurfaceOptions::format = None`, HDR uses
  RGBA16Float extended linear sRGB (scRGB) when supported. An explicit SDR
  format, or an unsupported request, stays SDR; `surface_info()` reports the
  requested and active state, color space and fallback reason.
- Changes apply at the next presentation and wake a finished render loop
  without restarting accumulation. Changing HDR mode inside a pass is rejected.
- HDR keeps values above 1 and skips the tone mapper; exposure, grading,
  vignette, bloom and catcher composition still apply. 1 is SDR reference
  white. `display_hdr_info()` reports the display's current headroom on the
  window thread (unknown fields are unset); negotiating HDR does not prove the
  panel can show brighter highlights. HDR10/PQ, HLG and wide-gamut output are
  not available.
- `Display::texture()`, pixel/PNG export and `add_post_process` passes stay SDR.
  Register HDR passes with `add_hdr_post_process`: they receive straight-alpha
  linear RGBA16Float images, run before scaling only while HDR is active, and
  follow the SDR pass rules.
- `Display::hdr_texture()` borrows the latest display-sized, premultiplied
  linear RGBA16Float window image until the next present or resize; it is `None`
  until HDR has presented. Do not write, destroy or keep it.
- Cost: an extra composition and scale per presentation; 8 bytes per render
  pixel (16 more while HDR passes run) and 8 bytes per display pixel. The
  display image is released when HDR is disabled or the surface is detached.

## C window presentation

Fill `mt_native_window` with a real window and call
`mt_engine_create_for_window`, which selects a compatible adapter and owns its
device. Present or tick normally.

| Kind | Platform | Handles |
| --- | --- | --- |
| `MT_WINDOW_APPKIT` (1) | macOS | `window` = `NSView*`; call on the main thread |
| `MT_WINDOW_WIN32` (2) | Windows | `window` = `HWND` |
| `MT_WINDOW_XLIB` (3) | Linux | `display` = `Display*`, `window_id` = Xlib Window on screen 0 |
| `MT_WINDOW_WAYLAND` (4) | Linux | `display` = `wl_display*`, `window` = `wl_surface*` |

- `mt_display_resize_window` takes physical pixels; zero suspends
  presentation. `mt_display_detach_window` releases the window before you
  destroy its handles; `mt_display_attach_window` replaces or restores it on the
  same device.
- The host pumps window events and keeps native handles valid until detach,
  replacement or engine destruction returns.
- Call the engine and all its objects, including destruction, on the creating
  window thread; only `mt_render_cancel` may cross threads.
- Options are fixed to vsync and automatic alpha, starting in SDR. Display
  settings can request HDR with SDR fallback; pixel and PNG export stay SDR.
- `mt_display_surface_info` reports the attachment, format, HDR state and last
  frame status. Retry later after a timeout or outdated surface, wait for an
  expose event while occluded, and reattach after loss. `mt_presented` can
  succeed while the window frame is skipped.
- C cannot import an external GPU device; Rust `Engine::on_device` can share
  one.

[examples/window-host.c](../examples/window-host.c) with
[window-appkit.m](../examples/window-appkit.m) is a macOS host.
