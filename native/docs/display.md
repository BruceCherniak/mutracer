# Display

An engine's Display (`engine.display()` / `mt_engine_display`) composes a
render's image with display settings, presents it, and exports RGBA8 or PNG
(`mt_display_read_pixels`). Settings, defaults and ranges are documented on
`DisplaySettings` / `mt_display_settings` and
`AovDisplayOptions` / `mt_display_aov_options`.

## Composition

Display settings never restart accumulation or change HDR readback. The final
channel composes denoised or raw color with tone mapping,
grading and effects (vignette, bloom, shadow catchers), then runs
[custom passes](#custom-display-passes-rust), then scales to the display size.

- Normal and albedo channels bypass display effects and denoising.
- An opaque solid background keeps its color regardless of exposure, grading
  and vignette, but can receive bloom and catcher shadows. Transparent and
  mapped backgrounds go through the display transforms.
- Bloom starts at 10 samples and refreshes every 10 samples, or when its
  settings or the denoised input change.
- OIDN filters the color, but shadow catcher opacity is not filtered, so shadow
  noise can remain after denoising.
- Memory per render pixel, kept until the render is resized or disposed: bloom
  about 51 bytes, shadow catcher scenes 48 bytes. Very small images cost more
  per pixel.

## AOV channels

Enable the desired [surface outputs](denoising.md#surface-outputs) on the render,
then select the matching `Channel` / `MT_CHANNEL_*` value. A missing render bit
reports `InvalidState` / `MT_ERROR_INVALID_STATE` on composition, even when a
custom denoiser requests the same output. An enabled output awaiting sampling
keeps the current presentation; export reports `InvalidState` until it is ready.
Selection never enables a missing output. With `RenderLoop::tick` /
`mt_render_loop_tick`, an enabled AOV channel samples independently of beauty and
denoising; the loop's progress reports that channel. Direct `Render::refine` and
`converge` retain their beauty-rendering behavior. ID and Motion use one center
sample; other AOVs stop at `aov_samples`. Switching back to Final resumes its
accumulation and retained denoising.

```rust
let mut settings = engine.display().settings();
settings.channel = Channel::Depth;
settings.aov.depth_range = [0., 20.];
engine.display().set_settings(settings)?;
engine.display().present(&render)?;
```

In C, initialize `mt_display_aov_options` with
`mt_display_aov_options_default`, edit it and call `mt_display_set_aov_options`.
The mapping and ordinary display settings are independent; updating either
preserves the other.

AOV images bypass tone mapping, grading, effects and denoising; custom display
passes still run. Channel and mapping changes retain raw pixels, beauty samples
and completed denoising. PNG and RGBA8 export use the same visualization.
Background and invalid reflectance or motion are transparent; accumulated
channels use their coverage as alpha. Normal and albedo retain their existing guide meaning.
The declaration comments describe each channel's color mapping.

Visualization retains 4 GPU bytes per render pixel for SDR and another 8 when
HDR is used, until the AOV resources are resized or disposed. HDR windows show
the same mapped colors in linear light, within SDR white.

## GPU images (Rust)

`Render::get_output_texture` borrows a render's HDR or display image on the
engine's device without CPU readback; `Display::texture()` borrows the
display-sized image. Each method documents how long the borrow stays valid. To
use your own device and queue, create the engine with `Engine::on_device`.
Borrowing HDR costs 16 bytes per render pixel; display composition 4.

## Custom display passes (Rust)

`Display::add_post_process` registers a synchronous pass. This identity pass
copies its input to its output:

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

Passes run in registration order on every presentation and export. A failing
pass discards the whole chain for that composition and reports an engine error.
`PostProcessContext` documents the borrowed images and encoder. Passes add two
4-byte images per render pixel while they run. C hosts can borrow images and
record native passes through [Vulkan interop](vulkan.md).

## Window presentation

**Rust**: create a wgpu surface from a window you own (for example
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
Share one `SubmissionGate` across engines that use the same device.

**C**: fill `mt_native_window` and call `mt_engine_create_for_window`, which
selects a compatible adapter and owns the device; then present or tick
normally. The header lists the supported window kinds and handles.
[examples/window-host.c](../examples/window-host.c) with
[window-appkit.m](../examples/window-appkit.m) is a macOS host.

In both APIs:

- The host owns and pumps the event loop, follows its window system's
  presentation rules (such as winit `pre_present_notify`), and keeps native
  handles valid until detach or destruction.
- While a window is attached, call the engine and all its objects, including
  disposal, on the window thread.
- After each presentation, check the surface status (`surface_info()` /
  `mt_display_surface_info`). The offscreen image is presented even when the
  window frame is skipped; `SurfaceStatus` and `mt_surface_status` say when to
  retry, wait for an expose event or reattach. A lost surface does not make the
  engine unusable.
- A zero window size suspends presentation; a positive size resumes it.
  Attaching, resizing and pending frames wake a finished render loop.
- Presenting adds a fullscreen GPU draw and window framebuffers, with no CPU
  readback. Acquiring frames and reconfiguring can block.

## HDR window output

Set `hdr_output_enabled` in the display settings, before or after attaching a
surface:

```rust
let mut settings = display.settings();
settings.hdr_output_enabled = true;
display.set_settings(settings)?;
render_loop.tick()?;
let info = display.surface_info().unwrap();
// info.hdr_active reports whether HDR output is in use.
```

- HDR uses extended linear sRGB (scRGB) RGBA16Float when the surface supports
  it and `SurfaceOptions::format` is `None`. Otherwise output stays SDR, and the
  surface info reports why.
- HDR keeps values above 1 and skips the tone mapper; exposure, grading,
  vignette, bloom and catcher composition still apply. 1 is SDR reference
  white. Negotiated HDR does not prove the panel can show brighter highlights;
  `display_hdr_info()` reports the display's current headroom.
- Only the window is HDR. `Display::texture()`, pixel and PNG export, and
  `add_post_process` passes stay SDR. HDR-window passes are registered
  separately with `add_hdr_post_process` (Rust), or through the
  [Vulkan C API](vulkan.md#add-a-display-pass).
- Cost: an extra composition and scale per presentation; 8 bytes per render
  pixel (16 more while HDR passes run) and 8 bytes per display pixel.
- HDR10/PQ, HLG and wide-gamut output are not available.
