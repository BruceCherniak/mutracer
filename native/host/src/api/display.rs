//! Display settings, presentation and export over the shared display composition.
use super::engine::{Engine, State};
use super::render::{Readiness, Render, readiness};
use super::{Result, Status, error};

/// Tone mapping transform.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ToneMapping {
    #[default]
    Agx,
    Aces,
    Cineon,
    Reinhard,
    Linear,
}
/// Displayed image channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Channel {
    #[default]
    Final,
    Normal,
    Albedo,
}
/// Display-only settings shared by every render presented on the engine display.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplaySettings {
    /// Default [`ToneMapping::Agx`].
    pub tone_mapping: ToneMapping,
    /// Linear exposure multiplier. Default 1.
    pub tone_mapping_exposure: f32,
    /// Contrast multiplier. Default 1.
    pub contrast: f32,
    /// Saturation multiplier. Default 1.
    pub saturation: f32,
    /// White balance temperature shift in -1–1. Default 0.
    pub temperature: f32,
    /// Green/magenta tint in -1–1. Default 0.
    pub tint: f32,
    /// Default [`Channel::Final`].
    pub channel: Channel,
}
impl Default for DisplaySettings {
    fn default() -> Self {
        Self {
            tone_mapping: ToneMapping::Agx,
            tone_mapping_exposure: 1.,
            contrast: 1.,
            saturation: 1.,
            temperature: 0.,
            tint: 0.,
            channel: Channel::Final,
        }
    }
}
impl DisplaySettings {
    fn validate(&self) -> Result<()> {
        let values = [
            self.tone_mapping_exposure,
            self.contrast,
            self.saturation,
            self.temperature,
            self.tint,
        ];
        if values.iter().any(|v| !v.is_finite()) {
            return Err(error(
                Status::InvalidArgument,
                "Display settings must be finite",
            ));
        }
        Ok(())
    }
    pub(super) fn composition(&self) -> crate::display::Settings {
        crate::display::Settings {
            tone_mapping: self.tone_mapping as u32,
            exposure: self.tone_mapping_exposure,
            contrast: self.contrast,
            saturation: self.saturation,
            temperature: self.temperature,
            tint: self.tint,
            output: self.channel as u32,
            preserve_alpha: true,
        }
    }
}
/// The image shown by a successful [`Display::present`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Presented {
    /// Whether the render's fallback was shown instead of the render.
    pub fallback: bool,
    /// Size of the presented render image before scaling to the display.
    pub width: u32,
    pub height: u32,
    pub samples: u32,
}

/// Which render to present: the browser `Display.present` rule. With the final
/// channel and a fallback, the render must be presentable (denoising does not hide
/// its first image); otherwise complete.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Selection {
    Render,
    Fallback,
}
pub(super) fn select(
    final_channel: bool,
    render: Readiness,
    fallback: Option<Readiness>,
) -> Option<Selection> {
    let ready = |r: Readiness| {
        if final_channel {
            r.presentable
        } else {
            r.complete
        }
    };
    let render_ready = if final_channel && fallback.is_some() {
        render.presentable
    } else {
        render.complete
    };
    if render_ready {
        Some(Selection::Render)
    } else if fallback.is_some_and(ready) {
        Some(Selection::Fallback)
    } else {
        None
    }
}

struct Blit {
    pipeline: wgpu::ComputePipeline,
    sampler: wgpu::Sampler,
}
pub(super) struct DisplayState {
    pub(super) size: [u32; 2],
    pub(super) settings: DisplaySettings,
    texture: Option<wgpu::Texture>,
    blit: Option<Blit>,
}
impl Default for DisplayState {
    /// The browser's default canvas size.
    fn default() -> Self {
        Self {
            size: [300, 150],
            settings: DisplaySettings::default(),
            texture: None,
            blit: None,
        }
    }
}
const BLIT: &str = r#"
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  textureStore(output, id.xy, textureSampleLevel(source, source_sampler, uv, 0.0));
}
"#;

