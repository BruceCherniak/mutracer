use super::{Display, Settings, bloom::Bloom, image};
pub(super) fn uniform(device: &wgpu::Device, words: &[u32]) -> wgpu::Buffer {
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Display pass parameters"),
        size: (words.len() * 4) as u64,
        usage: wgpu::BufferUsages::UNIFORM,
        mapped_at_creation: true,
    });
    buffer.get_mapped_range_mut(..).unwrap().copy_from_slice(
        &words
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    );
    buffer.unmap();
    buffer
}
pub(super) struct Effects {
    pipeline: wgpu::ComputePipeline,
    normalize: wgpu::ComputePipeline,
    hdr_pipeline: Option<wgpu::ComputePipeline>,
    linear_pipeline: Option<wgpu::ComputePipeline>,
    guide_pipeline: Option<wgpu::ComputePipeline>,
    dummy: wgpu::Texture,
    zero: wgpu::Buffer,
    normalized: Option<wgpu::Texture>,
    bloom: Option<Bloom>,
    key: Option<(u32, u32, u64, bool)>,
    revision: u64,
    #[cfg(test)]
    pub(super) bloom_runs: u32,
}
impl Effects {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared Web display effects"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../display-effects.wgsl").into()),
        });
        let pipeline = |entry| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: None,
                module: &shader,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        Self {
            pipeline: pipeline("main"),
            normalize: pipeline("normalize"),
            hdr_pipeline: None,
            linear_pipeline: None,
            guide_pipeline: None,
            dummy: image(device, [1, 1], wgpu::TextureFormat::Rgba16Float),
            zero: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Empty catcher"),
                size: 48,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            }),
            normalized: None,
            bloom: None,
            key: None,
            revision: 0,
            #[cfg(test)]
            bloom_runs: 0,
        }
    }
    pub(super) fn prepare_composition(&mut self, device: &wgpu::Device, sources: &[String; 2]) {
        for (slot, source) in [&mut self.linear_pipeline, &mut self.guide_pipeline]
            .into_iter()
            .zip(sources)
        {
            if slot.is_none() {
                let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("Shared TS JNLM composition"),
                    source: wgpu::ShaderSource::Wgsl(source.as_str().into()),
                });
                *slot = Some(
                    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                        label: Some("Shared TS JNLM composition"),
                        layout: None,
                        module: &module,
                        entry_point: Some("main"),
                        compilation_options: Default::default(),
                        cache: None,
                    }),
                );
            }
        }
    }
    pub fn reset(&mut self) {
        self.key = None;
    }
    pub fn compose(
        &mut self,
        display: &Display,
        settings: &Settings,
        premultiply: bool,
        target: &wgpu::Texture,
    ) {
        self.compose_inner(display, settings, premultiply, target, false);
    }
    pub(super) fn compose_guide(
        &mut self,
        display: &Display,
        settings: &Settings,
        target: &wgpu::Texture,
    ) {
        self.compose_inner(display, settings, false, target, true);
    }
    fn compose_inner(
        &mut self,
        display: &Display,
        settings: &Settings,
        premultiply: bool,
        target: &wgpu::Texture,
        guide: bool,
    ) {
        let gpu = &display.gpu;
        let device = &gpu.device;
        let linear = target.format() == wgpu::TextureFormat::Rgba32Float;
        let hdr = target.format() == wgpu::TextureFormat::Rgba16Float;
        if hdr && self.hdr_pipeline.is_none() {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("HDR display composition"),
                source: wgpu::ShaderSource::Wgsl(include_str!("../display-hdr.wgsl").into()),
            });
            self.hdr_pipeline = Some(device.create_compute_pipeline(
                &wgpu::ComputePipelineDescriptor {
                    label: Some("HDR display composition"),
                    layout: None,
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: Default::default(),
                    cache: None,
                },
            ));
        }
        let final_channel = settings.output == 0 || settings.output == 3;
        let enabled =
            final_channel && settings.bloom_intensity > 0. && display.shown_samples(settings) >= 10;
        let mut words = vec![
            display.size[0],
            display.size[1],
            (display.samples as f32).to_bits(),
            settings.exposure.to_bits(),
            settings.tone_mapping,
            settings.output,
            u32::from(settings.preserve_alpha) | (u32::from(premultiply) << 1),
            (display.shown_samples(settings).max(1) as f32).to_bits(),
        ];
        words.extend(
            [
                settings.contrast,
                settings.saturation,
                settings.temperature,
                settings.tint,
                settings.vignette,
                if enabled {
                    settings.bloom_intensity
                } else {
                    0.
                },
                settings.bloom_threshold,
                settings.bloom_radius,
                settings.shadow_catcher_color[0],
                settings.shadow_catcher_color[1],
                settings.shadow_catcher_color[2],
                settings.shadow_catcher_alpha,
            ]
            .map(f32::to_bits),
        );
        words.extend(
            display
                .shown_metadata(settings)
                .flat_background
                .map(f32::to_bits),
        );
        words.extend([
            u32::from(display.shown_metadata(settings).has_catcher),
            u32::from(display.using_denoised),
            0,
            0,
        ]);
        let params = uniform(device, &words);
        let mut encoder = device.create_command_encoder(&Default::default());
        if enabled {
            let key = (
                settings.bloom_threshold.to_bits(),
                settings.bloom_radius.to_bits(),
                display.denoise_revision,
                display.using_denoised,
            );
            if self.key != Some(key)
                || (display.shown_samples(settings) % 10 == 0
                    && self.revision != display.shown_revision(settings))
            {
                let normalized = self.normalized.get_or_insert_with(|| {
                    image(device, display.size, wgpu::TextureFormat::Rgba32Float)
                });
                let view = normalized.create_view(&Default::default());
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &self.normalize.get_bind_group_layout(0),
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: display.linear.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: display.shown_albedo(settings).as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 6,
                            resource: params.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 8,
                            resource: wgpu::BindingResource::TextureView(&view),
                        },
                    ],
                });
                {
                    let mut pass = encoder.begin_compute_pass(&Default::default());
                    pass.set_pipeline(&self.normalize);
                    pass.set_bind_group(0, &group, &[]);
                    pass.dispatch_workgroups(
                        display.size[0].div_ceil(8),
                        display.size[1].div_ceil(8),
                        1,
                    );
                }
                let bloom = self
                    .bloom
                    .get_or_insert_with(|| Bloom::new(device, display.size));
                #[cfg(test)]
                super::effects_tests::record_order("Bloom:SceneLinear");
                bloom.run(gpu, &mut encoder, normalized, settings);
                self.key = Some(key);
                self.revision = display.shown_revision(settings);
                #[cfg(test)]
                {
                    self.bloom_runs += 1;
                }
            }
        }
        let bloom = if enabled {
            self.bloom.as_ref().unwrap().output()
        } else {
            &self.dummy
        };
        let pipeline = if linear {
            if guide {
                self.guide_pipeline.as_ref().unwrap()
            } else {
                self.linear_pipeline.as_ref().unwrap()
            }
        } else if hdr {
            self.hdr_pipeline.as_ref().unwrap()
        } else {
            &self.pipeline
        };
        #[cfg(test)]
        if !guide {
            if settings.output != 0 && settings.output != 3 {
                super::effects_tests::record_order("AOV:Raw");
            } else {
                if display.using_denoised && display.shown_metadata(settings).has_catcher {
                    super::effects_tests::record_order("CorrectLayers:SceneLinear");
                }
                super::effects_tests::record_order(if linear || hdr {
                    "Compose:DisplayLinear"
                } else {
                    "Compose:DisplayEncoded"
                });
            }
        }
        let bloom_view = bloom.create_view(&Default::default());
        let output_view = target.create_view(&Default::default());
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: display.linear.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: display.shown_raw(settings).as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: display.normal.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: display.shown_albedo(settings).as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: display
                        .shown_shadow(settings)
                        .unwrap_or(&self.zero)
                        .as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(&bloom_view),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::TextureView(&output_view),
                },
            ],
        });
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(display.size[0].div_ceil(8), display.size[1].div_ceil(8), 1);
        }
        gpu.queue.submit([encoder.finish()]);
    }
}
#[cfg(test)]
impl Effects {
    pub(super) fn bloom_output(&self) -> Option<(&wgpu::Texture, u32)> {
        self.bloom.as_ref().map(|b| (b.output(), self.bloom_runs))
    }
}
