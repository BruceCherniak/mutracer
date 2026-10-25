//! oidn-webgpu consumer, using only the published Rust API documented at
//! https://github.com/pissang/oidn-webgpu/blob/main/native/README.md
use crate::{GpuDevice, Result};
use oidn_webgpu::{
    DenoiseBuffers, DenoiseParams, Denoiser as Network, DenoiserOptions, Model, PreparedDenoise,
};
use std::path::Path;
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
use wgpu::util::DeviceExt;

pub(crate) const BACKEND: u32 = 5;
pub(crate) fn required_features() -> wgpu::Features {
    Network::required_features()
}
pub(crate) fn recommended_features(adapter: &wgpu::Adapter) -> wgpu::Features {
    Network::recommended_features(adapter)
}

#[cfg(test)]
static NEXT_PREPARATION: AtomicU64 = AtomicU64::new(1);

// The prepared network owns its workspace and keeps these image handles alive.
// The output is reused, so submit() copies both returned images for retention.
pub(crate) struct Denoiser {
    size: [u32; 2],
    prepared: PreparedDenoise,
    color: wgpu::Buffer,
    albedo: wgpu::Buffer,
    normal: wgpu::Buffer,
    output: wgpu::Buffer,
    normalize: wgpu::ComputePipeline,
    restore: wgpu::ComputePipeline,
    #[cfg(test)]
    identity: u64,
}
impl Denoiser {
    pub(crate) fn new(
        gpu: &GpuDevice,
        size: [u32; 2],
        weights: Option<&Path>,
        max_tile_size: u32,
    ) -> Result<Self> {
        if !size.into_iter().all(|edge| (1..=16384).contains(&edge)) {
            return Err("Invalid OIDN image dimensions".into());
        }
        let weights = match weights {
            Some(path) => std::fs::read(path)?,
            None => include_bytes!("../../../oidn/weights/rt_hdr_alb_nrm.tza").to_vec(),
        };
        let model = Model::from_tza(&weights)?;
        if model.input_count() != 3 {
            return Err("OIDN requires color/albedo/normal weights".into());
        }
        let mut options = DenoiserOptions::default();
        options.max_tile_size = max_tile_size;
        // Keep upstream's checked shaders. No planner FFI, shader extraction,
        // unchecked execution or private network options are needed here.
        let mut network = Network::new(&gpu.device, &gpu.adapter, &model, options)?;
        let size_bytes = u64::from(size[0]) * u64::from(size[1]) * 16;
        let image = |label| {
            gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: size_bytes,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let color = image("OIDN linear HDR input");
        let albedo = image("OIDN linear albedo input");
        let normal = image("OIDN signed normal input");
        let output = image("OIDN filtered HDR output");
        let prepared = network.prepare(
            size,
            DenoiseBuffers {
                color: (&color).into(),
                albedo: Some((&albedo).into()),
                normal: Some((&normal).into()),
                output: (&output).into(),
            },
        )?;
        let source = include_str!("oidn-normalize.wgsl");
        let shader = gpu
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("MuTracer OIDN image normalization"),
                source: wgpu::ShaderSource::Wgsl(source.into()),
            });
        let pipeline = |entry| {
            gpu.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(entry),
                    layout: None,
                    module: &shader,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    cache: None,
                })
        };
        Ok(Self {
            size,
            prepared,
            color,
            albedo,
            normal,
            output,
            normalize: pipeline("normalize"),
            restore: pipeline("restore"),
            #[cfg(test)]
            identity: NEXT_PREPARATION.fetch_add(1, Ordering::Relaxed),
        })
    }
    pub(crate) fn size(&self) -> [u32; 2] {
        self.size
    }
    #[cfg(test)]
    pub(crate) fn program_identity(&self) -> u64 {
        self.identity
    }

    pub(crate) fn submit(
        &mut self,
        gpu: &GpuDevice,
        sources: [&wgpu::Buffer; 3],
        samples: u32,
        flat: bool,
    ) -> Result<(wgpu::Buffer, wgpu::Buffer)> {
        if samples == 0 {
            return Err("OIDN needs complete samples".into());
        }
        gpu.loss.check()?;
        let params = [self.size[0], self.size[1], samples, u32::from(flat)];
        let params = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("OIDN image resolve parameters"),
                contents: &params
                    .into_iter()
                    .flat_map(u32::to_le_bytes)
                    .collect::<Vec<_>>(),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        fn entry(binding: u32, buffer: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
            wgpu::BindGroupEntry {
                binding,
                resource: buffer.as_entire_binding(),
            }
        }
        let normalize = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("OIDN accumulation resolve"),
            layout: &self.normalize.get_bind_group_layout(0),
            entries: &[
                entry(0, sources[0]),
                entry(1, sources[1]),
                entry(2, sources[2]),
                entry(3, &self.color),
                entry(4, &self.albedo),
                entry(5, &self.normal),
                entry(6, &params),
            ],
        });
        let retained = |label| {
            gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: self.output.size(),
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let pixels = retained("Retained OIDN HDR pixels");
        let preview = retained("OIDN display color");
        let restore = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("OIDN display normalization"),
            layout: &self.restore.get_bind_group_layout(0),
            entries: &[
                entry(1, sources[1]),
                entry(2, sources[2]),
                entry(3, &self.output),
                entry(4, &preview),
                entry(5, &params),
            ],
        });
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("MuTracer OIDN denoising"),
            });
        let dispatch = |encoder: &mut wgpu::CommandEncoder,
                        pipeline: &wgpu::ComputePipeline,
                        group: &wgpu::BindGroup| {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
        };
        dispatch(&mut encoder, &self.normalize, &normalize);
        self.prepared
            .encode(&mut encoder, DenoiseParams { input_scale: 1.0 })?;
        dispatch(&mut encoder, &self.restore, &restore);
        encoder.copy_buffer_to_buffer(&self.output, 0, &pixels, 0, pixels.size());
        gpu.queue.submit([encoder.finish()]);
        Ok((pixels, preview))
    }
}

