//! Independent primary-surface passes; all allocations belong to one render.
use crate::*;
use wgpu::util::DeviceExt;

pub(crate) struct Query {
    gpu: GpuDevice,
    shader: wgpu::ShaderModule,
    layouts: Vec<wgpu::BindGroupLayout>,
    groups: Vec<wgpu::BindGroup>,
    retained: scene::PreparedState,
    size: [u32; 2],
}
impl Query {
    pub(crate) fn snapshot(scene: &GpuScene, target: Option<&Target>) -> Result<Self> {
        let frame = target.map_or_else(|| scene.groups[2].clone(), |t| t.groups[0].clone());
        Ok(Self {
            gpu: scene.gpu.clone(),
            shader: scene.depth_shader.clone(),
            layouts: scene.layouts[..3].to_vec(),
            groups: vec![scene.groups[0].clone(), scene.groups[1].clone(), frame],
            retained: scene
                .retained
                .clone()
                .ok_or("AOV requires a retained scene")?,
            size: target.map_or([scene.scene.width, scene.scene.height], |t| {
                [t.width, t.height]
            }),
        })
    }
    pub(crate) fn metadata(&self, camera: &[u8]) -> Result<Vec<u32>> {
        self.retained.aov_metadata(camera, self.size)
    }
}

pub(crate) struct Output {
    pub generation: u64,
    pub samples: u32,
    size: [u32; 2],
    gpu: GpuDevice,
    accumulated: wgpu::Buffer,
    center: wgpu::Buffer,
    previous_center: wgpu::Buffer,
    current_words: Vec<u32>,
    scene: wgpu::Buffer,
    layout: wgpu::BindGroupLayout,
    trace: wgpu::ComputePipeline,
    center_trace: wgpu::ComputePipeline,
}
impl Output {
    pub(crate) fn new(
        query: &Query,
        generation: u64,
        words: &[u32],
        previous: Option<&Self>,
    ) -> Result<Self> {
        let device = &query.gpu.device;
        query.gpu.loss.check()?;
        let pixels = u64::from(query.size[0]) * u64::from(query.size[1]);
        if pixels * 64 > u64::from(device.limits().max_storage_buffer_binding_size) {
            return Err(fail(
                Status::InvalidArgument,
                "AOV accumulation exceeds the storage binding size limit",
            ));
        }
        let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("AOV output"),
            entries: &[
                (5, wgpu::BufferBindingType::Storage { read_only: false }),
                (6, wgpu::BufferBindingType::Storage { read_only: false }),
                (7, wgpu::BufferBindingType::Storage { read_only: true }),
                (8, wgpu::BufferBindingType::Uniform),
                (9, wgpu::BufferBindingType::Storage { read_only: true }),
            ]
            .map(|(binding, ty)| wgpu::BindGroupLayoutEntry {
                binding,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("AOV layout"),
            bind_group_layouts: &[
                Some(&query.layouts[0]),
                Some(&query.layouts[1]),
                Some(&query.layouts[2]),
                Some(&layout),
            ],
            ..Default::default()
        });
        let pipeline = |entry| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                module: &query.shader,
                entry_point: Some(entry),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[("DEPTH_QUERY_MODE", 1.)],
                    ..Default::default()
                },
                cache: query.gpu.pipeline_cache.as_ref(),
            })
        };
        let trace = pipeline("aovTrace");
        let center_trace = pipeline("aovTraceCenter");
        if let Some(error) = pollster::block_on(validation.pop()) {
            return Err(error.to_string().into());
        }
        let buffer = |label, size| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let current_words = words.to_vec();
        let mut words = words.to_vec();
        words[..16].fill(0);
        if let Some(previous) =
            previous.filter(|p| p.size == query.size && p.current_words[18] == words[18])
        {
            words[..16].copy_from_slice(&previous.current_words[20..36]);
            let old = &previous.current_words;
            let mut records = HashMap::new();
            for offset in (36..old[16] as usize).step_by(24) {
                records.insert((old[offset], old[offset + 1]), offset);
            }
            for offset in (36..words[16] as usize).step_by(24) {
                if let Some(&prior) = records.get(&(words[offset], words[offset + 1])) {
                    if words[offset + 20..offset + 23] == old[prior + 20..prior + 23] {
                        let matrix = glam::Mat4::from_cols_array(&std::array::from_fn(|i| {
                            f32::from_bits(words[offset + 4 + i])
                        }));
                        let before = glam::Mat4::from_cols_array(&std::array::from_fn(|i| {
                            f32::from_bits(old[prior + 4 + i])
                        }));
                        if matrix.determinant().abs() > 1e-20 {
                            let transform = (before * matrix.inverse()).to_cols_array();
                            for (i, value) in transform.iter().enumerate() {
                                words[offset + 4 + i] = value.to_bits();
                            }
                            words[offset + 2] = 1;
                        }
                    }
                }
            }
        }
        let previous_center = buffer("Previous AOV center", pixels * 32);
        if let Some(previous) = previous.filter(|p| p.size == query.size) {
            let mut encoder = device.create_command_encoder(&Default::default());
            encoder.copy_buffer_to_buffer(&previous.center, 0, &previous_center, 0, pixels * 32);
            query.gpu.queue.submit([encoder.finish()]);
        }
        let bytes: Vec<_> = words.iter().flat_map(|v| v.to_le_bytes()).collect();
        let scene = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("AOV identities/history"),
            contents: &bytes,
            usage: wgpu::BufferUsages::STORAGE,
        });
        Ok(Self {
            generation,
            previous_center,
            current_words,
            samples: 0,
            size: query.size,
            gpu: query.gpu.clone(),
            accumulated: buffer("AOV accumulation", pixels * 64),
            center: buffer("AOV center", pixels * 32),
            scene,
            layout,
            trace,
            center_trace,
        })
    }
    pub(crate) fn render(&mut self, query: &Query, samples: u32) -> Result<()> {
        self.gpu.loss.check()?;
        let device = &self.gpu.device;
        let run = |pipeline: &wgpu::ComputePipeline, sample: u32| {
            let parameters: Vec<_> = [self.size[0], self.size[1], sample, 0]
                .into_iter()
                .flat_map(u32::to_le_bytes)
                .collect();
            let parameters = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("AOV parameters"),
                contents: &parameters,
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let outputs = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.layout,
                entries: &[
                    (5, &self.accumulated),
                    (6, &self.center),
                    (7, &self.scene),
                    (8, &parameters),
                    (9, &self.previous_center),
                ]
                .map(|(binding, buffer)| wgpu::BindGroupEntry {
                    binding,
                    resource: buffer.as_entire_binding(),
                }),
            });
            let mut encoder = device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(pipeline);
                for (i, group) in query.groups.iter().enumerate() {
                    pass.set_bind_group(i as u32, group, &[]);
                }
                pass.set_bind_group(3, &outputs, &[]);
                pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
            }
            self.gpu.queue.submit([encoder.finish()]);
        };
        if self.samples == 0 {
            run(&self.center_trace, 0);
        }
        while self.samples < samples {
            run(&self.trace, self.samples);
            self.samples += 1;
        }
        Ok(())
    }
    pub(crate) fn read(&self, kind: u32) -> Result<api::Image> {
        let center = kind >= 9;
        let source = if center {
            &self.center
        } else {
            &self.accumulated
        };
        let bytes = read_bytes(&self.gpu, source)?;
        let words: Vec<_> = bytes
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        let values: Vec<_> = words.iter().map(|v| f32::from_bits(*v)).collect();
        let [width, height] = self.size;
        let pixels = (width * height) as usize;
        let mut image = api::Image {
            width,
            height,
            data: vec![],
            id_data: None,
        };
        if kind == 9 {
            let mut ids = vec![0; pixels * 4];
            for y in 0..height as usize {
                for x in 0..width as usize {
                    let p = y * width as usize + x;
                    let o = ((height as usize - 1 - y) * width as usize + x) * 8;
                    ids[p * 4..p * 4 + 4].copy_from_slice(&words[o..o + 4]);
                }
            }
            image.id_data = Some(ids);
            return Ok(image);
        }
        image.data.resize(pixels * 4, 0.);
        for y in 0..height as usize {
            for x in 0..width as usize {
                let p = y * width as usize + x;
                let o =
                    ((height as usize - 1 - y) * width as usize + x) * if center { 8 } else { 16 };
                let result = if kind == 10 {
                    [values[o + 4], values[o + 5], 0., values[o + 7]]
                } else {
                    let hits = values[o + 7];
                    let inv = if hits > 0. { 1. / hits } else { 0. };
                    let coverage = hits / self.samples.max(1) as f32;
                    match kind {
                        4 => [values[o] * inv, 0., 0., coverage],
                        5 => [
                            values[o + 4] * inv,
                            values[o + 5] * inv,
                            values[o + 6] * inv,
                            coverage,
                        ],
                        6 => [
                            values[o + 1] * inv,
                            values[o + 2] * inv,
                            values[o + 3] * inv,
                            coverage,
                        ],
                        7 | 8 => {
                            let a = o + if kind == 7 { 8 } else { 12 };
                            let count = values[a + 3];
                            let s = if count > 0. { 1. / count } else { 0. };
                            [
                                values[a] * s,
                                values[a + 1] * s,
                                values[a + 2] * s,
                                count / self.samples.max(1) as f32,
                            ]
                        }
                        _ => return Err("Unknown AOV kind".into()),
                    }
                };
                image.data[p * 4..p * 4 + 4].copy_from_slice(&result);
            }
        }
        Ok(image)
    }
}
fn read_bytes(gpu: &GpuDevice, source: &wgpu::Buffer) -> Result<Vec<u8>> {
    let device = &gpu.device;
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("AOV readback"),
        size: source.size(),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(source, 0, &staging, 0, source.size());
    gpu.queue.submit([encoder.finish()]);
    let (send, receive) = mpsc::channel();
    staging.map_async(wgpu::MapMode::Read, .., move |r| {
        let _ = send.send(r);
    });
    device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(30)),
    })?;
    receive.recv_timeout(Duration::from_secs(5))??;
    let view = staging.get_mapped_range(..)?;
    let bytes = view.to_vec();
    drop(view);
    staging.unmap();
    Ok(bytes)
}
