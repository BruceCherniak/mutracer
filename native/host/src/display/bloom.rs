use super::{Settings, image};
use crate::GpuDevice;
pub(super) struct Bloom {
    layout: wgpu::BindGroupLayout,
    pipelines: [wgpu::ComputePipeline; 4],
    bright: wgpu::Texture,
    down: [wgpu::Texture; 6],
    h: [wgpu::Texture; 6],
    v: [wgpu::Texture; 6],
    blend: [wgpu::Texture; 5],
}
impl Bloom {
    pub fn new(device: &wgpu::Device, size: [u32; 2]) -> Self {
        let texture = |s| image(device, s, wgpu::TextureFormat::Rgba16Float);
        let scaled = |i: usize| size.map(|n| (n >> i).max(1));
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("MuTracer bloom"),
            source: wgpu::ShaderSource::Wgsl(include_str!("bloom.wgsl").into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba16Float,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipelines = ["bright", "down", "blur", "blend"].map(|entry| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                module: &shader,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        });
        Self {
            layout,
            pipelines,
            bright: texture(size),
            down: std::array::from_fn(|i| texture(scaled(i + 1))),
            h: std::array::from_fn(|i| texture(scaled(i + 1))),
            v: std::array::from_fn(|i| texture(scaled(i))),
            blend: std::array::from_fn(|i| texture(scaled(i))),
        }
    }
    pub fn output(&self) -> &wgpu::Texture {
        &self.blend[0]
    }
    pub fn run(
        &self,
        gpu: &GpuDevice,
        encoder: &mut wgpu::CommandEncoder,
        input: &wgpu::Texture,
        settings: &Settings,
    ) {
        let size = (settings.bloom_radius * 2.).clamp(0.2, 1.);
        let weight = 1. - (settings.bloom_radius.powf(0.3) * 0.8).clamp(0., 0.8);
        let step = |encoder: &mut wgpu::CommandEncoder,
                    kind: usize,
                    a: &wgpu::Texture,
                    b: &wgpu::Texture,
                    out: &wgpu::Texture,
                    dir: [f32; 2]| {
            let params = super::effects::uniform(
                &gpu.device,
                &[
                    settings.bloom_threshold,
                    size,
                    weight,
                    0.,
                    dir[0],
                    dir[1],
                    0.,
                    0.,
                ]
                .map(f32::to_bits),
            );
            let av = a.create_view(&Default::default());
            let bv = b.create_view(&Default::default());
            let ov = out.create_view(&Default::default());
            let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&av),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&bv),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(&ov),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: params.as_entire_binding(),
                    },
                ],
            });
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipelines[kind]);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(out.width().div_ceil(8), out.height().div_ceil(8), 1);
        };
        step(encoder, 0, input, input, &self.bright, [0.; 2]);
        for i in 0..6 {
            let source = if i == 0 {
                &self.bright
            } else {
                &self.down[i - 1]
            };
            step(encoder, 1, source, source, &self.down[i], [0.; 2]);
        }
        for i in (0..6).rev() {
            step(
                encoder,
                2,
                &self.down[i],
                &self.down[i],
                &self.h[i],
                [1., 0.],
            );
            step(encoder, 2, &self.h[i], &self.h[i], &self.v[i], [0., 1.]);
        }
        for i in (0..5).rev() {
            let source = if i == 4 {
                &self.v[5]
            } else {
                &self.blend[i + 1]
            };
            step(encoder, 3, source, &self.v[i], &self.blend[i], [0.; 2]);
        }
    }
}
