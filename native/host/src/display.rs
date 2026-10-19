//! GPU-only stable preview. Copy before the next trace or scene publication.
use crate::{GpuDevice, Result};
pub struct Display {
    gpu: GpuDevice,
    pub texture: wgpu::Texture,
    pub size: [u32; 2],
    linear: wgpu::Buffer,
    raw: wgpu::Buffer,
    original_samples: u32,
    pub using_denoised: bool,
    params: wgpu::Buffer,
    pipeline: wgpu::ComputePipeline,
    group: wgpu::BindGroup,
    samples: u32,
}
impl Display {
    pub(super) fn new(gpu: GpuDevice, size: [u32; 2]) -> Self {
        let device = &gpu.device;
        let linear = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Stable preview accumulation"),
            size: size[0] as u64 * size[1] as u64 * 16,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let raw = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Unfiltered preview"),
            size: linear.size(),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Native display"),
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
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared Web display functions"),
            source: wgpu::ShaderSource::Wgsl(include_str!("display.wgsl").into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: None,
            layout: None,
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let params = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let view = texture.create_view(&Default::default());
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: linear.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: params.as_entire_binding(),
                },
            ],
        });
        Self {
            gpu,
            texture,
            size,
            linear,
            raw,
            original_samples: 0,
            using_denoised: false,
            params,
            pipeline,
            group,
            samples: 0,
        }
    }
    pub(super) fn capture(&mut self, source: &wgpu::Buffer, samples: u32) {
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(source, 0, &self.raw, 0, self.raw.size());
        encoder.copy_buffer_to_buffer(&self.raw, 0, &self.linear, 0, self.linear.size());
        self.gpu.queue.submit([encoder.finish()]);
        self.samples = samples;
        self.original_samples = samples;
        self.using_denoised = false;
    }
    /// Replace the preview with a caller-owned linear denoised result.
    pub fn upload(&mut self, pixels: &[f32]) -> Result<()> {
        if pixels.len() != self.size[0] as usize * self.size[1] as usize * 4
            || pixels.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid display image".into());
        }
        let bytes: Vec<_> = pixels.iter().flat_map(|v| v.to_le_bytes()).collect();
        self.gpu.queue.write_buffer(&self.linear, 0, &bytes);
        self.samples = 1;
        self.using_denoised = true;
        Ok(())
    }
    pub fn original(&mut self) {
        if !self.using_denoised {
            return;
        }
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(&self.raw, 0, &self.linear, 0, self.linear.size());
        self.gpu.queue.submit([encoder.finish()]);
        self.samples = self.original_samples;
        self.using_denoised = false;
    }
    pub fn compose(&self, exposure: f32) {
        if self.samples == 0 {
            return;
        }
        let bytes: Vec<_> = [
            self.size[0],
            self.size[1],
            (self.samples as f32).to_bits(),
            exposure.to_bits(),
        ]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect();
        self.gpu.queue.write_buffer(&self.params, 0, &bytes);
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.group, &[]);
            pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
        }
        self.gpu.queue.submit([encoder.finish()]);
    }
    /// Explicit export/diagnostic readback; presentation never calls this.
    pub fn read_linear(&self) -> Result<Vec<f32>> {
        Ok(crate::read_average(
            &self.gpu.device,
            &self.gpu.queue,
            &self.linear,
            self.size[0],
            self.size[1],
            self.samples,
        )?
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gpu_preview_matches_reinhard_srgb_and_bottom_up_hdr() {
        let Ok(gpu) = GpuDevice::with_backend(0) else {
            return;
        };
        let size = [64, 2];
        let mut display = Display::new(gpu.clone(), size);
        let pixels: Vec<f32> = (0..128)
            .flat_map(|i| {
                [
                    i as f32 * 0.025 - 0.1,
                    (i % 9) as f32 * 0.1,
                    if i % 3 == 0 { 10000. } else { 0.002 },
                    0.3,
                ]
            })
            .collect();
        display.upload(&pixels).unwrap();
        display.compose(0.5);
        let read = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 512,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            display.texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &read,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width: 64,
                height: 2,
                depth_or_array_layers: 1,
            },
        );
        gpu.queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        read.map_async(wgpu::MapMode::Read, .., move |r| tx.send(r).unwrap());
        gpu.device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(std::time::Duration::from_secs(30)),
            })
            .unwrap();
        rx.recv().unwrap().unwrap();
        let rgba = read.get_mapped_range(..).unwrap();
        for y in 0..2 {
            for x in 0..64 {
                for c in 0..3 {
                    let v = (pixels[((1 - y) * 64 + x) * 4 + c] * 2f32.sqrt()).max(0.);
                    let v = v / (1. + v);
                    let s = if v <= 0.0031308 {
                        12.92 * v
                    } else {
                        1.055 * v.powf(1. / 2.4) - 0.055
                    };
                    let expected = (s.clamp(0., 1.) * 255. + 0.5) as i32;
                    assert!(
                        (rgba[(y * 64 + x) * 4 + c] as i32 - expected).abs() <= 1,
                        "x={x}, y={y}, c={c}"
                    );
                }
                assert_eq!(rgba[(y * 64 + x) * 4 + 3], 255);
            }
        }
        assert_eq!(display.read_linear().unwrap(), pixels);
    }
}
