//! Render the real egui panels offscreen, using the same shared-device texture
//! path as the app. This remains usable on a locked desktop and in GPU CI.
use crate::*;
use eframe::egui_wgpu;

fn frame(
    viewer: &mut Viewer,
    ctx: &egui::Context,
    gpu: &egui_wgpu::RenderState,
    size: [u32; 2],
    events: Vec<egui::Event>,
) -> Result<wgpu::Texture> {
    if let Some(gate) = &viewer.submission_gate {
        gate.resume();
    }
    let mut output = ctx.run_ui(
        egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::vec2(size[0] as f32, size[1] as f32),
            )),
            events,
            ..Default::default()
        },
        |ui| {
            viewer.receive_model(ctx);
            viewer.panels(ui);
            viewer.tick(ctx).unwrap();
        },
    );
    let jobs = ctx.tessellate(output.shapes, output.pixels_per_point);
    let screen = egui_wgpu::ScreenDescriptor {
        size_in_pixels: size,
        pixels_per_point: output.pixels_per_point,
    };
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Viewer UI evidence"),
        size: wgpu::Extent3d {
            width: size[0],
            height: size[1],
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    let mut renderer = gpu.renderer.write();
    for (id, delta) in &output.textures_delta.set {
        for part in delta {
            renderer.update_texture(&gpu.device, &gpu.queue, *id, part);
        }
    }
    let mut commands =
        renderer.update_buffers(&gpu.device, &gpu.queue, &mut encoder, &jobs, &screen);
    {
        let pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Viewer panels"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        renderer.render(&mut pass.forget_lifetime(), &jobs, &screen);
    }
    commands.push(encoder.finish());
    gpu.queue.submit(commands);
    for id in &output.textures_delta.free {
        renderer.free_texture(id);
    }
    output.textures_delta.clear();
    Ok(texture)
}
fn save(gpu: &egui_wgpu::RenderState, texture: &wgpu::Texture, path: &Path) -> Result<()> {
    let [w, h] = [texture.width(), texture.height()];
    let stride = (w * 4).div_ceil(256) * 256;
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("UI readback"),
        size: stride as u64 * h as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: None,
            },
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
    gpu.queue.submit([encoder.finish()]);
    let (tx, rx) = std::sync::mpsc::channel();
    buffer.map_async(wgpu::MapMode::Read, .., move |r| {
        let _ = tx.send(r);
    });
    gpu.device.poll(wgpu::PollType::wait_indefinitely())?;
    rx.recv_timeout(Duration::from_secs(30))??;
    let bytes = buffer.get_mapped_range(..)?;
    let pixels = bytes
        .chunks_exact(stride as usize)
        .flat_map(|row| row[..w as usize * 4].iter().copied())
        .collect();
    image::RgbaImage::from_raw(w, h, pixels)
        .unwrap()
        .save(path)?;
    Ok(())
}
fn settle(
    viewer: &mut Viewer,
    ctx: &egui::Context,
    gpu: &egui_wgpu::RenderState,
) -> Result<wgpu::Texture> {
    let started = std::time::Instant::now();
    frame(viewer, ctx, gpu, [1200, 800], vec![])?;
    while !viewer.settled()
        || viewer.environment.name == "Procedural sky" && viewer.environment.image.is_none()
    {
        ensure!(
            started.elapsed() < Duration::from_secs(90),
            "UI failed to settle: {}",
            viewer.error
        );
        frame(viewer, ctx, gpu, [1200, 800], vec![])?;
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(viewer.error.is_empty(), "{}", viewer.error);
    frame(viewer, ctx, gpu, [1200, 800], vec![])
}
#[test]
#[ignore = "requires a real GPU; writes offscreen viewer screenshots"]
fn viewer_panels_examples_and_debug_use_the_shared_gpu_image() -> Result<()> {
    let out = PathBuf::from(
        std::env::var_os("MUTRACER_VIEWER_UI_EVIDENCE").expect("External UI evidence directory"),
    );
    std::fs::create_dir_all(&out)?;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default()))?;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_limits: adapter.limits(),
        required_features: adapter.features()
            & (wgpu::Features::EXPERIMENTAL_RAY_QUERY
                | wgpu::Features::SHADER_F16
                | wgpu::Features::SUBGROUP),
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
        ..Default::default()
    }))?;
    let gpu = egui_wgpu::RenderState {
        available_adapters: vec![adapter.clone()],
        adapter,
        instance,
        target_format: wgpu::TextureFormat::Rgba8Unorm,
        renderer: Arc::new(egui::mutex::RwLock::new(egui_wgpu::Renderer::new(
            &device,
            wgpu::TextureFormat::Rgba8Unorm,
            Default::default(),
        ))),
        device,
        queue,
        surface_config: egui_wgpu::SurfaceConfig::HIGH_THROUGHPUT,
    };
    let ctx = egui::Context::default();
    crate::theme::install(&ctx);
    let mut viewer = Viewer::new_on_device(&default_model(), Some(gpu.clone()))?;
    viewer.resolution.scale = None;
    viewer.size = [240, 160];
    viewer.settings.max_samples = 4;
    viewer.denoise = false;
    viewer.debug_open = false;
    let image = settle(&mut viewer, &ctx, &gpu)?;
    save(&gpu, &image, &out.join("default.png"))?;
    viewer.tab = 5;
    viewer.inspector_open = true;
    // Allow thumbnail responses to arrive while using the same panel code.
    for _ in 0..60 {
        frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
        std::thread::sleep(Duration::from_millis(15));
    }
    let image = frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    save(&gpu, &image, &out.join("models.png"))?;
    viewer.examples.research = true;
    for _ in 0..60 {
        frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
        std::thread::sleep(Duration::from_millis(15));
    }
    let image = frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    save(&gpu, &image, &out.join("research.png"))?;
    let camera = viewer.camera.eye();
    let click = |pos| {
        vec![
            egui::Event::PointerMoved(pos),
            egui::Event::PointerButton {
                pos,
                button: egui::PointerButton::Primary,
                pressed: true,
                modifiers: Default::default(),
            },
            egui::Event::PointerButton {
                pos,
                button: egui::PointerButton::Primary,
                pressed: false,
                modifiers: Default::default(),
            },
        ]
    };
    // Collapse and reopen Examples through its real rail control.
    frame(
        &mut viewer,
        &ctx,
        &gpu,
        [1200, 800],
        click(egui::pos2(1170., 85.)),
    )?;
    assert!(!viewer.inspector_open);
    frame(
        &mut viewer,
        &ctx,
        &gpu,
        [1200, 800],
        click(egui::pos2(1170., 85.)),
    )?;
    assert!(viewer.inspector_open && viewer.tab == 5);
    assert!(viewer.examples.research);
    assert_eq!(
        viewer.camera.eye(),
        camera,
        "Examples controls orbited the viewport"
    );
    let image = frame(&mut viewer, &ctx, &gpu, [800, 600], vec![])?;
    save(&gpu, &image, &out.join("examples-tab-narrow.png"))?;
    viewer.tab = 0;
    viewer.debug_open = true;
    viewer.display_settings.output = 5;
    let image = settle(&mut viewer, &ctx, &gpu)?;
    save(&gpu, &image, &out.join("debug-depth.png"))?;
    let beauty = viewer.final_render().samples();
    assert_eq!(beauty, 4);
    assert_eq!(viewer.samples, 16);
    assert!(viewer.can_export());
    let before = viewer.camera.eye();
    // A coalesced gesture beginning inside the debug card must not orbit.
    let start = egui::pos2(280., 90.);
    let end = egui::pos2(340., 95.);
    let button = |pressed| egui::Event::PointerButton {
        pos: if pressed { start } else { end },
        button: egui::PointerButton::Primary,
        pressed,
        modifiers: Default::default(),
    };
    frame(
        &mut viewer,
        &ctx,
        &gpu,
        [1200, 800],
        vec![
            egui::Event::PointerMoved(start),
            button(true),
            egui::Event::PointerMoved(end),
            button(false),
        ],
    )?;
    assert_eq!(
        viewer.camera.eye(),
        before,
        "Debug controls orbited the viewport"
    );
    viewer.load_preset("research-cornell-box", &ctx);
    while viewer.loading.is_some() {
        frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
        std::thread::sleep(Duration::from_millis(5));
    }
    let image = settle(&mut viewer, &ctx, &gpu)?;
    save(&gpu, &image, &out.join("cornell-depth.png"))?;
    assert_eq!(
        viewer.examples.current.as_deref(),
        Some("research-cornell-box")
    );
    assert_eq!(viewer.camera_index, Some(0));
    assert!(viewer.environment.model_lighting);
    viewer.display_settings.output = 0;
    viewer.tab = 4;
    let image = settle(&mut viewer, &ctx, &gpu)?;
    save(&gpu, &image, &out.join("cornell-camera.png"))?;
    viewer.preview_enabled = false;
    viewer.camera.orbit([5., 0.]);
    viewer.dirty(Change::Camera);
    settle(&mut viewer, &ctx, &gpu)?;
    assert!(std::sync::Arc::ptr_eq(
        viewer.target.render_loop.presented_render().unwrap(),
        viewer.target.render_loop.final_render()
    ));
    assert!(viewer.final_render().settings()?.aovs == 0);
    assert_eq!(viewer.target.render_loop.preview().unwrap().samples(), 0);
    viewer.tab = 5;
    for _ in 0..3 {
        frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    }
    let image = frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    save(&gpu, &image, &out.join("examples-tab.png"))?;
    viewer.tab = 0;
    viewer.load_preset("spheres", &ctx);
    while viewer.loading.is_some() {
        frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
        std::thread::sleep(Duration::from_millis(5));
    }
    settle(&mut viewer, &ctx, &gpu)?;
    assert_eq!(viewer.environment.name, "Procedural sky");
    assert!(viewer.environment.image.is_some());
    assert_eq!(viewer.examples.current.as_deref(), Some("spheres"));
    Ok(())
}
