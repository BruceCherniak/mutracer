//! GPU-only stable preview. Copy before the next trace or scene publication.
use crate::{GpuDevice, Result};

/// Display-only settings. Tone modes: AgX/ACES/Cineon/Reinhard/Linear (0–4).
/// Output modes: final/normal/albedo (0–2). Exposure is a linear multiplier.
#[derive(Clone, Copy, PartialEq)]
pub struct Settings {
    pub tone_mapping: u32,
    pub exposure: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub temperature: f32,
    pub tint: f32,
    pub output: u32,
    pub preserve_alpha: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            tone_mapping: 0,
            exposure: 1.,
            contrast: 1.,
            saturation: 1.,
            temperature: 0.,
            tint: 0.,
            output: 0,
            preserve_alpha: true,
        }
    }
}
pub struct Display {
    gpu: GpuDevice,
    pub(super) owner: u64,
    pub texture: wgpu::Texture,
    pub size: [u32; 2],
    linear: wgpu::Buffer,
    raw: wgpu::Buffer,
    normal: wgpu::Buffer,
    albedo: wgpu::Buffer,
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
        let auxiliary = |label| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: linear.size(),
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let normal = auxiliary("Stable normal output");
        let albedo = auxiliary("Stable albedo output");
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
            size: 48,
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
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: normal.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: albedo.as_entire_binding(),
                },
            ],
        });
        Self {
            gpu,
            owner: 0,
            texture,
            size,
            linear,
            raw,
            normal,
            albedo,
            original_samples: 0,
            using_denoised: false,
            params,
            pipeline,
            group,
            samples: 0,
        }
    }
    pub(super) fn capture(
        &mut self,
        source: &wgpu::Buffer,
        normal: &wgpu::Buffer,
        albedo: &wgpu::Buffer,
        samples: u32,
    ) {
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(source, 0, &self.raw, 0, self.raw.size());
        encoder.copy_buffer_to_buffer(normal, 0, &self.normal, 0, self.normal.size());
        encoder.copy_buffer_to_buffer(albedo, 0, &self.albedo, 0, self.albedo.size());
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
    /// Compatibility helper for the original opaque Reinhard preview in EV.
    pub fn compose(&self, exposure: f32) {
        self.compose_with(&Settings {
            tone_mapping: 3,
            exposure: 2f32.powf(exposure),
            preserve_alpha: false,
            ..Settings::default()
        });
    }
    pub fn compose_with(&self, settings: &Settings) {
        self.compose_inner(settings, true);
    }
    fn compose_inner(&self, settings: &Settings, premultiply: bool) {
        if self.samples == 0 {
            return;
        }
        let bytes: Vec<_> = [
            self.size[0],
            self.size[1],
            (self.samples as f32).to_bits(),
            settings.exposure.to_bits(),
            settings.tone_mapping,
            settings.output,
            u32::from(settings.preserve_alpha) | (u32::from(premultiply) << 1),
            (self.original_samples.max(1) as f32).to_bits(),
            settings.contrast.to_bits(),
            settings.saturation.to_bits(),
            settings.temperature.to_bits(),
            settings.tint.to_bits(),
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
    /// Export the same composition with straight PNG alpha, then restore the
    /// premultiplied texture expected by egui. Call between presentation frames.
    pub fn read_rgba(&self, settings: &Settings) -> Result<Vec<u8>> {
        self.compose_inner(settings, false);
        let result = self.read_texture();
        self.compose_with(settings);
        result
    }
    fn read_texture(&self) -> Result<Vec<u8>> {
        let stride = (self.size[0] * 4).div_ceil(256) * 256;
        let buffer = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Display export readback"),
            size: stride as u64 * self.size[1] as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            self.texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width: self.size[0],
                height: self.size[1],
                depth_or_array_layers: 1,
            },
        );
        self.gpu.queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        buffer.map_async(wgpu::MapMode::Read, .., move |r| {
            let _ = tx.send(r);
        });
        self.gpu.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(std::time::Duration::from_secs(30)),
        })?;
        rx.recv_timeout(std::time::Duration::from_secs(5))??;
        let mapped = buffer.get_mapped_range(..)?;
        Ok(mapped
            .chunks_exact(stride as usize)
            .flat_map(|row| row[..self.size[0] as usize * 4].iter().copied())
            .collect())
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
    fn display_settings_alpha_channels_and_export_preserve_linear_data() {
        let Ok(gpu) = GpuDevice::with_backend(0) else {
            return;
        };
        // Non-aligned width and two different rows exercise readback padding/orientation.
        let mut display = Display::new(gpu.clone(), [3, 2]);
        let pixels: Vec<f32> = vec![
            0.4, 0.2, 0.1, 1., 0.4, 0.2, 0.1, 0.5, 0., 0., 0., 0., 2., 0.3, 0.1, 1., 0.1, 0.4, 0.8,
            1., 0.9, 0.2, 0.7, 1.,
        ];
        display.upload(&pixels).unwrap();
        let auxiliary: Vec<f32> = pixels
            .chunks_exact(4)
            .flat_map(|p| [0.2, 0.3, 0.4, p[3]])
            .collect();
        gpu.queue.write_buffer(
            &display.albedo,
            0,
            &auxiliary
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        );
        let normals: Vec<f32> = pixels
            .chunks_exact(4)
            .flat_map(|p| [0., 0., p[3], 1.])
            .collect();
        gpu.queue.write_buffer(
            &display.normal,
            0,
            &normals
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        );
        let mut settings = Settings {
            tone_mapping: 3,
            ..Settings::default()
        };
        let baseline = display.read_rgba(&settings).unwrap();
        assert_eq!(&baseline[20..24], &[0, 0, 0, 0]);
        assert_eq!(baseline[19], 128);
        let srgb = |v: f32| {
            if v <= 0.0031308 {
                12.92 * v
            } else {
                1.055 * v.powf(1. / 2.4) - 0.055
            }
        };
        for (offset, linear) in [(12, [0.4, 0.2, 0.1]), (16, [0.8, 0.4, 0.2])] {
            for c in 0..3 {
                let v = linear[c];
                let expected = (srgb(v / (1. + v)) * 255. + 0.5) as i32;
                assert!((baseline[offset + c] as i32 - expected).abs() <= 1);
            }
        }
        let premultiplied = display.read_texture().unwrap();
        for c in 0..3 {
            assert!((premultiplied[16 + c] as f32 - baseline[16 + c] as f32 * 0.5).abs() <= 1.);
        }
        let mut modes = Vec::new();
        for mode in 0..5 {
            settings.tone_mapping = mode;
            let rgba = display.read_rgba(&settings).unwrap();
            assert!(!modes.contains(&rgba), "Tone mode {mode} had no effect");
            modes.push(rgba);
        }
        for case in 0..5 {
            settings = Settings {
                tone_mapping: 3,
                ..Settings::default()
            };
            match case {
                0 => settings.exposure = 0.5,
                1 => settings.contrast = 1.4,
                2 => settings.saturation = 0.,
                3 => settings.temperature = -0.7,
                _ => settings.tint = 0.8,
            }
            assert_ne!(display.read_rgba(&settings).unwrap(), baseline);
        }
        settings = Settings {
            tone_mapping: 3,
            ..Settings::default()
        };
        assert_eq!(display.read_rgba(&settings).unwrap(), baseline);
        assert_eq!(display.read_linear().unwrap(), pixels);
        settings.output = 1;
        let normal = display.read_rgba(&settings).unwrap();
        assert_eq!(&normal[12..16], &[128, 128, 255, 255]);
        settings.exposure = 0.;
        settings.saturation = 0.;
        assert_eq!(display.read_rgba(&settings).unwrap(), normal);
        settings.output = 2;
        let albedo = display.read_rgba(&settings).unwrap();
        assert_ne!(albedo, normal);
        assert!((albedo[12] as f32 - srgb(0.2) * 255.).abs() <= 1.);
        assert_eq!(albedo[19], 128);
        assert_eq!(display.read_linear().unwrap(), pixels);
    }

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