/// GPU-buffer consumer for the existing A/B harness. Image transfers are outside
/// resident timings; readback is needed only for the returned validation image.
#[cfg(feature = "validation")]
pub fn benchmark(
    size: [u32; 2],
    images: &[Vec<f32>],
    iterations: usize,
    max_tile_size: u32,
) -> Result<(Vec<f32>, serde_json::Value)> {
    use std::time::Instant;
    if images.len() != 3
        || !images
            .iter()
            .all(|image| image.len() == size[0] as usize * size[1] as usize * 4)
    {
        return Err("Invalid OIDN benchmark images".into());
    }
    let gpu = GpuDevice::with_backend(0)?;
    let upload = |values: &[f32]| {
        gpu.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("OIDN benchmark input"),
                contents: &values
                    .iter()
                    .flat_map(|v| v.to_le_bytes())
                    .collect::<Vec<_>>(),
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            })
    };
    // Benchmark inputs are already resolved, signed-normal AOVs. Encode them
    // directly, without the renderer's hit-count normalization a second time.
    let color = upload(&images[0]);
    let normal = upload(&images[1]);
    let albedo = upload(&images[2]);
    let output = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("OIDN benchmark output"),
        size: color.size(),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let started = Instant::now();
    let model = Model::from_tza(include_bytes!("../../../oidn/weights/rt_hdr_alb_nrm.tza"))?;
    let mut options = DenoiserOptions::default();
    options.max_tile_size = max_tile_size;
    let mut network = Network::new(&gpu.device, &gpu.adapter, &model, options)?;
    let mut prepared = network.prepare(
        size,
        DenoiseBuffers {
            color: (&color).into(),
            albedo: Some((&albedo).into()),
            normal: Some((&normal).into()),
            output: (&output).into(),
        },
    )?;
    let info = format!("{:?}", prepared.info());
    let create_ms = started.elapsed().as_secs_f64() * 1000.;
    let mut warm_ms = Vec::new();
    let mut first_ms = 0.;
    for iteration in 0..iterations + 3 {
        let started = Instant::now();
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        prepared.encode(&mut encoder, DenoiseParams { input_scale: 1. })?;
        gpu.queue.submit([encoder.finish()]);
        gpu.device.poll(wgpu::PollType::wait_indefinitely())?;
        let ms = started.elapsed().as_secs_f64() * 1000.;
        if iteration == 0 {
            first_ms = ms;
        }
        if iteration >= 3 {
            warm_ms.push(ms);
        }
    }
    let bytes = crate::read_average(&gpu.device, &gpu.queue, &output, size[0], size[1], 1)?;
    let pixels = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|v| f32::from_le_bytes(*v))
        .collect::<Vec<_>>();
    if !pixels.iter().all(|v| v.is_finite()) {
        return Err("OIDN returned non-finite output".into());
    }
    let report = serde_json::json!({"backend":"oidn-webgpu","adapter":gpu.info.name,"size":size,"createMs":create_ms,"firstMs":first_ms,"warmMs":warm_ms,"inputScale":1,"network":info,"timing":"GPU encode, execution and synchronization; excludes uploads, preparation and result readback"});
    Ok((pixels, report))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_shader_is_valid_wgsl() {
        let module = naga::front::wgsl::parse_str(include_str!("oidn-normalize.wgsl")).unwrap();
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap();
    }
    #[test]
    #[ignore = "requires native OIDN on a real GPU"]
    fn accumulated_inputs_match_the_documented_rust_api_and_retained_outputs() {
        let _test = crate::ABI_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let gpu = GpuDevice::with_backend(0).unwrap();
        let size = [17, 13];
        let samples = 4;
        let pixels = size[0] as usize * size[1] as usize;
        let mut color = Vec::new();
        let mut albedo = Vec::new();
        let mut normal = Vec::new();
        for i in 0..pixels {
            let coverage = if i % 5 == 0 {
                0.
            } else if i % 3 == 0 {
                0.5
            } else {
                1.
            };
            color.extend(
                [
                    0.2 + (i % 11) as f32 * 0.01,
                    0.3,
                    0.4,
                    0.25 + (i % 3) as f32 * 0.25,
                ]
                .map(|v| v * samples as f32),
            );
            albedo.extend([0.3, 0.4, 0.5, coverage].map(|v| v * samples as f32));
            normal.extend([-0.4, 0.5, -0.1, 1.].map(|v| v * samples as f32));
        }
        let upload = |values: &[f32]| {
            gpu.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Accumulated OIDN test input"),
                    contents: &values
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect::<Vec<_>>(),
                    usage: wgpu::BufferUsages::STORAGE
                        | wgpu::BufferUsages::COPY_SRC
                        | wgpu::BufferUsages::COPY_DST,
                })
        };
        let source_color = upload(&color);
        let source_albedo = upload(&albedo);
        let source_normal = upload(&normal);
        let small = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../oidn/weights/rt_hdr_alb_nrm_small.tza");
        for weights_path in [None, Some(small.as_path())] {
            let mut integrated = Denoiser::new(&gpu, size, weights_path, 16).unwrap();
            for flat in [false, true] {
                let (result, _) = integrated
                    .submit(
                        &gpu,
                        [&source_color, &source_albedo, &source_normal],
                        samples,
                        flat,
                    )
                    .unwrap();
                let resolved = crate::hdr::read(
                    &gpu,
                    [&source_color, &source_normal, &source_albedo],
                    size,
                    samples,
                    flat,
                )
                .unwrap();
                let direct_color = upload(&resolved);
                let direct_albedo = upload(
                    &albedo
                        .iter()
                        .map(|v| v / samples as f32)
                        .collect::<Vec<_>>(),
                );
                let direct_normal = upload(
                    &normal
                        .iter()
                        .map(|v| v / samples as f32)
                        .collect::<Vec<_>>(),
                );
                let output = upload(&vec![0.; pixels * 4]);
                let weights = weights_path
                    .map(std::fs::read)
                    .transpose()
                    .unwrap()
                    .unwrap_or_else(|| {
                        include_bytes!("../../../oidn/weights/rt_hdr_alb_nrm.tza").to_vec()
                    });
                let model = Model::from_tza(&weights).unwrap();
                let mut options = DenoiserOptions::default();
                options.max_tile_size = 16;
                let mut direct = Network::new(&gpu.device, &gpu.adapter, &model, options).unwrap();
                let mut prepared = direct
                    .prepare(
                        size,
                        DenoiseBuffers {
                            color: (&direct_color).into(),
                            albedo: Some((&direct_albedo).into()),
                            normal: Some((&direct_normal).into()),
                            output: (&output).into(),
                        },
                    )
                    .unwrap();
                let mut encoder = gpu.device.create_command_encoder(&Default::default());
                prepared
                    .encode(&mut encoder, DenoiseParams { input_scale: 1. })
                    .unwrap();
                gpu.queue.submit([encoder.finish()]);
                let read = |buffer: &wgpu::Buffer| {
                    crate::read_average(&gpu.device, &gpu.queue, buffer, size[0], size[1], 1)
                        .unwrap()
                };
                let actual = read(&result);
                let expected = read(&output);
                let actual_f32: Vec<_> = actual
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|v| f32::from_le_bytes(*v))
                    .collect();
                let expected_f32: Vec<_> = expected
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|v| f32::from_le_bytes(*v))
                    .collect();
                let max_error = actual_f32
                    .iter()
                    .zip(&expected_f32)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0., f32::max);
                assert!(max_error < 1e-5, "normalization mismatch: {max_error}");
                for (actual, original) in actual_f32
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .zip(resolved.as_chunks::<4>().0)
                {
                    assert!(actual[..3].iter().all(|v| v.is_finite() && *v >= 0.));
                    assert_eq!(actual[3], original[3]);
                }
                // A later frame must not overwrite the result retained for display.
                let zeros = vec![0u8; color.len() * 4];
                gpu.queue.write_buffer(&source_color, 0, &zeros);
                integrated
                    .submit(
                        &gpu,
                        [&source_color, &source_albedo, &source_normal],
                        samples,
                        flat,
                    )
                    .unwrap();
                assert_eq!(read(&result), actual);
                gpu.queue.write_buffer(
                    &source_color,
                    0,
                    &color
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect::<Vec<_>>(),
                );
            }
        }
    }
}
