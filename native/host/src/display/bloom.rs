use super::{Settings, image};
use crate::GpuDevice;
pub(super) struct Bloom {
    layout: wgpu::BindGroupLayout,
    pipelines: [wgpu::ComputePipeline; 4],
    bright: wgpu::Texture,
    down: Vec<wgpu::Texture>,
    h: Vec<wgpu::Texture>,
    v: Vec<wgpu::Texture>,
    blend: Vec<wgpu::Texture>,
    parameters: Option<(u32, [f32; 2])>,
}
impl Bloom {
    pub fn new(device: &wgpu::Device, size: [u32; 2]) -> Self {
        let levels = crate::postprocess::sources()
            .expect("Shared Bloom plan")
            .bloom_levels;
        let texture = |s| image(device, s, wgpu::TextureFormat::Rgba16Float);
        let scaled = |i: usize| size.map(|n| (n >> i).max(1));
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("MuTracer bloom"),
            source: wgpu::ShaderSource::Wgsl(
                crate::postprocess::sources()
                    .expect("Shared Bloom shader generator")
                    .bloom
                    .as_str()
                    .into(),
            ),
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
            parameters: None,
            down: (0..levels).map(|i| texture(scaled(i + 1))).collect(),
            h: (0..levels).map(|i| texture(scaled(i + 1))).collect(),
            v: (0..levels).map(|i| texture(scaled(i))).collect(),
            blend: (0..levels - 1).map(|i| texture(scaled(i))).collect(),
        }
    }
    pub fn output(&self) -> &wgpu::Texture {
        &self.blend[0]
    }
    pub fn run(
        &mut self,
        gpu: &GpuDevice,
        encoder: &mut wgpu::CommandEncoder,
        input: &wgpu::Texture,
        settings: &Settings,
    ) {
        let radius = settings.bloom_radius.to_bits();
        if self.parameters.is_none_or(|(last, _)| last != radius) {
            self.parameters = Some((
                radius,
                crate::postprocess::bloom_parameters(settings.bloom_radius)
                    .expect("Shared Bloom radius"),
            ));
        }
        let [size, weight] = self.parameters.unwrap().1;
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
        let textures: Vec<&wgpu::Texture> = std::iter::once(&self.bright)
            .chain(self.down.iter())
            .chain(self.h.iter())
            .chain(self.v.iter())
            .chain(self.blend.iter())
            .chain(std::iter::once(input))
            .collect();
        for &(kind, a, b, out, dx, dy) in &crate::postprocess::sources()
            .expect("Shared Bloom plan")
            .bloom_plan
        {
            step(
                encoder,
                kind,
                textures[a],
                textures[b],
                textures[out],
                [dx, dy],
            );
        }
    }
}
