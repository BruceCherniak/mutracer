//! SDR window presentation of the existing premultiplied display image.
use super::{Display, Result, Status, error};
use crate::GpuDevice;

/// Window presentation options. HDR output is not supported by this interface.
#[derive(Clone, Debug)]
pub struct SurfaceOptions {
    /// Default None: prefer a supported sRGB RGBA/BGRA8 format, then unorm.
    /// Explicit formats must be one of those four SDR formats.
    pub format: Option<wgpu::TextureFormat>,
    /// Default Fifo (vsync). Unsupported explicit modes return InvalidArgument.
    pub present_mode: wgpu::PresentMode,
    /// Default Auto: prefer opaque, then premultiplied, straight, or inherited alpha.
    /// Inherit leaves compositor alpha setup to the window host.
    pub alpha_mode: wgpu::CompositeAlphaMode,
    /// Maximum queued frames hint, at least 1. Default 2.
    pub desired_maximum_frame_latency: u32,
}
impl Default for SurfaceOptions {
    fn default() -> Self {
        Self {
            format: None,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: wgpu::CompositeAlphaMode::Auto,
            desired_maximum_frame_latency: 2,
        }
    }
}
/// Result of the last window presentation attempt. Offscreen output remains
/// readable when the window is suspended, occluded, timed out, outdated or lost.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceStatus {
    /// Attached or resized; waiting for a complete image to present.
    Ready,
    Presented,
    /// Retry on a later frame.
    Timeout,
    /// Retry when the host receives an expose/restore event.
    Occluded,
    /// Reconfiguration was insufficient; retry on a later frame.
    Outdated,
    /// Recreate the surface and attach it again. The engine is still usable.
    Lost,
    /// Zero window width or height; restore with resize_surface.
    Suspended,
    /// A surface validation failure; the call also returned an error.
    Error,
}
/// Configuration and most recent result of an attached window surface.
#[derive(Clone, Debug)]
pub struct SurfaceInfo {
    /// Physical window dimensions; may be zero while suspended.
    pub size: [u32; 2],
    pub format: wgpu::TextureFormat,
    pub present_mode: wgpu::PresentMode,
    pub alpha_mode: wgpu::CompositeAlphaMode,
    pub status: SurfaceStatus,
}
const FORMATS: [wgpu::TextureFormat; 4] = [
    wgpu::TextureFormat::Bgra8UnormSrgb,
    wgpu::TextureFormat::Rgba8UnormSrgb,
    wgpu::TextureFormat::Bgra8Unorm,
    wgpu::TextureFormat::Rgba8Unorm,
];
fn configuration(
    caps: &wgpu::SurfaceCapabilities,
    options: &SurfaceOptions,
    size: [u32; 2],
) -> Result<wgpu::SurfaceConfiguration> {
    let format = match options.format {
        Some(format) if FORMATS.contains(&format) && caps.formats.contains(&format) => format,
        Some(_) => {
            return Err(error(
                Status::InvalidArgument,
                "Unsupported SDR surface format",
            ));
        }
        None => FORMATS
            .into_iter()
            .find(|f| caps.formats.contains(f))
            .ok_or_else(|| error(Status::Unavailable, "No compatible SDR window format"))?,
    };
    let present_mode = match options.present_mode {
        wgpu::PresentMode::AutoVsync => [wgpu::PresentMode::FifoRelaxed, wgpu::PresentMode::Fifo]
            .into_iter()
            .find(|m| caps.present_modes.contains(m)),
        wgpu::PresentMode::AutoNoVsync => [
            wgpu::PresentMode::Immediate,
            wgpu::PresentMode::Mailbox,
            wgpu::PresentMode::Fifo,
        ]
        .into_iter()
        .find(|m| caps.present_modes.contains(m)),
        mode => caps.present_modes.contains(&mode).then_some(mode),
    }
    .ok_or_else(|| error(Status::InvalidArgument, "Unsupported surface present mode"))?;
    let alpha_mode = match options.alpha_mode {
        wgpu::CompositeAlphaMode::Auto => [
            wgpu::CompositeAlphaMode::Opaque,
            wgpu::CompositeAlphaMode::PreMultiplied,
            wgpu::CompositeAlphaMode::PostMultiplied,
            wgpu::CompositeAlphaMode::Inherit,
        ]
        .into_iter()
        .find(|m| caps.alpha_modes.contains(m)),
        mode => caps.alpha_modes.contains(&mode).then_some(mode),
    }
    .ok_or_else(|| error(Status::InvalidArgument, "Unsupported surface alpha mode"))?;
    if options.desired_maximum_frame_latency == 0 || size.contains(&0) {
        return Err(error(
            Status::InvalidArgument,
            "Invalid surface dimensions or frame latency",
        ));
    }
    Ok(wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        color_space: wgpu::SurfaceColorSpace::Auto,
        width: size[0],
        height: size[1],
        present_mode,
        alpha_mode,
        desired_maximum_frame_latency: options.desired_maximum_frame_latency,
        view_formats: vec![],
    })
}
impl Display {
    /// Attaches an owned window surface, replacing any previous attachment. The
    /// engine must come from Engine::on_device with an adapter selected for this
    /// surface. Use an owned window handle (for example Arc<Window>) to create a
    /// 'static surface. The display keeps it alive until detach/dispose/device loss.
    /// Default options give SDR, vsync and automatic alpha. Window size starts
    /// at Display::size; call resize_surface with physical dimensions on resize.
    /// While attached, use the engine and its objects on the window thread,
    /// including disposal.
    /// The host must coordinate any other submissions/configuration on this device.
    /// Share one SubmissionGate across native engines using this device.
    pub fn attach_surface(
        &self,
        surface: wgpu::Surface<'static>,
        options: SurfaceOptions,
    ) -> Result<()> {
        let mut state = self.engine.live()?;
        if state.display.processing {
            return Err(error(
                Status::InvalidState,
                "Cannot attach a surface during composition",
            ));
        }
        let adapter = self.engine.inner.adapter.as_ref().ok_or_else(|| {
            error(
                Status::InvalidState,
                "Window presentation requires Engine::on_device",
            )
        })?;
        let config = configuration(
            &surface.get_capabilities(adapter),
            &options,
            state.display.size,
        )?;
        let blit = SurfaceBlit::new(
            &self.engine.inner.gpu.device,
            config.format,
            config.alpha_mode,
        );
        state.display.surface = Some(SurfaceTarget {
            surface,
            size: state.display.size,
            config,
            blit,
            status: SurfaceStatus::Ready,
            dirty: true,
        });
        Ok(())
    }
    /// Removes the window attachment, returning it to the host. Offscreen output
    /// and renders remain usable. Returns None if no surface was attached.
    pub fn detach_surface(&self) -> Result<Option<wgpu::Surface<'static>>> {
        let mut state = self.engine.live()?;
        if state.display.processing {
            return Err(error(
                Status::InvalidState,
                "Cannot detach a surface during composition",
            ));
        }
        Ok(state.display.surface.take().map(|s| s.surface))
    }
    /// Physical window size. Zero width or height suspends window presentation
    /// and retains the last positive display/render size. A positive size updates
    /// Display::size and scale-sized renders at their next refine. Requires an
    /// attachment; configuration is deferred until the next complete presentation.
    pub fn resize_surface(&self, width: u32, height: u32) -> Result<()> {
        let mut state = self.engine.live()?;
        if state.display.surface.is_none() {
            return Err(error(Status::InvalidState, "No window surface attached"));
        }
        let max = self
            .engine
            .inner
            .gpu
            .device
            .limits()
            .max_texture_dimension_2d;
        if width > max || height > max {
            return Err(error(
                Status::InvalidArgument,
                "Surface size exceeds device limits",
            ));
        }
        if width > 0 && height > 0 {
            state.display.size = [width, height];
        }
        state
            .display
            .surface
            .as_mut()
            .unwrap()
            .resize([width, height]);
        Ok(())
    }
    /// None without an attachment, after disposal or after device loss.
    pub fn surface_info(&self) -> Option<SurfaceInfo> {
        let state = self.engine.lock();
        state.display.surface.as_ref().map(|s| SurfaceInfo {
            size: s.size,
            format: s.config.format,
            present_mode: s.config.present_mode,
            alpha_mode: s.config.alpha_mode,
            status: s.status,
        })
    }
}
pub(super) struct SurfaceTarget {
    surface: wgpu::Surface<'static>,
    size: [u32; 2],
    config: wgpu::SurfaceConfiguration,
    blit: SurfaceBlit,
    status: SurfaceStatus,
    dirty: bool,
}
impl SurfaceTarget {
    pub(super) fn resize(&mut self, size: [u32; 2]) {
        if self.size != size {
            self.size = size;
            self.dirty = true;
            if self.status != SurfaceStatus::Lost {
                self.status = if size.contains(&0) {
                    SurfaceStatus::Suspended
                } else {
                    SurfaceStatus::Ready
                };
            }
        }
    }
    pub(super) fn pending(&self) -> bool {
        !matches!(
            self.status,
            SurfaceStatus::Suspended | SurfaceStatus::Lost | SurfaceStatus::Error
        ) && (self.dirty || self.status != SurfaceStatus::Presented)
    }
    pub(super) fn present(&mut self, gpu: &GpuDevice, image: &wgpu::Texture) -> Result<()> {
        if self.size.contains(&0) || self.status == SurfaceStatus::Lost {
            return Ok(());
        }
        let configure = |this: &mut Self| {
            this.config.width = this.size[0];
            this.config.height = this.size[1];
            gpu.queue
                .configure_surface(&this.surface, &gpu.device, &this.config);
            this.dirty = false;
        };
        if self.dirty {
            configure(self);
        }
        // wgpu 30 distinguishes Outdated (reconfigure) from Lost (recreate).
        // Never reconfigure while an acquired SurfaceTexture is still alive.
        for attempt in 0..2 {
            let (frame, suboptimal) = match self.surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(frame) => (frame, false),
                wgpu::CurrentSurfaceTexture::Suboptimal(frame) => (frame, true),
                wgpu::CurrentSurfaceTexture::Outdated => {
                    self.status = SurfaceStatus::Outdated;
                    self.dirty = true;
                    if attempt == 0 {
                        configure(self);
                        continue;
                    }
                    return Ok(());
                }
                wgpu::CurrentSurfaceTexture::Timeout => {
                    self.status = SurfaceStatus::Timeout;
                    return Ok(());
                }
                wgpu::CurrentSurfaceTexture::Occluded => {
                    self.status = SurfaceStatus::Occluded;
                    return Ok(());
                }
                wgpu::CurrentSurfaceTexture::Lost => {
                    self.status = SurfaceStatus::Lost;
                    return Ok(());
                }
                wgpu::CurrentSurfaceTexture::Validation => {
                    self.status = SurfaceStatus::Error;
                    return Err(error(Status::Error, "Window surface validation failed"));
                }
            };
            let view = frame.texture.create_view(&Default::default());
            self.blit.draw(gpu, image, &view);
            gpu.queue.present(frame);
            self.dirty = suboptimal;
            self.status = SurfaceStatus::Presented;
            return Ok(());
        }
        Ok(())
    }
}
// Input RGB is already sRGB encoded and premultiplied in that encoding. Decode
// only when an sRGB attachment will encode again; don't double-encode the image.
const BLIT: &str = r#"
@group(0) @binding(0) var image: texture_2d<f32>;
override srgb_attachment: bool = false;
override straight_alpha: bool = false;
override opaque: bool = false;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  var pixel = textureLoad(image, vec2i(p.xy), 0);
  if (straight_alpha) { pixel = vec4f(select(vec3f(0.0), pixel.rgb / max(pixel.a, 0.000001), pixel.a > 0.0), pixel.a); }
  if (srgb_attachment) {
    pixel = vec4f(select(pow((pixel.rgb + 0.055) / 1.055, vec3f(2.4)), pixel.rgb / 12.92, pixel.rgb <= vec3f(0.04045)), pixel.a);
  }
  if (opaque) { pixel.a = 1.0; }
  return pixel;
}
"#;
struct SurfaceBlit {
    pipeline: wgpu::RenderPipeline,
}
impl SurfaceBlit {
    fn new(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        alpha: wgpu::CompositeAlphaMode,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("MuTracer window SDR blit"),
            source: wgpu::ShaderSource::Wgsl(BLIT.into()),
        });
        Self {
            pipeline: device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("MuTracer window presentation"),
                layout: None,
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs"),
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants: &[
                            ("srgb_attachment", if format.is_srgb() { 1. } else { 0. }),
                            (
                                "straight_alpha",
                                if alpha == wgpu::CompositeAlphaMode::PostMultiplied {
                                    1.
                                } else {
                                    0.
                                },
                            ),
                            (
                                "opaque",
                                if alpha == wgpu::CompositeAlphaMode::Opaque {
                                    1.
                                } else {
                                    0.
                                },
                            ),
                        ],
                        ..Default::default()
                    },
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            }),
        }
    }
    fn draw(&self, gpu: &GpuDevice, image: &wgpu::Texture, target: &wgpu::TextureView) {
        let input = image.create_view(&Default::default());
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.pipeline.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&input),
            }],
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("MuTracer window"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([encoder.finish()]);
    }
}
#[cfg(test)]
mod tests;
