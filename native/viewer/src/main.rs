//! Small native example: glTF input → native MuTracer library → egui image.
mod denoise;
mod input;
mod renderer;
mod scene;
use anyhow::{Context, Result, ensure};
use eframe::egui;
use renderer::{Camera, Renderer};
use scene::{Environment, Model};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Change {
    None,
    Reset,
    Camera,
    Scene,
}
struct Viewer {
    renderer: Renderer,
    backend: u32,
    backend_status: String,
    model: Model,
    camera: Camera,
    drag: input::ViewportDrag,
    environment: Environment,
    size: [u32; 2],
    target: u32,
    samples: u32,
    exposure: f32,
    selected: usize,
    running: bool,
    change: Change,
    candidate: Option<(Model, Camera)>,
    pixels: Vec<f32>,
    pixel_size: [u32; 2],
    frame_samples: u32,
    generation: u64,
    render_generation: u64,
    frame_generation: u64,
    render_size: [u32; 2],
    denoise: bool,
    denoised: Vec<f32>,
    denoiser: Option<denoise::Worker>,
    denoise_status: String,
    last_denoise: Option<(u64, u32)>,
    last_scene_commit: std::time::Instant,
    texture: Option<egui::TextureHandle>,
    display_dirty: bool,
    error: String,
}
impl Viewer {
    fn new(path: &Path) -> Result<Self> {
        let model = Model::load(path)?;
        let camera = Camera::fit(model.center, model.radius);
        let mut renderer = Renderer::with_backend(1)?;
        let environment = Environment::default();
        let size = [480, 320];
        renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
        let selected = model.meshes[0].material;
        Ok(Self {
            backend: 1,
            backend_status: Self::describe_backend(renderer.backend()?),
            renderer,
            model,
            camera,
            drag: input::ViewportDrag::default(),
            environment,
            size,
            target: 64,
            samples: 0,
            exposure: 0.,
            selected,
            running: true,
            change: Change::None,
            candidate: None,
            pixels: vec![],
            pixel_size: size,
            frame_samples: 0,
            generation: 1,
            render_generation: 1,
            frame_generation: 0,
            render_size: size,
            denoise: true,
            denoised: vec![],
            denoiser: None,
            denoise_status: String::new(),
            last_denoise: None,
            last_scene_commit: std::time::Instant::now(),
            texture: None,
            display_dirty: false,
            error: String::new(),
        })
    }
    fn describe_backend((active, reason): (u32, String)) -> String {
        match active {
            2 => "HWRT closest + shadows".into(),
            1 => "HWRT shadows · software closest".into(),
            _ if !reason.is_empty() => format!("Software BVH · {reason}"),
            _ => "Software BVH".into(),
        }
    }
    fn commit_scene(&mut self, bytes: &[u8]) -> Result<()> {
        if self.renderer.mode != self.backend {
            let mut candidate = Renderer::with_backend(self.backend)?;
            candidate.commit(bytes)?;
            self.renderer = candidate;
        } else {
            self.renderer.commit(bytes)?;
        }
        self.backend_status = Self::describe_backend(self.renderer.backend()?);
        Ok(())
    }
    fn dirty(&mut self, change: Change) {
        self.change = self.change.max(change);
        self.generation += 1;
    }
    fn load(&mut self, path: PathBuf) {
        match Model::load(&path) {
            Ok(model) => {
                let camera = Camera::fit(model.center, model.radius);
                self.candidate = Some((model, camera));
                self.dirty(Change::Scene);
            }
            Err(e) => self.error = format!("Could not load model: {e:#}"),
        }
    }
    fn tick(&mut self, ctx: &egui::Context) -> Result<()> {
        if self.change != Change::None || !self.running {
            self.renderer.cancel()?;
        }
        let finished = self.renderer.poll()?;
        // Read the completed old frame before applying pending input. Keep it on
        // screen until a newer frame arrives, including while a slider is held.
        if finished {
            self.samples = self.renderer.samples()?;
            if self.samples > 0 {
                self.pixels = self.renderer.pixels()?;
                self.pixel_size = self.render_size;
                self.frame_samples = self.samples;
                self.frame_generation = self.render_generation;
                self.denoised.clear();
                self.display_dirty = true;
            }
        }
        let held = ctx.input(|i| i.pointer.any_down());
        if !self.renderer.busy() {
            let deferred = self.change == Change::Scene
                && held
                && self.last_scene_commit.elapsed() < Duration::from_millis(120);
            if !deferred {
                match self.change {
                    Change::Scene => {
                        if let Some((model, camera)) = self.candidate.take() {
                            self.commit_scene(&model.descriptor(
                                &camera.bytes(),
                                self.size,
                                &self.environment,
                            ))?;
                            self.model = model;
                            self.camera = camera;
                            self.selected = self.model.meshes[0].material;
                        } else {
                            self.commit_scene(&self.model.descriptor(
                                &self.camera.bytes(),
                                self.size,
                                &self.environment,
                            ))?;
                        }
                    }
                    Change::Camera => self.renderer.camera(&self.camera.bytes())?,
                    Change::Reset => self.renderer.reset()?,
                    Change::None => {}
                }
                if self.change != Change::None {
                    self.samples = 0;
                    if self.change == Change::Scene {
                        self.last_scene_commit = std::time::Instant::now();
                    }
                    self.render_generation = self.generation;
                    self.render_size = self.size;
                    self.change = Change::None;
                    self.error.clear();
                }
            }
        }
        if let Some(output) = self.denoiser.as_mut().and_then(|d| d.poll()) {
            if output.generation == self.generation && output.samples == self.frame_samples {
                match output.pixels {
                    Ok(pixels) => {
                        self.denoised = pixels;
                        self.denoise_status =
                            format!("{} · {:.0} ms", output.backend, output.milliseconds);
                        self.display_dirty = true;
                    }
                    Err(error) => self.denoise_status = error,
                }
            }
        }
        if self.denoise
            && !held
            && !self.renderer.busy()
            && self.change == Change::None
            && !self.pixels.is_empty()
            && self.frame_generation == self.generation
            && (self.samples >= self.target
                || !self.running
                || self.samples >= 8 && self.samples.is_power_of_two())
            && self.last_denoise != Some((self.generation, self.samples))
        {
            let worker = self
                .denoiser
                .get_or_insert_with(|| denoise::Worker::new(ctx.clone()));
            if !worker.busy {
                worker.submit(denoise::Request {
                    generation: self.generation,
                    samples: self.samples,
                    size: self.pixel_size,
                    color: self.pixels.clone(),
                    normal: self.renderer.image(1)?,
                    albedo: self.renderer.image(2)?,
                })?;
                self.last_denoise = Some((self.generation, self.samples));
                self.denoise_status = "Denoising…".into();
            }
        }
        if !self.renderer.busy()
            && self.change == Change::None
            && self.running
            && self.samples < self.target
        {
            // Dispatch now, before the next input can cancel a queued job.
            self.renderer
                .start((self.target - self.samples).min(if held { 1 } else { 4 }))?;
            self.renderer.poll()?;
        }
        if self.display_dirty && !self.pixels.is_empty() {
            let pixels = renderer::display(self.display_pixels(), self.pixel_size, self.exposure);
            let image = egui::ColorImage::from_rgba_unmultiplied(
                [self.pixel_size[0] as usize, self.pixel_size[1] as usize],
                &pixels,
            );
            if let Some(texture) = &mut self.texture {
                texture.set(image, egui::TextureOptions::LINEAR);
            } else {
                self.texture =
                    Some(ctx.load_texture("MuTracer render", image, egui::TextureOptions::LINEAR));
            }
            self.display_dirty = false;
        }
        if self.renderer.busy()
            || self.running && self.samples < self.target
            || self.change != Change::None
        {
            ctx.request_repaint_after(Duration::from_millis(16));
        }
        Ok(())
    }
    fn display_pixels(&self) -> &[f32] {
        if self.denoise && !self.denoised.is_empty() {
            &self.denoised
        } else {
            &self.pixels
        }
    }
    fn panels(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::top("toolbar").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.strong("MuTracer");
                ui.separator();
                if ui.button("Open GLTF / GLB…").clicked() {
                    if let Some(path) = rfd::FileDialog::new()
                        .add_filter("glTF", &["gltf", "glb"])
                        .pick_file()
                    {
                        self.load(path);
                    }
                }
                ui.label(&self.model.name);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui
                        .add_enabled(!self.pixels.is_empty(), egui::Button::new("Save PNG…"))
                        .clicked()
                    {
                        if let Some(path) = rfd::FileDialog::new()
                            .set_file_name("mutracer.png")
                            .add_filter("PNG", &["png"])
                            .save_file()
                        {
                            if let Err(e) = renderer::save(
                                &path,
                                self.display_pixels(),
                                self.pixel_size,
                                self.exposure,
                            ) {
                                self.error = e.to_string();
                            }
                        }
                    }
                });
            });
        });
        egui::SidePanel::left("settings")
            .resizable(false)
            .exact_width(265.)
            .show(ctx, |ui| {
                egui::ScrollArea::vertical().show(ui, |ui| {
                    ui.add_space(10.);
                    ui.heading("Render");
                    ui.horizontal(|ui| {
                        ui.label(format!("{} / {} samples", self.samples, self.target));
                        if ui
                            .button(if self.running { "Pause" } else { "Resume" })
                            .clicked()
                        {
                            self.running = !self.running;
                        }
                        if ui.button("Restart").clicked() {
                            self.dirty(Change::Reset);
                        }
                    });
                    ui.add(
                        egui::Slider::new(&mut self.target, 8..=1024)
                            .logarithmic(true)
                            .text("Samples"),
                    );
                    let old = self.size;
                    egui::ComboBox::from_label("Resolution")
                        .selected_text(format!("{} × {}", self.size[0], self.size[1]))
                        .show_ui(ui, |ui| {
                            for width in [320, 480, 640, 960] {
                                let size = [width, width * 2 / 3];
                                ui.selectable_value(
                                    &mut self.size,
                                    size,
                                    format!("{} × {}", size[0], size[1]),
                                );
                            }
                        });
                    if old != self.size {
                        self.dirty(Change::Scene);
                    }
                    if ui
                        .add(egui::Slider::new(&mut self.exposure, -4.0..=4.0).text("Exposure"))
                        .changed()
                    {
                        self.display_dirty = true;
                    }
                    let old_backend = self.backend;
                    egui::ComboBox::from_label("Ray tracing")
                        .selected_text(["Software", "Auto", "HWRT"][self.backend as usize])
                        .show_ui(ui, |ui| {
                            for (mode, name) in [(1, "Auto"), (0, "Software"), (2, "HWRT")] {
                                ui.selectable_value(&mut self.backend, mode, name);
                            }
                        });
                    if old_backend != self.backend {
                        self.dirty(Change::Scene);
                    }
                    ui.small(&self.backend_status);
                    if ui.checkbox(&mut self.denoise, "Native OIDN").changed() {
                        self.display_dirty = true;
                        self.last_denoise = None;
                    }
                    if self.denoise {
                        ui.small(&self.denoise_status);
                    }
                    ui.add_space(14.);
                    ui.heading("Camera");
                    if ui.button("Fit model").clicked() {
                        self.camera = Camera::fit(self.model.center, self.model.radius);
                        self.dirty(Change::Camera);
                    }
                    if ui
                        .add(
                            egui::Slider::new(&mut self.camera.fov, 20.0..=90.0)
                                .text("Field of view"),
                        )
                        .changed()
                    {
                        self.dirty(Change::Camera);
                    }
                    ui.small("Drag to orbit · Shift/right drag to pan\nScroll to zoom · F to fit");
                    ui.add_space(14.);
                    ui.heading("Material");
                    egui::ComboBox::from_id_salt("material")
                        .selected_text(&self.model.materials[self.selected].name)
                        .width(230.)
                        .show_ui(ui, |ui| {
                            for (i, m) in self.model.materials.iter().enumerate() {
                                if !self.model.meshes.iter().any(|mesh| mesh.material == i) {
                                    continue;
                                }
                                ui.selectable_value(&mut self.selected, i, &m.name);
                            }
                        });
                    let m = &mut self.model.materials[self.selected];
                    let mut changed = false;
                    ui.horizontal(|ui| {
                        ui.label("Base color");
                        changed |= ui.color_edit_button_rgb(&mut m.color).changed();
                    });
                    changed |= ui
                        .add(egui::Slider::new(&mut m.roughness, 0.0..=1.0).text("Roughness"))
                        .changed();
                    changed |= ui
                        .add(egui::Slider::new(&mut m.metalness, 0.0..=1.0).text("Metalness"))
                        .changed();
                    changed |= ui
                        .add(egui::Slider::new(&mut m.transmission, 0.0..=1.0).text("Transmission"))
                        .changed();
                    if changed {
                        self.dirty(Change::Scene);
                    }
                    ui.add_space(14.);
                    ui.heading("Environment");
                    ui.label(&self.environment.name);
                    let mut changed = false;
                    changed |= ui
                        .add(
                            egui::Slider::new(&mut self.environment.intensity, 0.0..=5.0)
                                .text("Intensity"),
                        )
                        .changed();
                    changed |= ui
                        .add(
                            egui::Slider::new(&mut self.environment.rotation, 0.0..=360.0)
                                .text("Rotation"),
                        )
                        .changed();
                    ui.horizontal(|ui| {
                        ui.label("Tint");
                        changed |= ui
                            .color_edit_button_rgb(&mut self.environment.color)
                            .changed();
                    });
                    changed |= ui
                        .checkbox(&mut self.environment.background, "Show environment")
                        .changed();
                    ui.horizontal(|ui| {
                        if ui.button("Load HDR…").clicked() {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("Radiance HDR", &["hdr"])
                                .pick_file()
                            {
                                match self.environment.load(&path) {
                                    Ok(()) => changed = true,
                                    Err(e) => {
                                        self.error = format!("Could not load environment: {e:#}")
                                    }
                                }
                            }
                        }
                        if ui.button("Studio").clicked() {
                            self.environment = Environment::default();
                            changed = true;
                        }
                    });
                    if changed {
                        self.dirty(Change::Scene);
                    }
                    ui.add_space(14.);
                    ui.small(format!(
                        "{} meshes · {} triangles",
                        self.model.meshes.len(),
                        self.model
                            .geometries
                            .iter()
                            .map(|g| g.indices.len() / 3)
                            .sum::<usize>()
                    ));
                    for warning in &self.model.warnings {
                        ui.colored_label(egui::Color32::YELLOW, warning);
                    }
                    if !self.error.is_empty() {
                        ui.separator();
                        ui.colored_label(egui::Color32::LIGHT_RED, &self.error);
                    }
                });
            });
        egui::CentralPanel::default()
            .frame(
                egui::Frame::central_panel(&ctx.style()).fill(egui::Color32::from_rgb(18, 20, 24)),
            )
            .show(ctx, |ui| {
                let available = ui.available_size();
                let aspect = self.size[0] as f32 / self.size[1] as f32;
                let width = available.x.min(available.y * aspect);
                let size = egui::vec2(width, width / aspect);
                let rect = egui::Rect::from_center_size(ui.max_rect().center(), size);
                if let Some(texture) = &self.texture {
                    ui.painter().image(
                        texture.id(),
                        rect,
                        egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1., 1.)),
                        egui::Color32::WHITE,
                    );
                } else {
                    ui.painter().text(
                        rect.center(),
                        egui::Align2::CENTER_CENTER,
                        if self.running {
                            "Rendering…"
                        } else {
                            "Paused — Resume to render"
                        },
                        egui::FontId::proportional(18.),
                        egui::Color32::GRAY,
                    );
                }
                let response = ui.interact(rect, ui.id().with("viewport"), egui::Sense::drag());
                for (pan, delta) in
                    ui.input(|i| self.drag.motion(rect, response.contains_pointer(), i))
                {
                    if pan {
                        self.camera.pan([delta.x, delta.y]);
                    } else {
                        self.camera.orbit([delta.x, delta.y]);
                    }
                    self.dirty(Change::Camera);
                }
                if response.hovered() {
                    let scroll = ui.input(|i| i.smooth_scroll_delta.y);
                    if scroll != 0. {
                        self.camera.zoom(scroll);
                        self.dirty(Change::Camera);
                    }
                }
            });
        if ctx.input(|i| i.key_pressed(egui::Key::F)) && !ctx.wants_keyboard_input() {
            self.camera = Camera::fit(self.model.center, self.model.radius);
            self.dirty(Change::Camera);
        }
    }
}
impl eframe::App for Viewer {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if let Some(path) = ctx.input(|i| i.raw.dropped_files.iter().find_map(|f| f.path.clone())) {
            self.load(path);
        }
        self.panels(ctx);
        if let Err(e) = self.tick(ctx) {
            self.error = format!("Render stopped: {e:#}");
            self.running = false;
            self.change = Change::None;
        }
        // Input can arrive after tick, including the final event of a short drag.
        // Ensure camera changes are committed even when accumulation was idle.
        if self.change != Change::None {
            ctx.request_repaint();
        }
    }
}
fn default_model() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for path in [dir.join("../Resources/sample.glb"), dir.join("sample.glb")] {
                if path.exists() {
                    return path;
                }
            }
        }
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb")
}
fn smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut model = Model::load(path)?;
    let mut camera = Camera::fit(model.center, model.radius);
    let mut environment = Environment::default();
    let size = [320, 216];
    let mut renderer = Renderer::new()?;
    renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
    let original = renderer.finish(16)?;
    renderer::save(&out.join("original.png"), &original, size, 0.)?;
    let normal = renderer.image(1)?;
    let albedo = renderer.image(2)?;
    let mut hardware = Renderer::with_backend(1)?;
    hardware.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
    let hardware_pixels = hardware.finish(16)?;
    let (backend, reason) = hardware.backend()?;
    let mut max_diff = 0f32;
    for (a, b) in original.iter().zip(&hardware_pixels) {
        max_diff = max_diff.max((a - b).abs());
    }
    ensure!(
        hardware.image(1)? == normal && hardware.image(2)? == albedo,
        "HWRT guide mismatch"
    );
    ensure!(max_diff <= 5e-7, "HWRT color mismatch: {max_diff}");
    let counts = if backend != 0 {
        Some(hardware.counts()?)
    } else {
        None
    };
    if let Some(counts) = counts {
        ensure!(
            counts[4] > 0 && counts[9] == 0,
            "HWRT did not execute or shadow validation disagreed: {counts:?}"
        );
    }
    std::fs::write(
        out.join("hardware.txt"),
        format!("backend {backend}; {reason}; max HDR difference {max_diff}; counts {counts:?}\n"),
    )?;
    drop(hardware);

    let mut oidn = denoise::Denoiser::new()?;
    let start = std::time::Instant::now();
    let denoised = oidn.run(size, &original, &normal, &albedo)?;
    let denoise_ms = start.elapsed().as_secs_f64() * 1000.;
    ensure!(denoised != original, "OIDN did not change noisy pixels");
    ensure!(
        denoised
            .chunks_exact(4)
            .zip(original.chunks_exact(4))
            .all(|(a, b)| a[3] == b[3]),
        "OIDN changed alpha"
    );
    renderer::save(&out.join("denoised.png"), &denoised, size, 0.)?;
    let reference = renderer.finish(240)?;
    renderer::save(&out.join("reference.png"), &reference, size, 0.)?;
    let rmse = |pixels: &[f32]| {
        (pixels
            .iter()
            .zip(&reference)
            .enumerate()
            .filter(|(i, _)| i % 4 != 3)
            .map(|(_, (a, b))| f64::from(a - b).powi(2))
            .sum::<f64>()
            / (size[0] * size[1] * 3) as f64)
            .sqrt()
    };
    let report = format!(
        "{}: {:.2} ms; noisy RMSE {}; denoised RMSE {}\n",
        oidn.backend,
        denoise_ms,
        rmse(&original),
        rmse(&denoised)
    );
    std::fs::write(out.join("denoise.txt"), &report)?;
    println!("{report}");
    std::fs::write(
        out.join("denoised.rgba32f"),
        denoised
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    )?;
    renderer.reset()?;
    ensure!(
        renderer.finish(16)? == original,
        "Denoising modified accumulation"
    );

    renderer.start(4)?;
    renderer.cancel()?;
    ensure!(
        renderer.poll()? && renderer.samples()? == 16,
        "Queued cancellation lost samples"
    );
    renderer.reset()?;
    ensure!(
        renderer.finish(16)? == original,
        "Restart changed the original image"
    );
    camera.orbit([70., -20.]);
    renderer.camera(&camera.bytes())?;
    let orbit = renderer.finish(16)?;
    ensure!(original != orbit, "Camera control did not change pixels");
    renderer::save(&out.join("orbit.png"), &orbit, size, 0.)?;
    camera = Camera::fit(model.center, model.radius);
    renderer.camera(&camera.bytes())?;
    ensure!(
        renderer.finish(16)? == original,
        "Restoring camera changed the original image"
    );
    let first_material = model.meshes[0].material;
    model.materials[first_material].color = [0.05, 0.85, 0.15];
    model.materials[first_material].roughness = 0.8;
    renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
    let material = renderer.finish(16)?;
    ensure!(material != original, "Material edit did not change pixels");
    renderer::save(&out.join("material.png"), &material, size, 0.)?;
    environment.intensity = 0.2;
    renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
    let env = renderer.finish(16)?;
    ensure!(env != material, "Environment edit did not change pixels");
    renderer::save(&out.join("environment.png"), &env, size, 0.)?;
    let hdr_path = out.join("studio.hdr");
    let mut hdr = b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n".to_vec();
    for _ in 0..8 {
        hdr.extend([128, 80, 32, 130]);
    }
    std::fs::write(&hdr_path, hdr)?;
    environment.load(&hdr_path)?;
    renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
    let hdr = renderer.finish(16)?;
    ensure!(
        hdr != env,
        "Loading an HDR environment did not change pixels"
    );
    renderer::save(&out.join("hdr.png"), &hdr, size, 0.)?;
    std::fs::write(
        out.join("original.rgba32f"),
        original
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    )?;
    println!(
        "PASS native viewer: {} meshes, {} materials, {} textures; glTF/render/orbit/restore/material/environment",
        model.meshes.len(),
        model.materials.len(),
        model.textures.len()
    );
    Ok(())
}
fn interaction_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut viewer = Viewer::new(path)?;
    viewer.denoise = false;
    let ctx = egui::Context::default();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while viewer.texture.is_none() {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Initial preview timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    let before = viewer.pixels.clone();
    let mut frames = 0;
    let mut last = viewer.pixels.clone();
    for step in 0..120 {
        ctx.begin_pass(egui::RawInput {
            events: if step == 0 {
                vec![egui::Event::PointerButton {
                    pos: egui::pos2(700., 400.),
                    button: egui::PointerButton::Primary,
                    pressed: true,
                    modifiers: egui::Modifiers::NONE,
                }]
            } else {
                vec![]
            },
            ..Default::default()
        });
        viewer.camera.orbit([1., 0.]);
        viewer.dirty(Change::Camera);
        viewer.tick(&ctx)?;
        ensure!(
            viewer.texture.is_some() && !viewer.pixels.is_empty(),
            "Interaction blanked preview"
        );
        let _ = ctx.end_pass();
        if viewer.pixels != last {
            frames += 1;
            last = viewer.pixels.clone();
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let _ = ctx.run(
        egui::RawInput {
            events: vec![egui::Event::PointerButton {
                pos: egui::pos2(700., 400.),
                button: egui::PointerButton::Primary,
                pressed: false,
                modifiers: egui::Modifiers::NONE,
            }],
            ..Default::default()
        },
        |_| {},
    );
    ensure!(
        frames >= 3 && last != before,
        "Continuous input starved preview rendering: {frames} updates"
    );
    renderer::save(
        &out.join("interactive.png"),
        &viewer.pixels,
        viewer.pixel_size,
        0.,
    )?;
    std::fs::write(
        out.join("interaction.txt"),
        format!("PASS 120 camera updates, {frames} changed previews, zero blank frames\n"),
    )?;
    println!("PASS 120 camera updates, {frames} changed previews, zero blank frames");
    viewer.target = 8;
    viewer.denoise = true;
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !viewer.denoiser.as_ref().is_some_and(|d| d.busy) {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Denoise submission timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    viewer.denoise = false;
    viewer.size = [320, 213];
    viewer.dirty(Change::Scene);
    while viewer.denoiser.as_ref().is_some_and(|d| d.busy) {
        viewer.tick(&ctx)?;
        ensure!(
            viewer.denoised.is_empty(),
            "Stale denoise replaced a changed scene"
        );
        ensure!(
            viewer.texture.is_some(),
            "Resolution change blanked preview"
        );
        ensure!(
            std::time::Instant::now() < deadline,
            "Stale denoise did not finish"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    viewer.denoise = true;
    while viewer.denoised.is_empty() {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Final denoise did not finish"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(
        viewer.pixel_size == [320, 213] && viewer.denoised.len() == 320 * 213 * 4,
        "Wrong denoise dimensions"
    );
    renderer::save(
        &out.join("interactive-denoised.png"),
        &viewer.denoised,
        viewer.pixel_size,
        0.,
    )?;
    println!(
        "PASS stale OIDN result ignored; resized preview retained; final native denoise completed"
    );
    viewer.denoise = false;
    viewer.target = 12;
    while viewer.samples < 12 {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Extra samples timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    viewer.target = 8;
    viewer.denoise = true;
    while viewer.denoised.is_empty() {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Lowered-target denoise timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    println!("PASS native denoise after lowering target below completed samples");

    Ok(())
}
fn main() -> Result<()> {
    let mut model = None;
    let mut smoke_out = None;
    let mut interaction_out = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--interaction-smoke" => {
                interaction_out = Some(PathBuf::from(
                    args.next()
                        .context("--interaction-smoke needs a directory")?,
                ))
            }
            "--smoke-out" => {
                smoke_out = Some(PathBuf::from(
                    args.next().context("--smoke-out needs a directory")?,
                ))
            }
            _ if arg.starts_with('-') => anyhow::bail!(
                "Usage: mutracer-viewer [MODEL.gltf|MODEL.glb] [--smoke-out DIRECTORY]"
            ),
            _ => model = Some(PathBuf::from(arg)),
        }
    }
    let model = model.unwrap_or_else(default_model);
    if let Some(out) = interaction_out {
        return interaction_smoke(&model, &out);
    }
    if let Some(out) = smoke_out {
        return smoke(&model, &out);
    }
    let viewer = Viewer::new(&model)?;
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1120., 760.])
            .with_min_inner_size([800., 560.]),
        renderer: eframe::Renderer::Glow,
        ..Default::default()
    };
    eframe::run_native(
        "MuTracer Native Viewer",
        options,
        Box::new(move |cc| {
            cc.egui_ctx.set_visuals(egui::Visuals::dark());
            Ok(Box::new(viewer))
        }),
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))
}