/// Offscreen presentation and shared display settings; obtained from [`Engine::display`].
pub struct Display {
    pub(super) engine: Engine,
}
impl Display {
    /// Default 300×150, the browser canvas default.
    pub fn size(&self) -> [u32; 2] {
        self.engine.lock().display.size
    }
    /// Resizes the presentation texture; scale-based renders resize at their next refine.
    pub fn set_size(&self, width: u32, height: u32) -> Result<()> {
        if width == 0 || height == 0 {
            return Err(error(
                Status::InvalidArgument,
                "Display dimensions must be positive",
            ));
        }
        self.engine.live()?.display.size = [width, height];
        Ok(())
    }
    pub fn settings(&self) -> DisplaySettings {
        self.engine.lock().display.settings
    }
    pub fn set_settings(&self, settings: DisplaySettings) -> Result<()> {
        settings.validate()?;
        self.engine.live()?.display.settings = settings;
        Ok(())
    }
    /// The presentation texture: display-sized premultiplied RGBA8 (sRGB-encoded
    /// values in an `Rgba8Unorm` texture), top row first, with TEXTURE_BINDING and
    /// COPY_SRC usage. It is replaced when the display size changes and keeps the
    /// last presented image otherwise. `None` before the first present, after
    /// device loss or after disposal.
    pub fn texture(&self) -> Option<wgpu::Texture> {
        let state = self.engine.lock();
        if state.device_failed || state.disposed {
            None
        } else {
            state.display.texture.clone()
        }
    }
    /// Composes and shows the render's complete image, or its fallback's. Smaller
    /// images are scaled linearly to the display size. Returns `None` and keeps the
    /// previous image when neither is ready, for example during scene preparation.
    /// Does not trace.
    pub fn present(&self, render: &Render) -> Result<Option<Presented>> {
        self.check(render)?;
        let mut state = self.engine.live()?;
        let state = &mut *state;
        let id = render.id();
        let Some(primary) = state.renders.get(&id) else {
            return Err(error(Status::InvalidHandle, "Render is disposed"));
        };
        let fallback = primary.fallback;
        let selection = select(
            state.display.settings.channel == Channel::Final,
            readiness(state, id),
            fallback.map(|f| readiness(state, f)),
        );
        let selected = match selection {
            None => return Ok(None),
            Some(Selection::Render) => id,
            Some(Selection::Fallback) => fallback.unwrap(),
        };
        let gpu = &self.engine.inner.gpu;
        let settings = state.display.settings.composition();
        let size = state.display.size;
        if state
            .display
            .texture
            .as_ref()
            .is_none_or(|t| [t.width(), t.height()] != size)
        {
            state.display.texture = Some(gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("MuTracer display"),
                size: wgpu::Extent3d {
                    width: size[0],
                    height: size[1],
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::STORAGE_BINDING
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            }));
        }
        let blit = state.display.blit.get_or_insert_with(|| Blit {
            pipeline: gpu
                .device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("MuTracer display scale"),
                    layout: None,
                    module: &gpu
                        .device
                        .create_shader_module(wgpu::ShaderModuleDescriptor {
                            label: Some("MuTracer display scale"),
                            source: wgpu::ShaderSource::Wgsl(BLIT.into()),
                        }),
                    entry_point: Some("main"),
                    compilation_options: Default::default(),
                    cache: None,
                }),
            sampler: gpu.device.create_sampler(&wgpu::SamplerDescriptor {
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
        });
        let target = state.display.texture.as_ref().unwrap();
        let render_state = &state.renders[&selected];
        let capture = render_state.capture.as_ref().unwrap();
        capture.compose_with(&settings);
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        if capture.size == size {
            encoder.copy_texture_to_texture(
                capture.texture.as_image_copy(),
                target.as_image_copy(),
                target.size(),
            );
        } else {
            let source = capture.texture.create_view(&Default::default());
            let output = target.create_view(&Default::default());
            let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &blit.pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&source),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&blit.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(&output),
                    },
                ],
            });
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&blit.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(size[0].div_ceil(8), size[1].div_ceil(8), 1);
        }
        gpu.queue.submit([encoder.finish()]);
        Ok(Some(Presented {
            fallback: selected != id,
            width: capture.size[0],
            height: capture.size[1],
            samples: render_state.presented_samples(),
        }))
    }
    /// The render's complete image composed with these settings at its own size:
    /// straight-alpha RGBA8, top row first. Leaves the presentation texture unchanged.
    pub fn read_rgba8(&self, render: &Render) -> Result<(u32, u32, Vec<u8>)> {
        self.check(render)?;
        let state = self.engine.live()?;
        let capture = Self::complete(&state, render.id())?;
        let rgba = capture
            .read_rgba(&state.display.settings.composition())
            .map_err(|e| error(Status::Error, e.to_string()))?;
        Ok((capture.size[0], capture.size[1], rgba))
    }
    /// [`Display::read_rgba8`] encoded as PNG.
    pub fn encode_png(&self, render: &Render) -> Result<Vec<u8>> {
        let (width, height, rgba) = self.read_rgba8(render)?;
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .and_then(|mut writer| writer.write_image_data(&rgba))
            .map_err(|e| error(Status::Error, format!("PNG encoding failed: {e}")))?;
        Ok(bytes)
    }
    fn check(&self, render: &Render) -> Result<()> {
        if !std::sync::Arc::ptr_eq(&render.engine().inner, &self.engine.inner) {
            return Err(error(
                Status::InvalidArgument,
                "Render belongs to another engine",
            ));
        }
        Ok(())
    }
    fn complete(state: &State, id: u64) -> Result<&crate::display::Display> {
        if !state.renders.contains_key(&id) {
            return Err(error(Status::InvalidHandle, "Render is disposed"));
        }
        if !readiness(state, id).complete {
            return Err(error(Status::InvalidState, "Render has no complete image"));
        }
        Ok(state.renders[&id].capture.as_ref().unwrap())
    }
}
