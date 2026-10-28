//! Shared browser JNLM passes over composed linear color and stable guide moments.
use super::{Display, Settings, effects::Effects, image};
use crate::{GpuDevice, Result};
use wgpu::util::DeviceExt;

/// Joint non-local means display filter. Defaults match the browser viewer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Options {
    /// Positive strength multiplier. Default 1.
    pub strength: f32,
    /// Integer search radius 1–16. Default 5.
    pub search_radius: u32,
    /// Integer comparison patch radius 0–3. Default 1.
    pub patch_radius: u32,
    /// Relative albedo tolerance, 0.0001–10. Default 0.4.
    pub albedo_bandwidth: f32,
    /// Encoded normal tolerance, 0.0001–10. Default 0.05.
    pub normal_bandwidth: f32,
    /// Passes 1–4, doubling spacing each time. Default 2.
    pub iterations: u32,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            strength: 1.,
            search_radius: 5,
            patch_radius: 1,
            albedo_bandwidth: 0.4,
            normal_bandwidth: 0.05,
            iterations: 2,
        }
    }
}
impl Options {
    pub(crate) fn valid(self) -> bool {
        self.strength.is_finite()
            && self.strength > 0.
            && (1..=16).contains(&self.search_radius)
            && self.patch_radius <= 3
            && self.albedo_bandwidth.is_finite()
            && (0.0001..=10.).contains(&self.albedo_bandwidth)
            && self.normal_bandwidth.is_finite()
            && (0.0001..=10.).contains(&self.normal_bandwidth)
            && (1..=4).contains(&self.iterations)
    }
}
#[derive(Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShaderSources {
    guide: String,
    variance: String,
    prepare: String,
    filter: String,
    encode: String,
    composed: String,
    albedo: String,
    #[serde(rename = "composedHDR")]
    composed_hdr: String,
    #[serde(rename = "albedoHDR")]
    albedo_hdr: String,
    workgroup_size: u32,
    parameters: Vec<[u32; 4]>,
}
unsafe extern "C" {
    fn mt_core_jnlm(
        width: u32,
        height: u32,
        strength: f64,
        search_radius: u32,
        patch_radius: u32,
        albedo_bandwidth: f64,
        normal_bandwidth: f64,
        iterations: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
}
impl ShaderSources {
    fn generate(size: [u32; 2], options: Options) -> Result<Self> {
        crate::runtime::call(move || {
            let mut pointer = std::ptr::null();
            let mut length = 0;
            unsafe {
                mt_core_jnlm(
                    size[0],
                    size[1],
                    options.strength as f64,
                    options.search_radius,
                    options.patch_radius,
                    options.albedo_bandwidth as f64,
                    options.normal_bandwidth as f64,
                    options.iterations,
                    &mut pointer,
                    &mut length,
                );
            }
            let bytes = unsafe { crate::copy_core_result(pointer, length, length)? };
            unsafe {
                crate::mt_core_collect();
            }
            Ok(serde_json::from_slice(&bytes)?)
        })
    }
}
pub(super) struct Jnlm {
    size: [u32; 2],
    options: Options,
    parameters: Vec<[u32; 4]>,
    workgroup_size: u32,
    composition: [String; 2],
    composition_hdr: [String; 2],
    hdr_output: Option<wgpu::Texture>,
    hdr_encode: std::sync::OnceLock<wgpu::ComputePipeline>,
    composed: wgpu::Texture,
    albedo_texture: wgpu::Texture,
    output: wgpu::Texture,
    guides: [wgpu::Buffer; 2],
    colors: [wgpu::Buffer; 2],
    normal: wgpu::Buffer,
    albedo: wgpu::Buffer,
    shadow: wgpu::Buffer,
    guide: wgpu::ComputePipeline,
    variance: wgpu::ComputePipeline,
    load: wgpu::ComputePipeline,
    filter: wgpu::ComputePipeline,
    encode: wgpu::ComputePipeline,
    key: Option<(u64, Settings, bool, bool)>,
}
fn b(buffer: &wgpu::Buffer) -> wgpu::BindingResource<'_> {
    buffer.as_entire_binding()
}
impl Jnlm {
    pub(super) fn new(gpu: &GpuDevice, size: [u32; 2], options: Options) -> Self {
        let device = &gpu.device;
        let pipeline = |label, source: String| {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label),
                source: wgpu::ShaderSource::Wgsl(source.into()),
            });
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: None,
                module: &module,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let buffer = |bytes| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("JNLM scratch"),
                size: size[0] as u64 * size[1] as u64 * bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };
        let sources = ShaderSources::generate(size, options).expect("Shared TS JNLM generation");
        Self {
            size,
            options,
            parameters: sources.parameters,
            workgroup_size: sources.workgroup_size,
            composition: [sources.composed, sources.albedo],
            composition_hdr: [sources.composed_hdr, sources.albedo_hdr],
            hdr_output: None,
            hdr_encode: Default::default(),
            composed: image(device, size, wgpu::TextureFormat::Rgba32Float),
            albedo_texture: image(device, size, wgpu::TextureFormat::Rgba32Float),
            output: image(device, size, wgpu::TextureFormat::Rgba8Unorm),
            guides: [buffer(8), buffer(8)],
            colors: [buffer(16), buffer(16)],
            normal: buffer(16),
            albedo: buffer(16),
            shadow: buffer(16),
            guide: pipeline("JNLM guide", sources.guide),
            variance: pipeline("JNLM variance", sources.variance),
            load: pipeline("JNLM prepare", sources.prepare),
            filter: pipeline("JNLM filter", sources.filter),
            encode: pipeline("JNLM display", sources.encode),
            key: None,
        }
    }
    pub(super) fn matches(&self, size: [u32; 2], options: Options) -> bool {
        self.size == size && self.options == options
    }
    pub(super) fn compose(
        &mut self,
        display: &Display,
        settings: &Settings,
        premultiply: bool,
        effects: &mut Effects,
        target: &wgpu::Texture,
    ) -> Result<()> {
        let gpu = &display.gpu;
        let device = &gpu.device;
        let hdr = target.format() == wgpu::TextureFormat::Rgba16Float;
        if hdr && self.hdr_output.is_none() {
            self.hdr_output = Some(image(device, self.size, wgpu::TextureFormat::Rgba16Float));
        }
        let key = (display.image_revision, *settings, premultiply, hdr);
        if self.key != Some(key) {
            effects.prepare_composition(
                device,
                if hdr {
                    &self.composition_hdr
                } else {
                    &self.composition
                },
                hdr,
            );
            effects.compose_filter(display, settings, &self.composed, false, hdr);
            effects.compose_filter(display, settings, &self.albedo_texture, true, hdr);
            let params = |pass: u32| {
                let words = self.parameters[pass as usize];
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("JNLM parameters"),
                    contents: bytemuck::cast_slice(&words),
                    usage: wgpu::BufferUsages::UNIFORM,
                })
            };
            let mut encoder = device.create_command_encoder(&Default::default());

            let dispatch = |encoder: &mut wgpu::CommandEncoder,
                            pipeline: &wgpu::ComputePipeline,
                            resources: Vec<wgpu::BindingResource<'_>>| {
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("JNLM pass"),
                    layout: &pipeline.get_bind_group_layout(0),
                    entries: &resources
                        .into_iter()
                        .enumerate()
                        .map(|(i, resource)| wgpu::BindGroupEntry {
                            binding: i as u32,
                            resource,
                        })
                        .collect::<Vec<_>>(),
                });
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(
                    self.size[0].div_ceil(self.workgroup_size),
                    self.size[1].div_ceil(self.workgroup_size),
                    1,
                );
            };
            let pre = params(0);
            let shadow = display
                .shadow
                .as_ref()
                .ok_or("Missing JNLM guide moments")?;
            dispatch(
                &mut encoder,
                &self.guide,
                vec![b(&pre), b(shadow), b(&display.normal), b(&self.guides[1])],
            );
            dispatch(
                &mut encoder,
                &self.variance,
                vec![b(&pre), b(&self.guides[1]), b(&self.guides[0])],
            );
            let color_view = self.composed.create_view(&Default::default());
            let albedo_view = self.albedo_texture.create_view(&Default::default());
            dispatch(
                &mut encoder,
                &self.load,
                vec![
                    b(&pre),
                    wgpu::BindingResource::TextureView(&color_view),
                    b(&self.colors[0]),
                    b(&display.normal),
                    b(&self.normal),
                    b(shadow),
                    b(&self.shadow),
                    wgpu::BindingResource::TextureView(&albedo_view),
                    b(&self.albedo),
                ],
            );
            #[cfg(test)]
            super::effects_tests::record_order("Denoise:DisplayLinear");
            for i in 0..self.options.iterations {
                let params = params(i);
                let index = i as usize % 2;
                dispatch(
                    &mut encoder,
                    &self.filter,
                    vec![
                        b(&params),
                        b(&self.guides[index]),
                        b(&self.colors[index]),
                        b(&self.albedo),
                        b(&self.normal),
                        b(&self.colors[1 - index]),
                        b(&self.guides[1 - index]),
                        b(&self.shadow),
                    ],
                );
            }
            let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("JNLM output parameters"),
                contents: bytemuck::cast_slice(&[
                    self.size[0],
                    self.size[1],
                    u32::from(premultiply),
                    u32::from(settings.preserve_alpha),
                ]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            #[cfg(test)]
            if !hdr {
                super::effects_tests::record_order("Encode:DisplayEncoded");
            }
            let output = if hdr {
                self.hdr_output.as_ref().unwrap()
            } else {
                &self.output
            };
            let view = output.create_view(&Default::default());
            dispatch(
                &mut encoder,
                if hdr {
                    self.hdr_encode.get_or_init(|| super::hdr_transfer(device))
                } else {
                    &self.encode
                },
                vec![
                    b(&params),
                    b(&self.colors[self.options.iterations as usize % 2]),
                    wgpu::BindingResource::TextureView(&view),
                ],
            );
            gpu.queue.submit([encoder.finish()]);
            self.key = Some(key);
        }
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_texture(
            if hdr {
                self.hdr_output.as_ref().unwrap()
            } else {
                &self.output
            }
            .as_image_copy(),
            target.as_image_copy(),
            target.size(),
        );
        gpu.queue.submit([encoder.finish()]);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_filter_and_composition_shaders_validate_and_options_reject_invalid_values() {
        // Native CI emits these with the JS generator, then compares the complete
        // AOT result, including shader bodies, resource bindings and uniform bits.
        if let Some(path) = std::env::var_os("MUTRACER_JNLM_SOURCES") {
            #[derive(serde::Deserialize)]
            struct Reference {
                size: [u32; 2],
                is_default: bool,
                strength: f32,
                search_radius: u32,
                patch_radius: u32,
                albedo_bandwidth: f32,
                normal_bandwidth: f32,
                iterations: u32,
                expected: ShaderSources,
            }
            let references: Vec<Reference> =
                serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert!(!references.is_empty());
            for reference in references {
                let options = Options {
                    strength: reference.strength,
                    search_radius: reference.search_radius,
                    patch_radius: reference.patch_radius,
                    albedo_bandwidth: reference.albedo_bandwidth,
                    normal_bandwidth: reference.normal_bandwidth,
                    iterations: reference.iterations,
                };
                assert!(options.valid());
                if reference.is_default {
                    assert_eq!(
                        options,
                        Options::default(),
                        "Native and TS defaults diverged"
                    );
                }
                assert_eq!(
                    ShaderSources::generate(reference.size, options).unwrap(),
                    reference.expected
                );
            }
        }
        for options in [
            Options::default(),
            Options {
                search_radius: 16,
                patch_radius: 3,
                albedo_bandwidth: 0.0001,
                normal_bandwidth: 10.,
                iterations: 4,
                strength: 0.0001,
            },
        ] {
            let sources = ShaderSources::generate([13, 9], options).unwrap();
            assert!(sources.workgroup_size > 0);
            assert_eq!(sources.parameters.len(), options.iterations as usize);
            for (i, words) in sources.parameters.iter().enumerate() {
                assert_eq!(&words[..2], &[13, 9]);
                assert!(f32::from_bits(words[2]) > 0.);
                assert_eq!(f32::from_bits(words[3]), (1u32 << i) as f32);
            }
            for source in [
                sources.guide,
                sources.variance,
                sources.prepare,
                sources.filter,
                sources.encode,
                sources.composed,
                sources.albedo,
                sources.composed_hdr,
                sources.albedo_hdr,
            ]
            .into_iter()
            {
                let module = naga::front::wgsl::parse_str(&source).unwrap();
                naga::valid::Validator::new(
                    naga::valid::ValidationFlags::all(),
                    naga::valid::Capabilities::all(),
                )
                .validate(&module)
                .unwrap();
            }
        }
        assert!(Options::default().valid());
        assert!(
            !Options {
                strength: f32::NAN,
                ..Default::default()
            }
            .valid()
        );
        assert!(
            !Options {
                search_radius: 17,
                ..Default::default()
            }
            .valid()
        );
        assert!(
            !Options {
                patch_radius: 4,
                ..Default::default()
            }
            .valid()
        );
    }
}
