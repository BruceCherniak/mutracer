//! Small native example: glTF input → native MuTracer library → egui image.
mod controls;
mod denoise;
mod edit_bench;
mod focus;
mod focus_smoke;
mod geometry_smoke;
mod import;
mod input;
mod material_presets;
mod metrics;
mod package_smoke;
mod parity_smoke;
mod picking;
mod renderer;
mod scene;
mod studio;
mod studio_smoke;
mod theme;
mod ui;
use anyhow::{Context, Result, ensure};
use eframe::egui;
use renderer::{Camera, RenderSettings, Renderer};
use scene::{Descriptor, Environment, KeyLight, Model};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Change {
    None,
    Reset,
    Camera,
    Material,
    Environment,
    Light,
    Transform,
    Scene,
}
struct Viewer {
    submission_gate: Option<std::sync::Arc<mutracer_native_probe::submission::SubmissionGate>>,
    startup_smoke: Option<(PathBuf, std::time::Instant, u32)>,
    metrics: Option<metrics::Metrics>,
    renderer: Renderer,
    gpu: Option<eframe::egui_wgpu::RenderState>,
    gpu_display: Option<mutracer_native_probe::display::Display>,
    gpu_texture: Option<egui::TextureId>,
    commit: Option<(
        std::sync::mpsc::Receiver<Result<renderer::SceneCommit>>,
        u64,
        Option<(Model, Camera)>,
        [u32; 2],
    )>,
    backend: u32,
    backend_status: String,
    model: Model,
    descriptor: Option<Descriptor>,
    camera: Camera,
    drag: input::ViewportDrag,
    environment: Environment,
    light: KeyLight,
    size: [u32; 2],
    settings: RenderSettings,
    picking_focus: bool,
    focus: focus::AutoFocus,
    samples: u32,
    display_settings: mutracer_native_probe::display::Settings,
    selected: usize,
    selected_mesh: Option<usize>,
    tab: usize,
    scene_open: bool,
    inspector_open: bool,
    object_query: String,
    loading: Option<std::sync::mpsc::Receiver<Result<Model>>>,
    loading_name: String,
    queued_load: Option<PathBuf>,
    running: bool,
    change: Change,
    candidate: Option<(Model, Camera)>,
    pixels: Vec<f32>,
    pixel_size: [u32; 2],
    frame_samples: u32,
    frame_pending: bool,
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
    /// Whether the last completed commit prepared the scene again.
    last_commit_full: bool,
    texture: Option<egui::TextureHandle>,
    checker: Option<egui::TextureHandle>,
    display_dirty: bool,
    error: String,
}
impl Viewer {
    fn new(path: &Path) -> Result<Self> {
        Self::new_on_device(path, None)
    }
    fn new_on_device(path: &Path, gpu: Option<eframe::egui_wgpu::RenderState>) -> Result<Self> {
        let model = Model::load(path)?;
        let camera = Camera::fit(model.center, model.radius);
        let mut renderer = if let Some(gpu) = &gpu {
            Renderer::on_device(gpu, 1)?
        } else {
            Renderer::new()?
        };
        let environment = Environment::default();
        let metrics = metrics::Metrics::from_env();
        let size = if metrics.is_some() {
            [1280, 720]
        } else {
            [480, 320]
        };
        let mut descriptor = None;
        if gpu.is_none() {
            renderer.commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &KeyLight::default(),
            ))?;
        }
        let selected = model.meshes[0].material;
        let submission_gate = renderer.shared.as_ref().map(|shared| shared.3.clone());
        if let Some(gate) = &submission_gate {
            gate.pause();
        }
        Ok(Self {
            submission_gate,
            startup_smoke: None,
            metrics,
            backend: 1,
            backend_status: if gpu.is_some() {
                "Preparing scene…".into()
            } else {
                Self::describe_backend(renderer.backend()?)
            },
            renderer,
            gpu: gpu.clone(),
            gpu_display: None,
            gpu_texture: None,
            commit: None,
            model,
            descriptor,
            camera,
            drag: input::ViewportDrag::default(),
            environment,
            light: KeyLight::default(),
            size,
            settings: RenderSettings::default(),
            picking_focus: false,
            focus: focus::AutoFocus::default(),
            samples: 0,
            display_settings: mutracer_native_probe::display::Settings::default(),
            selected,
            selected_mesh: None,
            tab: 0,
            scene_open: true,
            inspector_open: true,
            object_query: String::new(),
            loading: None,
            loading_name: String::new(),
            queued_load: None,
            running: true,
            change: if gpu.is_some() {
                Change::Scene
            } else {
                Change::None
            },
            last_commit_full: true,
            candidate: None,
            pixels: vec![],
            pixel_size: size,
            frame_samples: 0,
            frame_pending: false,
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
            checker: None,
            display_dirty: false,
            error: String::new(),
        })
    }
    fn describe_backend((active, reason): (u32, String)) -> String {
        match active {
            1 => format!("HWRT · {reason}"),
            _ if !reason.is_empty() => format!("Software BVH · {reason}"),
            _ => "Software BVH".into(),
        }
    }
    fn dirty(&mut self, change: Change) {
        if matches!(change, Change::Camera | Change::Transform | Change::Scene) {
            self.focus.request();
        }
        self.change = self.change.max(change);
        self.generation += 1;
    }
    fn load(&mut self, path: PathBuf, ctx: &egui::Context) {
        if self.loading.is_some() {
            self.queued_load = Some(path);
            return;
        }
        self.loading_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        self.error.clear();
        let (send, receive) = std::sync::mpsc::channel();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(|| Model::load(&path))
                .unwrap_or_else(|_| Err(anyhow::anyhow!("Invalid model data")));
            let _ = send.send(result);
            ctx.request_repaint();
        });
        self.loading = Some(receive);
    }
    fn receive_model(&mut self, ctx: &egui::Context) {
        let Some(result) = self.loading.as_ref().and_then(|r| r.try_recv().ok()) else {
            return;
        };
        self.loading = None;
        if let Some(next) = self.queued_load.take() {
            self.load(next, ctx);
            return;
        }
        match result {
            Ok(model) => {
                let mut camera = Camera::fit(model.center, model.radius);
                camera.fov = self.camera.fov;
                camera.orthographic = self.camera.orthographic;
                camera.f_stop = self.camera.f_stop;
                camera.meters_per_unit = self.camera.meters_per_unit;
                camera.frame(model.center, model.radius);
                if let Some(retired) = self.candidate.replace((model, camera)) {
                    std::thread::spawn(move || drop(retired));
                }
                self.running = true;
                self.dirty(Change::Scene);
            }
            Err(error) => self.error = format!("Could not open {}: {error:#}", self.loading_name),
        }
    }
    fn tick(&mut self, ctx: &egui::Context) -> Result<()> {
        if self.commit.is_some() {
            let completed = self.commit.as_ref().unwrap().0.try_recv();
            match completed {
                Ok(result) => {
                    let (_, generation, candidate, size) = self.commit.take().unwrap();
                    match result {
                        Ok(committed) => {
                            // Even a superseded snapshot is safe to reuse: the next
                            // submission patches all editable values from its model.
                            self.descriptor = Some(committed.descriptor);
                            // Read publication metadata before retiring another context:
                            // destruction also uses the native registry and can report busy.
                            let retired = committed
                                .replacement
                                .map(|renderer| std::mem::replace(&mut self.renderer, renderer));
                            self.renderer.commit_finished();
                            // Full preparations restart the held-input throttle.
                            self.last_commit_full = !self.renderer.last_commit_incremental()?;
                            if self.last_commit_full {
                                self.last_scene_commit = std::time::Instant::now();
                            }
                            if let Ok(backend) = self.renderer.backend() {
                                self.backend_status = Self::describe_backend(backend);
                            }
                            if generation == self.generation {
                                if let Some((model, camera)) = candidate {
                                    let retired = std::mem::replace(&mut self.model, model);
                                    std::thread::spawn(move || drop(retired));
                                    self.camera = camera;
                                    self.selected = self.model.meshes[0].material;
                                    self.selected_mesh = None;
                                    self.picking_focus = false;
                                    self.object_query.clear();
                                }
                                self.samples = 0;
                                self.render_generation = generation;
                                self.render_size = size;
                            } else {
                                // Preserve a loaded candidate until the newest snapshot commits.
                                let loaded = candidate.is_some();
                                if self.candidate.is_none() {
                                    self.candidate = candidate;
                                } else {
                                    std::thread::spawn(move || drop(candidate));
                                }
                                // Newer edits are already pending; a model needs a scene commit.
                                if loaded || self.change == Change::None {
                                    self.change = Change::Scene;
                                }
                            }
                            if let Some(retired) = retired {
                                std::thread::spawn(move || drop(retired));
                            }
                        }
                        Err(error) => {
                            self.change = Change::None;
                            return Err(error);
                        }
                    }
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {
                    if self.display_dirty {
                        if let Some(display) = &self.gpu_display {
                            display.compose_with(&self.display_settings);
                            self.display_dirty = false;
                        }
                    }
                    ctx.request_repaint_after(Duration::from_millis(16));
                    return Ok(());
                }
                Err(error) => {
                    self.commit = None;
                    return Err(error.into());
                }
            }
        }
        let focus_ready =
            self.loading.is_none() && self.candidate.is_none() && self.change != Change::Scene;
        if self.focus.update(
            &self.model,
            &mut self.camera,
            self.size[0] as f32 / self.size[1] as f32,
            focus_ready,
            ctx.input(|i| i.pointer.any_down()),
            std::time::Instant::now(),
            ctx,
        ) {
            // Lens pulls change the rendered camera, but must not request another measurement.
            self.change = self.change.max(Change::Camera);
            self.generation += 1;
        }
        if self.focus.working(&self.camera) {
            ctx.request_repaint_after(Duration::from_millis(16));
        }
        if self.change != Change::None || !self.running {
            self.renderer.cancel()?;
        }
        self.frame_pending |= self.renderer.poll()?;
        // Read the completed old frame before applying pending input. Keep it on
        // screen until a newer frame arrives, including while a slider is held.
        if self.frame_pending {
            self.samples = self.renderer.samples()?;
            if self.samples > 0 {
                let old_texture = self.gpu_display.as_ref().map(|d| d.texture.clone());
                if !self.renderer.capture(&mut self.gpu_display)? {
                    ctx.request_repaint_after(Duration::from_millis(16));
                    return Ok(());
                }
                if self.gpu.is_some() {
                    if old_texture.as_ref() != self.gpu_display.as_ref().map(|d| &d.texture) {
                        if let Some(id) = self.gpu_texture.take() {
                            self.gpu
                                .as_ref()
                                .unwrap()
                                .renderer
                                .write()
                                .free_texture(&id);
                        }
                    }
                    if self.gpu_texture.is_none() {
                        let display = self.gpu_display.as_ref().unwrap();
                        let gpu = self.gpu.as_ref().unwrap();
                        self.gpu_texture = Some(gpu.renderer.write().register_native_texture(
                            &gpu.device,
                            &display.texture.create_view(&Default::default()),
                            wgpu::FilterMode::Linear,
                        ));
                    }
                } else {
                    self.pixels = self.renderer.pixels()?;
                }
                self.pixel_size = self.render_size;
                self.frame_samples = self.samples;
                self.frame_generation = self.render_generation;
                self.denoised.clear();
                self.display_dirty = true;
            }
        }
        self.frame_pending = false;
        let held = ctx.input(|i| i.pointer.any_down());
        if !self.renderer.busy() {
            // Edits commit the whole descriptor. While the last commit applied
            // incrementally, edits commit on this thread like the frame they
            // belong to; scene changes and edits after a full preparation use
            // the worker and are throttled while input is held.
            let edit = self.change != Change::Scene && self.change != Change::Reset;
            let background = self.change == Change::Scene || (edit && self.last_commit_full);
            let deferred =
                background && held && self.last_scene_commit.elapsed() < Duration::from_millis(120);
            if !deferred {
                match self.change {
                    Change::Camera
                    | Change::Material
                    | Change::Environment
                    | Change::Light
                    | Change::Transform
                        if !background =>
                    {
                        self.renderer.commit_with_settings(
                            self.model.update_descriptor(
                                &mut self.descriptor,
                                &self.camera.bytes(self.size),
                                self.size,
                                &self.environment,
                                &self.light,
                            ),
                            &self.settings,
                        )?;
                        self.last_commit_full = !self.renderer.last_commit_incremental()?;
                        if self.last_commit_full {
                            self.last_scene_commit = std::time::Instant::now();
                        }
                    }
                    Change::Scene
                    | Change::Camera
                    | Change::Material
                    | Change::Environment
                    | Change::Light
                    | Change::Transform => {
                        let candidate = self.candidate.take();
                        let (model, camera) = candidate
                            .as_ref()
                            .map(|(m, c)| (m, c))
                            .unwrap_or((&self.model, &self.camera));
                        let receive = self.renderer.commit_worker(
                            self.backend,
                            model.clone(),
                            camera.clone(),
                            self.size,
                            self.settings,
                            self.environment.clone(),
                            self.light.clone(),
                            self.descriptor.take(),
                            ctx.clone(),
                        );
                        self.commit = Some((receive, self.generation, candidate, self.size));
                        if self.change == Change::Scene {
                            self.last_scene_commit = std::time::Instant::now();
                        }
                        self.samples = 0;
                        self.change = Change::None;
                        ctx.request_repaint_after(Duration::from_millis(16));
                        return Ok(());
                    }
                    Change::Reset => self.renderer.reset()?,
                    Change::None => {}
                }
                if self.change != Change::None {
                    self.samples = 0;
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
            && self.display_settings.output == 0
            && !held
            && !self.renderer.busy()
            && self.change == Change::None
            && self.frame_samples > 0
            && self.frame_generation == self.generation
            && (self.samples >= self.settings.max_samples
                || !self.running
                || self.samples >= 8 && self.samples.is_power_of_two())
            && self.last_denoise != Some((self.generation, self.samples))
        {
            let worker = self
                .denoiser
                .get_or_insert_with(|| denoise::Worker::new(ctx.clone()));
            if !worker.busy {
                if self.gpu.is_some() {
                    self.pixels = self.renderer.pixels()?;
                }
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
            && self.samples < self.settings.max_samples
        {
            // Dispatch now, before the next input can cancel a queued job.
            self.renderer
                .start((self.settings.max_samples - self.samples).min(if held { 1 } else { 4 }))?;
            self.frame_pending |= self.renderer.poll()?;
        }
        if self.display_dirty {
            if let Some(display) = &mut self.gpu_display {
                if self.denoise && !self.denoised.is_empty() && !display.using_denoised {
                    display
                        .upload(&self.denoised)
                        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
                } else if !self.denoise || self.denoised.is_empty() {
                    display.original();
                }
                display.compose_with(&self.display_settings);
                if self.gpu.is_none() {
                    let rgba = display
                        .read_rgba(&self.display_settings)
                        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
                    let image = egui::ColorImage::from_rgba_unmultiplied(
                        [self.pixel_size[0] as usize, self.pixel_size[1] as usize],
                        &rgba,
                    );
                    if let Some(texture) = &mut self.texture {
                        texture.set(image, egui::TextureOptions::LINEAR);
                    } else {
                        self.texture = Some(ctx.load_texture(
                            "MuTracer render",
                            image,
                            egui::TextureOptions::LINEAR,
                        ));
                    }
                }
                self.display_dirty = false;
            }
        }
        if self.renderer.busy()
            || self.running && self.samples < self.settings.max_samples
            || self.change != Change::None
        {
            ctx.request_repaint_after(Duration::from_millis(16));
        }
        Ok(())
    }
    fn save_image(&self, path: &Path) -> Result<()> {
        let display = self
            .gpu_display
            .as_ref()
            .context("No completed image to export")?;
        let rgba = display
            .read_rgba(&self.display_settings)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        image::save_buffer_with_format(
            path,
            &rgba,
            display.size[0],
            display.size[1],
            image::ColorType::Rgba8,
            image::ImageFormat::Png,
        )?;
        Ok(())
    }
    fn input_files(&mut self, ctx: &egui::Context) {
        let paths = ctx.input(|i| {
            i.raw
                .dropped_files
                .iter()
                .map(|f| f.path().to_owned())
                .collect::<Vec<_>>()
        });
        if paths.is_empty() {
            return;
        }
        if let Some(path) = paths.iter().find(|p| {
            p.extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("glb") || e.eq_ignore_ascii_case("gltf"))
        }) {
            self.load(path.clone(), ctx);
        } else {
            self.error="Drop a .gltf or .glb file. Keep external buffers and textures beside the .gltf file.".into();
        }
    }
}
impl eframe::App for Viewer {
    fn ui(&mut self, root: &mut egui::Ui, _frame: &mut eframe::Frame) {
        if let Some(gate) = &self.submission_gate {
            gate.resume();
        }
        let ctx = root.ctx().clone();
        let frame_started = std::time::Instant::now();
        let during_commit = self.commit.is_some();
        let mut pick_ms = 0.;
        if self.metrics.is_some() {
            self.denoise = false;
            self.settings.max_samples = 8;
            let m = self.metrics.as_mut().unwrap();
            if self.commit.is_none()
                && self.frame_samples > 0
                && m.commits < 3
                && m.frames.len() >= (m.commits as usize + 1) * 70
            {
                m.commits += 1;
                self.environment.color[0] = 1. - m.commits as f32 * 0.01;
                self.dirty(Change::Scene);
            } else if self.commit.is_none() && self.frame_samples > 0 && m.frames.len() % 3 == 0 {
                self.camera.yaw += 0.01;
                self.dirty(Change::Camera);
            }
            let started = std::time::Instant::now();
            let _ = self.model.pick(&self.camera, [0.5, 0.5], 1280. / 720.);
            pick_ms = started.elapsed().as_secs_f64() * 1000.;
        }
        self.receive_model(&ctx);
        self.input_files(&ctx);
        self.panels(root);
        if ctx.input(|i| !i.raw.hovered_files.is_empty()) {
            let painter = ctx.layer_painter(egui::LayerId::new(
                egui::Order::Foreground,
                egui::Id::new("drop_hint"),
            ));
            let rect = ctx.content_rect();
            painter.rect_filled(rect, 0., egui::Color32::from_black_alpha(200));
            painter.rect_stroke(
                rect.shrink(24.),
                12.,
                egui::Stroke::new(2_f32, theme::ACCENT),
                egui::StrokeKind::Inside,
            );
            painter.text(
                rect.center(),
                egui::Align2::CENTER_CENTER,
                "Drop a GLTF or GLB to open",
                egui::FontId::proportional(26.),
                egui::Color32::WHITE,
            );
        }
        if let Err(e) = self.tick(&ctx) {
            if renderer::NativeError::is_busy(&e) {
                ctx.request_repaint_after(Duration::from_millis(16));
            } else {
                self.error = format!("Render stopped: {e:#}");
                self.running = false;
                self.backend = self.renderer.mode;
                self.change = Change::None;
            }
        }

        // Input can arrive after tick, including the final event of a short drag.
        // Ensure camera changes are committed even when accumulation was idle.
        if self.change != Change::None {
            ctx.request_repaint();
        }
        if let Some(metrics) = &mut self.metrics {
            let done = metrics.record(
                frame_started.elapsed().as_secs_f64() * 1000.,
                during_commit || self.commit.is_some(),
                pick_ms,
                self.gpu_texture.is_some(),
                self.pixels.is_empty(),
                &self.error,
            );
            if done {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            } else {
                ctx.request_repaint_after(Duration::from_millis(16));
            }
        }
        if let Some((path, started, frames)) = &mut self.startup_smoke {
            // Exercise surface reconfiguration while scene preparation runs.
            match ctx.cumulative_frame_nr() {
                2 => {
                    ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(egui::vec2(800., 560.)))
                }
                4 => {
                    ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(egui::vec2(1200., 800.)))
                }
                _ => {}
            }
            if self.gpu_texture.is_some() && self.frame_samples > 0 {
                *frames += 1;
            }
            let passed = *frames >= 3 && self.error.is_empty();
            if passed || !self.error.is_empty() || started.elapsed() > Duration::from_secs(90) {
                let report = serde_json::json!({"passed":passed,"frames":frames,"samples":self.frame_samples,"error":self.error});
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(path, report.to_string());
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
            ctx.request_repaint_after(Duration::from_millis(16));
        }
        // eframe configures/reconfigures its surface outside this callback.
        // Drain only active submissions; CPU preparation stays asynchronous.
        if let Some(gate) = &self.submission_gate {
            gate.pause();
        }
    }
}
impl Drop for Viewer {
    fn drop(&mut self) {
        // Renderer teardown can wait for a pending background commit.
        if let Some(gate) = &self.submission_gate {
            gate.resume();
        }
    }
}
fn dropped_file(path: PathBuf) -> egui::DroppedFileHandle {
    #[derive(Debug)]
    struct File(PathBuf);
    impl egui::DroppedFile for File {
        fn path(&self) -> &Path {
            &self.0
        }
        fn bytes(&self) -> std::result::Result<Vec<u8>, String> {
            std::fs::read(&self.0).map_err(|e| e.to_string())
        }
    }
    std::sync::Arc::new(File(path))
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
    let mut renderer = Renderer::with_backend(0)?;
    renderer.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    let original = renderer.finish(16)?;
    renderer::save(&out.join("original.png"), &original, size, 0.)?;
    let normal = renderer.image(1)?;
    let albedo = renderer.image(2)?;
    let mut hardware = Renderer::with_backend(1)?;
    hardware.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    let hardware_pixels = hardware.finish(16)?;
    let (backend, reason) = hardware.backend()?;
    let mut max_diff = 0f32;
    for (a, b) in original.iter().zip(&hardware_pixels) {
        max_diff = max_diff.max((a - b).abs());
    }
    ensure!(backend == 1, "HWRT smoke silently fell back: {reason}");
    for kind in 0..3 {
        ensure!(
            hardware.image(kind)?.iter().all(|x| x.is_finite()),
            "Non-finite HWRT AOV"
        );
    }
    std::fs::write(
        out.join("hardware.txt"),
        format!("backend {backend}; {reason}; max HDR difference {max_diff}\n"),
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
    renderer.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    ensure!(
        renderer.last_commit_incremental()?,
        "Camera commit rebuilt the scene"
    );
    let orbit = renderer.finish(16)?;
    ensure!(original != orbit, "Camera control did not change pixels");
    renderer::save(&out.join("orbit.png"), &orbit, size, 0.)?;
    camera = Camera::fit(model.center, model.radius);
    renderer.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    ensure!(
        renderer.finish(16)? == original,
        "Restoring camera changed the original image"
    );
    // Imported mesh order does not imply visibility in the fitted camera. Edit
    // every material so this model-agnostic smoke always reaches visible surfaces.
    for material in &mut model.materials {
        material.color = [0.05, 0.85, 0.15];
        material.roughness = 0.8;
    }
    renderer.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    let material = renderer.finish(16)?;
    ensure!(material != original, "Material edit did not change pixels");
    renderer::save(&out.join("material.png"), &material, size, 0.)?;
    environment.intensity = 0.2;
    renderer.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
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
    renderer.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
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
    let mut output = ctx.run_ui(
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
    output.textures_delta.clear();
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
    viewer.settings.max_samples = 8;
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
    viewer.settings.max_samples = 12;
    while viewer.samples < 12 {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Extra samples timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    viewer.settings.max_samples = 8;
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
    viewer.denoise = false;
    let old = viewer.pixels.clone();
    let old_name = viewer.model.name.clone();
    let mut output = ctx.run_ui(
        egui::RawInput {
            dropped_files: vec![dropped_file(path.to_path_buf())],
            ..Default::default()
        },
        |ui| viewer.input_files(ui.ctx()),
    );
    output.textures_delta.clear();
    ensure!(
        viewer.loading.is_some() && viewer.pixels == old,
        "Drop did not retain preview while loading"
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while viewer.loading.is_some()
        || viewer.change != Change::None
        || viewer.frame_generation != viewer.generation
    {
        viewer.receive_model(&ctx);
        viewer.tick(&ctx)?;
        ensure!(
            viewer.error.is_empty() && std::time::Instant::now() < deadline,
            "Dropped model did not render: {}",
            viewer.error
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(
        viewer.model.name == old_name && !viewer.pixels.is_empty(),
        "Dropped model did not replace scene"
    );
    let mut output = ctx.run_ui(
        egui::RawInput {
            dropped_files: vec![dropped_file(PathBuf::from("texture.png"))],
            ..Default::default()
        },
        |ui| viewer.input_files(ui.ctx()),
    );
    output.textures_delta.clear();
    ensure!(
        !viewer.error.is_empty() && viewer.model.name == old_name,
        "Invalid drop was not rejected transactionally"
    );
    println!("PASS native file-drop event loads and renders; invalid drop preserves scene");
    viewer.error.clear();
    viewer.denoise = false;
    let id = viewer.model.meshes[0].material;
    let mut previews = 0;
    let mut previous = viewer.pixels.clone();
    let mut output = ctx.run_ui(
        egui::RawInput {
            events: vec![egui::Event::PointerButton {
                pos: egui::pos2(700., 400.),
                button: egui::PointerButton::Primary,
                pressed: true,
                modifiers: egui::Modifiers::NONE,
            }],
            ..Default::default()
        },
        |_| {},
    );
    output.textures_delta.clear();
    viewer.light.enabled = true;
    viewer.dirty(Change::Scene);
    while viewer.change != Change::None
        || viewer.renderer.busy()
        || viewer.samples < viewer.settings.max_samples
    {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Key light setup timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    let last_commit = viewer.last_scene_commit;
    let original_transform = viewer.model.meshes[0].transform;
    for step in 0..80 {
        viewer.model.meshes[0].transform =
            glam::Mat4::from_translation(glam::Vec3::new(step as f32 * 0.002, 0., 0.))
                * original_transform;
        viewer.model.refresh_bounds();
        viewer.dirty(Change::Transform);
        viewer.light.azimuth = step as f32 * 7.;
        viewer.light.intensity = 0.5 + step as f32 / 40.;
        viewer.dirty(Change::Light);
        viewer.environment.intensity = 0.3 + step as f32 * 0.02;
        viewer.environment.rotation = step as f32 * 9.;
        viewer.dirty(Change::Environment);
        viewer.model.materials[id].color = [0.1 + step as f32 / 100., 0.4, 0.7];
        viewer.model.materials[id].roughness = (step % 20) as f32 / 20.;
        viewer.dirty(Change::Material);
        if step % 5 == 0 {
            viewer.camera.orbit([1., 0.]);
            viewer.dirty(Change::Camera);
        }
        viewer.tick(&ctx)?;
        ensure!(
            viewer.texture.is_some() && !viewer.pixels.is_empty(),
            "Material interaction blanked preview"
        );
        if viewer.pixels != previous {
            previews += 1;
            previous = viewer.pixels.clone();
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut output = ctx.run_ui(
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
    output.textures_delta.clear();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while viewer.change != Change::None
        || viewer.renderer.busy()
        || viewer.samples < viewer.settings.max_samples
    {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Material interaction did not settle"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(
        previews >= 3,
        "Held environment/material edits starved previews"
    );
    ensure!(
        viewer.last_scene_commit == last_commit,
        "Partial edits rebuilt the scene"
    );
    let mut reference = Renderer::with_backend(viewer.backend)?;
    reference.commit(&viewer.model.descriptor_with_light(
        &viewer.camera.bytes(viewer.size),
        viewer.size,
        &viewer.environment,
        &viewer.light,
    ))?;
    ensure!(
        reference.finish(viewer.samples)? == viewer.pixels,
        "Combined transform/light/environment/material/camera updates differ from full commit"
    );
    renderer::save(
        &out.join("interactive-material.png"),
        &viewer.pixels,
        viewer.pixel_size,
        0.,
    )?;
    println!(
        "PASS 80 held transform/light/environment/material updates plus camera motion: {previews} changed previews, zero blanks, final HDR byte-exact to full commit"
    );
    viewer.model.materials[id].unlit = true;
    viewer.dirty(Change::Scene);
    while viewer.change != Change::None
        || viewer.renderer.busy()
        || viewer.samples < viewer.settings.max_samples
    {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Unlit setup timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    // The previous commit prepared the scene fully, so this edit commits on the
    // worker while the preview stays on screen.
    viewer.model.materials[id].color = [0.1, 0.7, 0.2];
    viewer.dirty(Change::Material);
    viewer.tick(&ctx)?;
    ensure!(
        viewer.commit.is_some() && viewer.texture.is_some(),
        "Edit after a full preparation did not commit in the background with retained preview"
    );
    while viewer.change != Change::None
        || viewer.renderer.busy()
        || viewer.samples < viewer.settings.max_samples
    {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Unlit fallback timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(
        viewer.last_commit_full,
        "Unlit material color edit did not prepare the scene fully"
    );
    reference.commit(&viewer.model.descriptor_with_light(
        &viewer.camera.bytes(viewer.size),
        viewer.size,
        &viewer.environment,
        &viewer.light,
    ))?;
    ensure!(
        reference.finish(viewer.samples)? == viewer.pixels,
        "Unlit full-commit fallback mismatch"
    );
    println!(
        "PASS unlit material edit prepares the scene fully on the worker; preview retained; final HDR byte-exact"
    );

    viewer.environment.background = !viewer.environment.background;
    viewer.dirty(Change::Environment);
    viewer.tick(&ctx)?;
    ensure!(
        viewer.commit.is_some() && viewer.texture.is_some(),
        "Environment feature change did not commit in the background with retained preview"
    );
    while viewer.change != Change::None
        || viewer.renderer.busy()
        || viewer.samples < viewer.settings.max_samples
    {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Environment fallback timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(
        viewer.last_commit_full,
        "Background visibility change did not prepare the scene fully"
    );
    reference.commit(&viewer.model.descriptor_with_light(
        &viewer.camera.bytes(viewer.size),
        viewer.size,
        &viewer.environment,
        &viewer.light,
    ))?;
    ensure!(
        reference.finish(viewer.samples)? == viewer.pixels,
        "Environment full-commit fallback mismatch"
    );
    println!(
        "PASS background visibility change prepares the scene fully; preview retained; HDR byte-exact"
    );

    Ok(())
}
fn material_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut descriptor = None;
    let mut model = Model::load(path)?;
    let camera = Camera::fit(model.center, model.radius);
    let environment = Environment::default();
    let size = [160, 106];
    let mut renderer = Renderer::with_backend(1)?;
    let mut reference = Renderer::with_backend(1)?;
    let initial = model.descriptor(&camera.bytes(size), size, &environment);
    renderer.commit(&initial)?;
    let baseline = renderer.finish(8)?;
    let id = model.meshes[0].material;
    let mut bad = model.clone();
    bad.materials[id].roughness = f32::NAN;
    ensure!(
        renderer
            .commit(bad.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &KeyLight::default()
            ))
            .is_err()
            && renderer.pixels()? == baseline,
        "Invalid material modified the scene"
    );
    renderer.start(1)?;
    renderer.cancel()?;
    while !renderer.poll()? {
        std::thread::sleep(Duration::from_millis(1));
    }
    ensure!(
        renderer.pixels()? == baseline,
        "Queued cancellation changed pixels"
    );
    let mut partial_ms = Vec::new();
    let mut full_ms = Vec::new();
    let used: std::collections::BTreeSet<_> = model.meshes.iter().map(|m| m.material).collect();
    let mut count = 0;
    for &id in used.iter().take(3) {
        if model.materials[id].unlit {
            continue;
        }
        for step in 0..6 {
            let m = &mut model.materials[id];
            m.color = [0.2 + step as f32 * 0.1, 0.35, 0.8];
            m.roughness = step as f32 / 5.;
            m.metalness = 1. - m.roughness;
            m.transmission = m.roughness * 0.6;
            m.ior = 1.1 + step as f32 * 0.15;
            let started = std::time::Instant::now();
            renderer.commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &KeyLight::default(),
            ))?;
            partial_ms.push(started.elapsed().as_secs_f64() * 1000.);
            ensure!(
                renderer.last_commit_incremental()?,
                "Expected an incremental material commit"
            );
            ensure!(
                renderer.samples()? == 0,
                "Material commit did not reset samples"
            );
            let actual = renderer.finish(8)?;
            let started = std::time::Instant::now();
            reference.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
            full_ms.push(started.elapsed().as_secs_f64() * 1000.);
            let expected = reference.finish(8)?;
            ensure!(
                actual == expected
                    && renderer.image(1)? == reference.image(1)?
                    && renderer.image(2)? == reference.image(2)?,
                "Partial material differed from full commit at {id}/{step}"
            );
            count += 1;
        }
    }
    ensure!(count > 0, "No supported material updates tested");
    renderer::save(&out.join("partial.png"), &renderer.pixels()?, size, 0.)?;
    renderer.commit(&initial)?;
    ensure!(
        renderer.finish(8)? == baseline,
        "Full commit after partial failed to restore"
    );
    std::fs::write(
        out.join("timings.txt"),
        format!("incremental commit ms {partial_ms:?}\nfull commit ms {full_ms:?}\n"),
    )?;
    println!(
        "PASS {count} incremental material commits: HDR/normal/albedo byte-exact to full commits; baseline restored"
    );
    material_layers_smoke(path, out)?;
    Ok(())
}
// New viewer controls exercise the existing raw-scene OpenPBR contract on both
// intersection paths. Fresh contexts are independent full-preparation oracles.
fn material_layers_smoke(path: &Path, out: &Path) -> Result<()> {
    use mutracer_native_probe::layout::{header as h, material as mat};
    let original = Model::load(path)?;
    let camera = Camera::fit(original.center, original.radius);
    let size = [160, 106];
    let environment = Environment::default();
    let initial = original.descriptor(&camera.bytes(size), size, &environment);
    // The first six records are precisely the pre-layer viewer's properties.
    let mut legacy = initial.clone();
    let word = |data: &[u8], at: usize| {
        u32::from_le_bytes(data[at * 4..at * 4 + 4].try_into().unwrap()) as usize
    };
    let offset = word(&legacy, h::MATERIAL_OFFSET);
    for i in 0..original.materials.len() {
        let at = (offset + i * mat::WORDS + mat::EXTENSION_COUNT) * 4;
        legacy[at..at + 4].copy_from_slice(&6u32.to_le_bytes());
    }
    for mode in [0, 1] {
        let mut retained = Renderer::with_backend(mode)?;
        retained.commit(&legacy)?;
        let baseline = retained.finish(8)?;
        let baseline_normal = retained.image(1)?;
        let baseline_albedo = retained.image(2)?;
        ensure!(
            retained.backend()?.0 == mode,
            "Layer gate requires requested backend {mode}"
        );
        retained.commit(&initial)?;
        ensure!(
            retained.finish(8)? == baseline
                && retained.image(1)? == baseline_normal
                && retained.image(2)? == baseline_albedo,
            "New layer defaults changed imported material output on backend {mode}"
        );
        let mut descriptor = None;
        let id = original.meshes[0].material;
        for case in 0..9 {
            for step in 0..2 {
                let mut model = original.clone();
                let m = &mut model.materials[id];
                let weight = 0.5 + step as f32 * 0.3;
                match case {
                    0 => {
                        m.transmission = weight;
                        m.layers.thin_walled = false;
                        m.layers.transmission_color = [0.3, 0.7, 0.9];
                        m.layers.transmission_depth = 0.2;
                        m.layers.dispersion = 0.1;
                    }
                    1 => {
                        m.layers.coat_weight = weight;
                        m.layers.coat_roughness = 0.12;
                        m.layers.coat_ior = 1.8;
                        m.layers.coat_color = [0.7, 0.9, 1.];
                    }
                    2 => {
                        m.layers.subsurface_weight = weight;
                        m.layers.subsurface_color = [0.9, 0.3, 0.1];
                        m.layers.subsurface_radius = 0.2;
                    }
                    3 => {
                        m.layers.fuzz_weight = weight;
                        m.layers.fuzz_color = [0.3, 0.6, 0.9];
                        m.layers.fuzz_roughness = 0.3;
                    }
                    4 => {
                        m.layers.film_weight = weight;
                        m.layers.film_thickness = 0.45;
                        m.layers.film_ior = 1.33;
                    }
                    5 => {
                        m.emission = [1., 0.3, 0.1];
                        m.emission_strength = weight * 4.;
                    }
                    6 => {
                        m.layers.anisotropy = weight;
                        m.layers.diffuse_roughness = 0.3;
                        m.layers.specular_weight = 0.6;
                        m.layers.bevel = 0.01;
                    }
                    7 => {
                        m.alpha_mode = 3;
                        m.opacity = weight;
                        m.normal_scale = 0.7;
                        m.double_sided = true;
                    }
                    _ => {
                        m.unlit = true;
                        m.color = [weight, 0.1, 0.3];
                    }
                }
                retained.commit(model.update_descriptor(
                    &mut descriptor,
                    &camera.bytes(size),
                    size,
                    &environment,
                    &KeyLight::default(),
                ))?;
                let actual = retained.finish(8)?;
                let mut fresh = Renderer::with_backend(mode)?;
                fresh.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
                ensure!(
                    !fresh.last_commit_incremental()?,
                    "Reference must prepare a fresh scene"
                );
                let expected = fresh.finish(8)?;
                ensure!(
                    actual.iter().all(|v| v.is_finite())
                        && actual == expected
                        && retained.image(1)? == fresh.image(1)?
                        && retained.image(2)? == fresh.image(2)?,
                    "Layer {case}/{step} differs from fresh preparation on backend {mode}"
                );
                ensure!(
                    actual != baseline,
                    "Layer {case}/{step} had no observable effect on backend {mode}"
                );
            }
        }
        let before = retained.pixels()?;
        let mut bad = original.clone();
        bad.materials[id].layers.coat_ior = f32::NAN;
        ensure!(
            retained
                .commit(&bad.descriptor(&camera.bytes(size), size, &environment))
                .is_err()
                && retained.pixels()? == before,
            "Invalid layer changed the accepted scene"
        );
        retained.commit(&initial)?;
        ensure!(
            retained.finish(8)? == baseline,
            "Layer edits failed to restore defaults on backend {mode}"
        );
        renderer::save(
            &out.join(format!("layers-{mode}-restored.png")),
            &baseline,
            size,
            0.,
        )?;
        println!(
            "PASS backend {mode}: defaults match legacy; 18 layer edits finite and HDR/normal/albedo exact to fresh contexts; effects, rejection and restoration checked"
        );
    }
    Ok(())
}
fn environment_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut descriptor = None;
    let model = Model::load(path)?;
    let camera = Camera::fit(model.center, model.radius);
    let mut environment = Environment::default();
    let size = [160, 106];
    let mut renderer = Renderer::with_backend(1)?;
    let mut reference = Renderer::with_backend(1)?;
    renderer.commit(model.update_descriptor(
        &mut descriptor,
        &camera.bytes(size),
        size,
        &environment,
        &KeyLight::default(),
    ))?;
    let original = renderer.finish(8)?;
    let mut bad = environment.clone();
    bad.intensity = f32::NAN;
    ensure!(
        renderer
            .commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &bad,
                &KeyLight::default()
            ))
            .is_err()
            && renderer.pixels()? == original,
        "Invalid environment changed scene"
    );
    renderer.start(1)?;
    renderer.cancel()?;
    while !renderer.poll()? {
        std::thread::sleep(Duration::from_millis(1));
    }
    for mode in 0..2 {
        if mode == 1 {
            // A map with different dimensions still commits incrementally.
            environment.image = Some(std::sync::Arc::new(image::Rgb32FImage::from_fn(
                16,
                8,
                |x, y| image::Rgb([0.1 + x as f32 * 0.2, 0.2 + y as f32 * 0.3, 0.5]),
            )));
            renderer.commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &KeyLight::default(),
            ))?;
            ensure!(
                renderer.last_commit_incremental()?,
                "Map resize rebuilt the scene"
            );
        }
        for step in 0..8 {
            environment.intensity = if step == 0 { 0. } else { step as f32 * 0.4 };
            environment.rotation = step as f32 * 57.;
            environment.color = [0.2 + step as f32 * 0.1, 0.8, 0.4];
            renderer.commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &KeyLight::default(),
            ))?;
            ensure!(
                renderer.last_commit_incremental()?,
                "Expected an incremental environment commit"
            );
            ensure!(
                renderer.samples()? == 0,
                "Environment update did not reset samples"
            );
            let actual = renderer.finish(8)?;
            reference.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
            ensure!(
                actual == reference.finish(8)?
                    && renderer.image(1)? == reference.image(1)?
                    && renderer.image(2)? == reference.image(2)?,
                "Partial environment differs from full commit at {mode}/{step}"
            );
        }
    }
    renderer::save(&out.join("partial.png"), &renderer.pixels()?, size, 0.)?;
    environment.background = false;
    renderer.commit(model.update_descriptor(
        &mut descriptor,
        &camera.bytes(size),
        size,
        &environment,
        &KeyLight::default(),
    ))?;
    ensure!(
        !renderer.last_commit_incremental()?,
        "Background visibility changes the shader and needs a full preparation"
    );
    environment = Environment::default();
    renderer.commit(model.update_descriptor(
        &mut descriptor,
        &camera.bytes(size),
        size,
        &environment,
        &KeyLight::default(),
    ))?;
    ensure!(
        renderer.finish(8)? == original,
        "Environment baseline restore differs"
    );
    println!(
        "PASS 17 incremental studio/HDR environment commits including a map resize: HDR/normal/albedo byte-exact to full commits; invalid input rejected; visibility change prepared fully; original restored"
    );
    Ok(())
}
fn light_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut descriptor = None;
    let model = Model::load(path)?;
    let camera = Camera::fit(model.center, model.radius);
    let mut environment = Environment::default();
    let mut light = KeyLight {
        enabled: true,
        ..Default::default()
    };
    let size = [160, 106];
    let mut renderer = Renderer::with_backend(1)?;
    let mut reference = Renderer::with_backend(1)?;
    renderer.commit(model.update_descriptor(
        &mut descriptor,
        &camera.bytes(size),
        size,
        &environment,
        &light,
    ))?;
    let before = renderer.finish(8)?;
    let mut bad = light.clone();
    bad.intensity = f32::NAN;
    ensure!(
        renderer
            .commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &bad
            ))
            .is_err()
            && renderer.pixels()? == before,
        "Invalid light modified scene"
    );
    renderer.start(1)?;
    renderer.cancel()?;
    while !renderer.poll()? {
        std::thread::sleep(Duration::from_millis(1));
    }
    for step in 0..18 {
        if step == 9 {
            // Hiding the background changes the shader: a full preparation.
            environment.background = false;
            renderer.commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &light,
            ))?;
            ensure!(
                !renderer.last_commit_incremental()?,
                "Background visibility commit stayed incremental"
            );
        }
        environment.intensity = 0.3 + step as f32 * 0.1;
        environment.rotation = step as f32 * 31.;
        light.intensity = if step % 6 == 0 {
            0.
        } else {
            0.5 + step as f32 * 0.4
        };
        light.color = [0.2 + step as f32 * 0.03, 0.8, 0.4];
        light.azimuth = step as f32 * 21.;
        light.elevation = 10. + (step % 8) as f32 * 9.;
        renderer.commit(model.update_descriptor(
            &mut descriptor,
            &camera.bytes(size),
            size,
            &environment,
            &light,
        ))?;
        ensure!(
            renderer.last_commit_incremental()?,
            "Expected an incremental light/environment commit"
        );
        ensure!(
            renderer.samples()? == 0,
            "Light commit did not reset samples"
        );
        let actual = renderer.finish(8)?;
        reference.commit(&model.descriptor_with_light(
            &camera.bytes(size),
            size,
            &environment,
            &light,
        ))?;
        ensure!(
            actual == reference.finish(8)?
                && renderer.image(1)? == reference.image(1)?
                && renderer.image(2)? == reference.image(2)?,
            "Incremental light/environment differed from full commit at {step}"
        );
    }
    let before = renderer.pixels()?;
    renderer::save(&out.join("partial.png"), &before, size, 0.)?;
    light.enabled = false;
    renderer.commit(model.update_descriptor(
        &mut descriptor,
        &camera.bytes(size),
        size,
        &environment,
        &light,
    ))?;
    ensure!(
        renderer.last_commit_incremental()?,
        "Removing the key light rebuilt the scene"
    );
    ensure!(
        renderer.finish(8)? != before,
        "Removing key light had no effect"
    );
    println!(
        "PASS 18 incremental key-light and environment commits: HDR/normal/albedo byte-exact; invalid input rejected; light removal incremental"
    );
    Ok(())
}
fn transform_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut descriptor = None;
    let mut model = Model::load(path)?;
    let camera = Camera::fit(model.center, model.radius);
    let mut environment = Environment::default();
    let size = [160, 104];
    let originals: Vec<_> = model.meshes.iter().map(|m| m.transform).collect();
    let mut partial = 0;
    let mut fallback = 0;
    for mode in [0, 1] {
        let mut renderer = Renderer::with_backend(mode)?;
        let mut reference = Renderer::with_backend(mode)?;
        renderer.commit(model.update_descriptor(
            &mut descriptor,
            &camera.bytes(size),
            size,
            &environment,
            &KeyLight::default(),
        ))?;
        renderer.finish(8)?;
        for (id, original) in originals.iter().enumerate().take(3) {
            for step in 0..8 {
                let scale = if step == 6 {
                    glam::Vec3::new(1.2, 0.8, 1.1)
                } else if step == 7 {
                    glam::Vec3::new(-1., 1., 1.)
                } else {
                    glam::Vec3::splat(1. + step as f32 * 0.03)
                };
                model.meshes[id].transform = glam::Mat4::from_translation(glam::Vec3::new(
                    step as f32 * model.radius * 0.025,
                    0.,
                    0.,
                )) * *original
                    * glam::Mat4::from_rotation_y(step as f32 * 0.15)
                    * glam::Mat4::from_scale(scale);
                let before = renderer.pixels()?;
                let mut invalid = model.clone();
                invalid.meshes[id].transform.x_axis.x = f32::NAN;
                ensure!(
                    renderer
                        .commit(invalid.update_descriptor(
                            &mut descriptor,
                            &camera.bytes(size),
                            size,
                            &environment,
                            &KeyLight::default()
                        ))
                        .is_err()
                        && renderer.pixels()? == before,
                    "Invalid transform mutated scene"
                );
                renderer.commit(model.update_descriptor(
                    &mut descriptor,
                    &camera.bytes(size),
                    size,
                    &environment,
                    &KeyLight::default(),
                ))?;
                if renderer.last_commit_incremental()? {
                    partial += 1;
                } else {
                    fallback += 1;
                }
                ensure!(renderer.samples()? == 0, "Transform did not reset samples");
                let actual = renderer.finish(8)?;
                reference.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
                ensure!(
                    actual == reference.finish(8)?
                        && renderer.image(1)? == reference.image(1)?
                        && renderer.image(2)? == reference.image(2)?,
                    "Transform full/partial mismatch {mode}/{id}/{step}"
                );
                // Accepted transform lighting must survive subsequent environment edits.
                environment.intensity = 0.5 + step as f32 * 0.2;
                renderer.commit(model.update_descriptor(
                    &mut descriptor,
                    &camera.bytes(size),
                    size,
                    &environment,
                    &KeyLight::default(),
                ))?;
                let actual = renderer.finish(8)?;
                reference.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
                ensure!(
                    actual == reference.finish(8)?
                        && renderer.image(1)? == reference.image(1)?
                        && renderer.image(2)? == reference.image(2)?,
                    "Environment after transform mismatch"
                );
                ensure!(renderer.backend()?.0 == mode, "Unexpected backend fallback");
            }
        }
        renderer::save(
            &out.join(format!("mode-{mode}.png")),
            &renderer.pixels()?,
            size,
            0.,
        )?;
        for (mesh, original) in model.meshes.iter_mut().zip(&originals) {
            mesh.transform = *original;
        }
    }
    ensure!(partial > 0, "No incremental transform commits executed");
    println!(
        "PASS {partial} incremental transform commits, {fallback} full commits; software/auto HDR/normal/albedo exact; interleaved environment and invalid-update preservation"
    );
    Ok(())
}
fn main() -> Result<()> {
    let mut model = None;
    let mut smoke_out = None;
    let mut interaction_out = None;
    let mut inspect = false;
    let mut preview_out = None;
    let mut material_out = None;
    let mut edit_bench_out = None;
    let mut environment_out = None;
    let mut light_out = None;
    let mut transform_out = None;
    let mut geometry_out = None;
    let mut package_out = None;
    let mut parity_out = None;
    let mut studio_out = None;
    let mut focus_out = None;
    let mut startup_out = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--focus-smoke" => {
                focus_out = Some(PathBuf::from(
                    args.next().context("--focus-smoke needs a directory")?,
                ));
            }
            "--studio-smoke" => {
                studio_out = Some(PathBuf::from(
                    args.next().context("--studio-smoke needs a directory")?,
                ));
            }
            "--parity-smoke" => {
                parity_out = Some(PathBuf::from(
                    args.next().context("--parity-smoke needs a directory")?,
                ));
            }
            "--startup-smoke" => {
                startup_out = Some(PathBuf::from(
                    args.next().context("--startup-smoke needs a report path")?,
                ));
            }
            "--edit-bench" => {
                edit_bench_out = Some(PathBuf::from(
                    args.next().context("--edit-bench needs a directory")?,
                ));
            }
            "--package-smoke" => {
                package_out = Some(PathBuf::from(
                    args.next().context("--package-smoke needs a directory")?,
                ));
            }
            "--geometry-smoke" => {
                geometry_out = Some(PathBuf::from(
                    args.next().context("--geometry-smoke needs a directory")?,
                ));
            }
            "--transform-smoke" => {
                transform_out = Some(PathBuf::from(
                    args.next().context("--transform-smoke needs a directory")?,
                ));
            }
            "--light-smoke" => {
                light_out = Some(PathBuf::from(
                    args.next().context("--light-smoke needs a directory")?,
                ))
            }
            "--environment-smoke" => {
                environment_out = Some(PathBuf::from(
                    args.next()
                        .context("--environment-smoke needs a directory")?,
                ))
            }
            "--material-smoke" => {
                material_out = Some(PathBuf::from(
                    args.next().context("--material-smoke needs a directory")?,
                ))
            }
            "--inspect" => inspect = true,
            "--preview-out" => {
                preview_out = Some(PathBuf::from(
                    args.next().context("--preview-out needs a directory")?,
                ))
            }
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
    if let Some(out) = focus_out {
        return focus_smoke::run(&model, &out);
    }
    if let Some(out) = studio_out {
        return studio_smoke::run(&model, &out);
    }
    if let Some(out) = parity_out {
        return parity_smoke::run(&model, &out);
    }
    if let Some(out) = package_out {
        return package_smoke::run(&model, &out);
    }
    if let Some(out) = geometry_out {
        return geometry_smoke::run(&model, &out);
    }
    if let Some(out) = transform_out {
        return transform_smoke(&model, &out);
    }
    if let Some(out) = light_out {
        return light_smoke(&model, &out);
    }
    if let Some(out) = environment_out {
        return environment_smoke(&model, &out);
    }
    if let Some(out) = edit_bench_out {
        return edit_bench::run(&model, &out);
    }
    if let Some(out) = material_out {
        return material_smoke(&model, &out);
    }
    if inspect || preview_out.is_some() {
        let m = Model::load(&model)?;
        println!(
            "{} meshes, {} geometries, {} triangles, {} textures; {}",
            m.meshes.len(),
            m.geometries.len(),
            m.geometries
                .iter()
                .map(|g| g.indices.len() / 3)
                .sum::<usize>(),
            m.textures.len(),
            m.warnings.join("; ")
        );
        let mut r = Renderer::with_backend(1)?;
        let c = Camera::fit(m.center, m.radius);
        r.commit(&m.descriptor(&c.bytes([160, 106]), [160, 106], &Environment::default()))?;
        let pixels = r.finish(16)?;
        if let Some(out) = preview_out {
            std::fs::create_dir_all(&out)?;
            renderer::save(&out.join("preview.png"), &pixels, [160, 106], 0.)?;
        }
        println!("PASS render {} pixels {:?}", pixels.len() / 4, r.backend()?);
        return Ok(());
    }
    if let Some(out) = interaction_out {
        return interaction_smoke(&model, &out);
    }
    if let Some(out) = smoke_out {
        return smoke(&model, &out);
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_drag_and_drop(true)
            .with_inner_size([1200., 800.])
            .with_min_inner_size([800., 560.]),
        renderer: eframe::Renderer::Wgpu,
        wgpu_options: eframe::egui_wgpu::WgpuConfiguration {
            wgpu_setup: eframe::egui_wgpu::WgpuSetup::CreateNew(
                eframe::egui_wgpu::WgpuSetupCreateNew {
                    device_descriptor: std::sync::Arc::new(|adapter| wgpu::DeviceDescriptor {
                        label: Some("MuTracer and egui"),
                        required_limits: adapter.limits(),
                        required_features: adapter.features()
                            & wgpu::Features::EXPERIMENTAL_RAY_QUERY,
                        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
                        ..Default::default()
                    }),
                    ..eframe::egui_wgpu::WgpuSetupCreateNew::without_display_handle()
                },
            ),
            ..Default::default()
        },
        ..Default::default()
    };
    let startup_report = startup_out.clone();
    eframe::run_native(
        "MuTracer Native Viewer",
        options,
        Box::new(move |cc| {
            theme::install(&cc.egui_ctx);
            let mut viewer = Viewer::new_on_device(&model, cc.wgpu_render_state.clone())?;
            if let Some(path) = startup_out {
                viewer.size = [64, 48];
                viewer.settings.max_samples = 1;
                viewer.backend = 0;
                viewer.denoise = false;
                viewer.startup_smoke = Some((path, std::time::Instant::now(), 0));
            }
            Ok(Box::new(viewer))
        }),
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    if let Some(path) = startup_report {
        let report: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
        ensure!(
            report["passed"] == true,
            "Window startup smoke failed: {report}"
        );
    }
    Ok(())
}
