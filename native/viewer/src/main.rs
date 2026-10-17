//! Small native example: glTF input → native MuTracer library → egui image.
mod denoise;
mod geometry_smoke;
mod import;
mod input;
mod picking;
mod renderer;
mod scene;
use anyhow::{Context, Result, ensure};
use eframe::egui;
use renderer::{Camera, Renderer};
use scene::{Environment, KeyLight, Model};
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
    renderer: Renderer,
    backend: u32,
    backend_status: String,
    model: Model,
    camera: Camera,
    drag: input::ViewportDrag,
    environment: Environment,
    light: KeyLight,
    size: [u32; 2],
    target: u32,
    samples: u32,
    exposure: f32,
    selected: usize,
    selected_mesh: Option<usize>,
    tab: usize,
    loading: Option<std::sync::mpsc::Receiver<Result<Model>>>,
    loading_name: String,
    queued_load: Option<PathBuf>,
    running: bool,
    change: Change,
    pending_materials: std::collections::BTreeSet<usize>,
    pending_camera: bool,
    pending_environment: bool,
    pending_light: bool,
    pending_transforms: std::collections::BTreeSet<usize>,
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
        let mut renderer = Renderer::new()?;
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
            light: KeyLight::default(),
            size,
            target: 64,
            samples: 0,
            exposure: 0.,
            selected,
            selected_mesh: None,
            tab: 0,
            loading: None,
            loading_name: String::new(),
            queued_load: None,
            running: true,
            change: Change::None,
            pending_materials: Default::default(),
            pending_camera: false,
            pending_environment: false,
            pending_light: false,
            pending_transforms: Default::default(),
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
            1 => format!("HWRT · {reason}"),
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
        if change == Change::Camera {
            self.pending_camera = true;
        }
        if change == Change::Environment {
            self.pending_environment = true;
        }
        if change == Change::Light {
            self.pending_light = true;
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
                let camera = Camera::fit(model.center, model.radius);
                self.candidate = Some((model, camera));
                self.running = true;
                self.dirty(Change::Scene);
            }
            Err(error) => self.error = format!("Could not open {}: {error:#}", self.loading_name),
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
                            self.commit_scene(&model.descriptor_with_light(
                                &camera.bytes(),
                                self.size,
                                &self.environment,
                                &self.light,
                            ))?;
                            self.model = model;
                            self.camera = camera;
                            self.selected = self.model.meshes[0].material;
                            self.selected_mesh = None;
                        } else {
                            self.commit_scene(&self.model.descriptor_with_light(
                                &self.camera.bytes(),
                                self.size,
                                &self.environment,
                                &self.light,
                            ))?;
                        }
                    }
                    Change::Material | Change::Environment | Change::Light | Change::Transform => {
                        for &id in &self.pending_materials {
                            if !self
                                .renderer
                                .material(&self.model.materials[id].update_bytes(id))?
                            {
                                // Apply the existing held-input rebuild throttle next tick.
                                self.change = Change::Scene;
                                return Ok(());
                            }
                        }
                        if self.pending_environment
                            && !self
                                .renderer
                                .environment(&self.environment.update_bytes())?
                        {
                            self.change = Change::Scene;
                            return Ok(());
                        }
                        if self.pending_light && !self.renderer.light(&self.light.update_bytes())? {
                            self.change = Change::Scene;
                            return Ok(());
                        }
                        for &id in &self.pending_transforms {
                            if !self
                                .renderer
                                .transform(&self.model.meshes[id].update_bytes(id))?
                            {
                                self.change = Change::Scene;
                                return Ok(());
                            }
                        }
                        if self.pending_camera {
                            self.renderer.camera(&self.camera.bytes())?;
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
                    self.pending_materials.clear();
                    self.pending_transforms.clear();
                    self.pending_camera = false;
                    self.pending_environment = false;
                    self.pending_light = false;
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
    fn input_files(&mut self, ctx: &egui::Context) {
        let paths = ctx.input(|i| {
            i.raw
                .dropped_files
                .iter()
                .filter_map(|f| f.path.clone())
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
                        self.load(path, ctx);
                    }
                }
                ui.label(
                    egui::RichText::new(&self.model.name)
                        .color(egui::Color32::from_rgb(190, 196, 208)),
                );
                if ui.small_button("Sample").clicked() {
                    self.load(default_model(), ctx);
                }
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
        egui::SidePanel::right("settings")
            .resizable(true)
            .default_width(300.)
            .min_width(270.)
            .max_width(420.)
            .show(ctx, |ui| {
                egui::ScrollArea::vertical().show(ui, |ui| {
                    ui.add_space(10.);
                    ui.horizontal(|ui| {
                        for (tab, name) in
                            [(0, "Render"), (1, "Material"), (2, "Light"), (3, "Scene")]
                        {
                            ui.selectable_value(&mut self.tab, tab, name);
                        }
                    });
                    ui.add_space(12.);
                    if self.tab == 0 {
                        ui.heading("Render");
                        ui.add(
                            egui::ProgressBar::new(self.samples as f32 / self.target.max(1) as f32)
                                .show_percentage(),
                        );
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
                            .selected_text(["Software", "HWRT"][self.backend as usize])
                            .show_ui(ui, |ui| {
                                for (mode, name) in [(1, "HWRT"), (0, "Software")] {
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
                        ui.small(
                            "Drag to orbit · Shift/right drag to pan\nScroll to zoom · F to fit",
                        );
                        ui.add_space(14.);
                    }
                    if self.tab == 1 {
                        ui.heading("Material");
                        ui.small("Click a surface in the image to select its material.");
                        if let Some(id) = self.selected_mesh {
                            ui.label(
                                egui::RichText::new(&self.model.meshes[id].name)
                                    .color(egui::Color32::from_rgb(126, 190, 255)),
                            );
                            if ui.small_button("Frame selection").clicked() {
                                let (min, max) = self.model.mesh_bounds(id);
                                self.camera =
                                    Camera::fit((min + max) * 0.5, (max - min).length() * 0.5);
                                self.dirty(Change::Camera);
                            }
                        }
                        let previous_material = self.selected;
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
                        if previous_material != self.selected {
                            self.selected_mesh = None;
                        }
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
                            .add(
                                egui::Slider::new(&mut m.transmission, 0.0..=1.0)
                                    .text("Transmission"),
                            )
                            .changed();
                        if changed {
                            self.pending_materials.insert(self.selected);
                            self.dirty(Change::Material);
                        }
                        ui.add_space(14.);
                    }
                    if self.tab == 2 {
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
                                            self.error =
                                                format!("Could not load environment: {e:#}")
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
                            self.dirty(Change::Environment);
                        }
                        ui.add_space(14.);
                        ui.heading("Key light");
                        if ui
                            .checkbox(&mut self.light.enabled, "Enable directional light")
                            .changed()
                        {
                            self.dirty(Change::Scene);
                        }
                        let mut light_changed = false;
                        ui.add_enabled_ui(self.light.enabled, |ui| {
                            light_changed |= ui
                                .add(
                                    egui::Slider::new(&mut self.light.intensity, 0.0..=10.0)
                                        .text("Intensity"),
                                )
                                .changed();
                            ui.horizontal(|ui| {
                                ui.label("Color");
                                light_changed |=
                                    ui.color_edit_button_rgb(&mut self.light.color).changed();
                            });
                            light_changed |= ui
                                .add(
                                    egui::Slider::new(&mut self.light.azimuth, 0.0..=360.0)
                                        .text("Azimuth"),
                                )
                                .changed();
                            light_changed |= ui
                                .add(
                                    egui::Slider::new(&mut self.light.elevation, 5.0..=85.0)
                                        .text("Elevation"),
                                )
                                .changed();
                        });
                        if light_changed {
                            self.dirty(Change::Light);
                        }
                        ui.add_space(14.);
                    }
                    if self.tab == 3 {
                        ui.heading("Scene");
                        ui.small(format!(
                            "{} meshes · {} triangles",
                            self.model.meshes.len(),
                            self.model
                                .geometries
                                .iter()
                                .map(|g| g.indices.len() / 3)
                                .sum::<usize>()
                        ));
                        egui::ScrollArea::vertical()
                            .id_salt("objects")
                            .max_height(280.)
                            .show(ui, |ui| {
                                for (id, mesh) in self.model.meshes.iter().enumerate() {
                                    if ui
                                        .selectable_label(
                                            self.selected_mesh == Some(id),
                                            &mesh.name,
                                        )
                                        .clicked()
                                    {
                                        self.selected_mesh = Some(id);
                                        self.selected = mesh.material;
                                    }
                                }
                            });
                        ui.separator();
                        if let Some(id) = self.selected_mesh {
                            ui.label("Object transform");
                            let mesh = &mut self.model.meshes[id];
                            let mut position = mesh.transform.w_axis.truncate();
                            let mut changed = false;
                            ui.horizontal(|ui| {
                                for (label, value) in [
                                    ("X", &mut position.x),
                                    ("Y", &mut position.y),
                                    ("Z", &mut position.z),
                                ] {
                                    changed |= ui
                                        .add(
                                            egui::DragValue::new(value)
                                                .prefix(format!("{label} "))
                                                .speed(self.model.radius as f64 * 0.005)
                                                .range(-1e6..=1e6),
                                        )
                                        .changed();
                                }
                            });
                            if changed {
                                mesh.transform.w_axis = position.extend(1.);
                            }
                            ui.horizontal(|ui| {
                                if ui.small_button("Rotate Y −15°").clicked() {
                                    mesh.transform *=
                                        glam::Mat4::from_rotation_y(-15f32.to_radians());
                                    changed = true;
                                }
                                if ui.small_button("Rotate Y +15°").clicked() {
                                    mesh.transform *=
                                        glam::Mat4::from_rotation_y(15f32.to_radians());
                                    changed = true;
                                }
                            });
                            ui.horizontal(|ui| {
                                for (label, scale) in [("Smaller", 1. / 1.1), ("Larger", 1.1)] {
                                    if ui.small_button(label).clicked() {
                                        let candidate = mesh.transform
                                            * glam::Mat4::from_scale(glam::Vec3::splat(scale));
                                        let determinant = candidate.determinant();
                                        if candidate.is_finite()
                                            && determinant.is_finite()
                                            && determinant.abs() >= 1e-10
                                            && determinant.abs() <= 1e12
                                        {
                                            mesh.transform = candidate;
                                            changed = true;
                                        }
                                    }
                                }
                            });
                            if changed {
                                self.model.refresh_bounds();
                                self.pending_transforms.insert(id);
                                self.dirty(Change::Transform);
                            }
                            ui.separator();
                        }
                        for warning in &self.model.warnings {
                            ui.colored_label(egui::Color32::YELLOW, warning);
                        }
                    }
                });
            });
        egui::TopBottomPanel::bottom("status").show(ctx, |ui| {
            ui.horizontal(|ui| {
                if self.loading.is_some() {
                    ui.spinner();
                    ui.label(format!("Opening {}…", self.loading_name));
                    ctx.request_repaint_after(Duration::from_millis(50));
                } else {
                    ui.label(if !self.running {
                        "Paused"
                    } else if self.samples >= self.target {
                        "Complete"
                    } else {
                        "Rendering"
                    });
                    ui.separator();
                    ui.small(format!("{} / {} samples", self.samples, self.target));
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.small(
                        "Click: select   ·   Drag: orbit   ·   Shift-drag: pan   ·   Scroll: zoom",
                    );
                });
            });
        });
        if !self.error.is_empty() {
            egui::Window::new("Unable to complete action").collapsible(false).resizable(true).default_width(480.).show(ctx,|ui|{
                ui.colored_label(egui::Color32::LIGHT_RED,&self.error);
                ui.small("The previous image is kept. You can open another model or change settings.");
                if ui.button("Dismiss").clicked(){self.error.clear();}
            });
        }
        egui::CentralPanel::default()
            .frame(
                egui::Frame::central_panel(&ctx.style()).fill(egui::Color32::from_rgb(18, 20, 24)),
            )
            .show(ctx, |ui| {
                let available = ui.available_size();
                let aspect = self.pixel_size[0] as f32 / self.pixel_size[1] as f32;
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
                if let Some(pos) = self.drag.take_click().filter(|p| rect.contains(*p)) {
                    let uv = [
                        (pos.x - rect.min.x) / rect.width(),
                        (pos.y - rect.min.y) / rect.height(),
                    ];
                    self.selected_mesh = self.model.pick(&self.camera, uv, aspect);
                    if let Some(id) = self.selected_mesh {
                        self.selected = self.model.meshes[id].material;
                        self.tab = 1;
                    }
                }
                if let Some(id) = self.selected_mesh {
                    ui.painter().text(
                        rect.left_top() + egui::vec2(14., 14.),
                        egui::Align2::LEFT_TOP,
                        &self.model.meshes[id].name,
                        egui::FontId::proportional(14.),
                        egui::Color32::from_rgb(126, 190, 255),
                    );
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
        self.receive_model(ctx);
        self.input_files(ctx);
        self.panels(ctx);
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
                egui::Stroke::new(2_f32, egui::Color32::from_rgb(126, 190, 255)),
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
        if let Err(e) = self.tick(ctx) {
            self.error = format!("Render stopped: {e:#}");
            self.running = false;
            self.backend = self.renderer.mode;
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
    let mut renderer = Renderer::with_backend(0)?;
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
    // Imported mesh order does not imply visibility in the fitted camera. Edit
    // every material so this model-agnostic smoke always reaches visible surfaces.
    for material in &mut model.materials {
        material.color = [0.05, 0.85, 0.15];
        material.roughness = 0.8;
    }
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
    viewer.denoise = false;
    let old = viewer.pixels.clone();
    let old_name = viewer.model.name.clone();
    let _ = ctx.run(
        egui::RawInput {
            dropped_files: vec![egui::DroppedFile {
                path: Some(path.to_path_buf()),
                ..Default::default()
            }],
            ..Default::default()
        },
        |ctx| viewer.input_files(ctx),
    );
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
    let _ = ctx.run(
        egui::RawInput {
            dropped_files: vec![egui::DroppedFile {
                path: Some(PathBuf::from("texture.png")),
                ..Default::default()
            }],
            ..Default::default()
        },
        |ctx| viewer.input_files(ctx),
    );
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
    let _ = ctx.run(
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
    viewer.light.enabled = true;
    viewer.dirty(Change::Scene);
    while viewer.change != Change::None || viewer.renderer.busy() || viewer.samples < viewer.target
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
        viewer.pending_transforms.insert(0);
        viewer.dirty(Change::Transform);
        viewer.light.azimuth = step as f32 * 7.;
        viewer.light.intensity = 0.5 + step as f32 / 40.;
        viewer.dirty(Change::Light);
        viewer.environment.intensity = 0.3 + step as f32 * 0.02;
        viewer.environment.rotation = step as f32 * 9.;
        viewer.dirty(Change::Environment);
        viewer.model.materials[id].color = [0.1 + step as f32 / 100., 0.4, 0.7];
        viewer.model.materials[id].roughness = (step % 20) as f32 / 20.;
        viewer.pending_materials.insert(id);
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
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while viewer.change != Change::None || viewer.renderer.busy() || viewer.samples < viewer.target
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
        &viewer.camera.bytes(),
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
    while viewer.change != Change::None || viewer.renderer.busy() || viewer.samples < viewer.target
    {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Unlit setup timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    viewer.model.materials[id].color = [0.1, 0.7, 0.2];
    viewer.pending_materials.insert(id);
    viewer.dirty(Change::Material);
    viewer.tick(&ctx)?;
    ensure!(
        viewer.change == Change::Scene && viewer.texture.is_some(),
        "Unsupported material did not schedule a full rebuild with retained preview"
    );
    while viewer.change != Change::None || viewer.renderer.busy() || viewer.samples < viewer.target
    {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Unlit fallback timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    reference.commit(&viewer.model.descriptor_with_light(
        &viewer.camera.bytes(),
        viewer.size,
        &viewer.environment,
        &viewer.light,
    ))?;
    ensure!(
        reference.finish(viewer.samples)? == viewer.pixels,
        "Unlit full-commit fallback mismatch"
    );
    println!(
        "PASS unsupported material update falls back to full commit; preview retained; final HDR byte-exact"
    );

    viewer.environment.background = !viewer.environment.background;
    viewer.dirty(Change::Environment);
    viewer.tick(&ctx)?;
    ensure!(
        viewer.change == Change::Scene && viewer.texture.is_some(),
        "Environment feature change did not retain preview and schedule full commit"
    );
    while viewer.change != Change::None || viewer.renderer.busy() || viewer.samples < viewer.target
    {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Environment fallback timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    reference.commit(&viewer.model.descriptor_with_light(
        &viewer.camera.bytes(),
        viewer.size,
        &viewer.environment,
        &viewer.light,
    ))?;
    ensure!(
        reference.finish(viewer.samples)? == viewer.pixels,
        "Environment full-commit fallback mismatch"
    );
    println!(
        "PASS environment feature change falls back to full commit; preview retained; HDR byte-exact"
    );

    Ok(())
}
fn material_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut model = Model::load(path)?;
    let camera = Camera::fit(model.center, model.radius);
    let environment = Environment::default();
    let size = [160, 106];
    let mut renderer = Renderer::with_backend(1)?;
    let mut reference = Renderer::with_backend(1)?;
    let initial = model.descriptor(&camera.bytes(), size, &environment);
    renderer.commit(&initial)?;
    let baseline = renderer.finish(8)?;
    let id = model.meshes[0].material;
    let mut bad = model.materials[id].update_bytes(id);
    bad[16..20].copy_from_slice(&f32::NAN.to_le_bytes());
    ensure!(
        renderer.material(&bad).is_err() && renderer.pixels()? == baseline,
        "Invalid material modified the scene"
    );
    renderer.start(1)?;
    ensure!(
        renderer
            .material(&model.materials[id].update_bytes(id))
            .is_err(),
        "Active job accepted material update"
    );
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
            ensure!(
                renderer.material(&m.update_bytes(id))?,
                "Expected supported partial material update"
            );
            partial_ms.push(started.elapsed().as_secs_f64() * 1000.);
            ensure!(
                renderer.samples()? == 0,
                "Partial material did not reset samples"
            );
            let actual = renderer.finish(8)?;
            let started = std::time::Instant::now();
            reference.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
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
        format!("partial ms {partial_ms:?}\nfull commit ms {full_ms:?}\n"),
    )?;
    println!(
        "PASS {count} basic material updates: HDR/normal/albedo byte-exact to full commits; baseline restored"
    );
    Ok(())
}
fn environment_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let model = Model::load(path)?;
    let camera = Camera::fit(model.center, model.radius);
    let mut environment = Environment::default();
    let size = [160, 106];
    let mut renderer = Renderer::with_backend(1)?;
    let mut reference = Renderer::with_backend(1)?;
    renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
    let original = renderer.finish(8)?;
    let mut bad = environment.update_bytes();
    bad[48..52].copy_from_slice(&f32::NAN.to_le_bytes());
    ensure!(
        renderer.environment(&bad).is_err() && renderer.pixels()? == original,
        "Invalid environment changed scene"
    );
    renderer.start(1)?;
    ensure!(
        renderer.environment(&environment.update_bytes()).is_err(),
        "Active job accepted environment update"
    );
    renderer.cancel()?;
    while !renderer.poll()? {
        std::thread::sleep(Duration::from_millis(1));
    }
    for mode in 0..2 {
        if mode == 1 {
            // Different dimensions require a full commit. Subsequent HDR edits
            // use the same partial path as the procedural studio environment.
            environment.image = Some(image::Rgb32FImage::from_fn(16, 8, |x, y| {
                image::Rgb([0.1 + x as f32 * 0.2, 0.2 + y as f32 * 0.3, 0.5])
            }));
            ensure!(
                !renderer.environment(&environment.update_bytes())?,
                "Map resize accepted partial update"
            );
            renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
        }
        for step in 0..8 {
            environment.intensity = if step == 0 { 0. } else { step as f32 * 0.4 };
            environment.rotation = step as f32 * 57.;
            environment.color = [0.2 + step as f32 * 0.1, 0.8, 0.4];
            ensure!(
                renderer.environment(&environment.update_bytes())?,
                "Expected partial environment update"
            );
            ensure!(
                renderer.samples()? == 0,
                "Environment update did not reset samples"
            );
            let actual = renderer.finish(8)?;
            reference.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
            ensure!(
                actual == reference.finish(8)?
                    && renderer.image(1)? == reference.image(1)?
                    && renderer.image(2)? == reference.image(2)?,
                "Partial environment differs from full commit at {mode}/{step}"
            );
        }
    }
    renderer::save(&out.join("partial.png"), &renderer.pixels()?, size, 0.)?;
    let current = renderer.pixels()?;
    environment.background = false;
    ensure!(
        !renderer.environment(&environment.update_bytes())? && renderer.pixels()? == current,
        "Background feature rejection changed scene"
    );
    environment = Environment::default();
    renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
    ensure!(
        renderer.finish(8)? == original,
        "Environment baseline restore differs"
    );
    println!(
        "PASS 16 studio/HDR environment updates: HDR/normal/albedo byte-exact to full commits; invalid/active-job/shape/feature rejection; original restored"
    );
    Ok(())
}
fn light_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
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
    renderer.commit(&model.descriptor_with_light(&camera.bytes(), size, &environment, &light))?;
    let before = renderer.finish(8)?;
    let mut bad = light.update_bytes();
    bad[20..24].copy_from_slice(&f32::NAN.to_le_bytes());
    ensure!(
        renderer.light(&bad).is_err() && renderer.pixels()? == before,
        "Invalid light modified scene"
    );
    renderer.start(1)?;
    ensure!(
        renderer.light(&light.update_bytes()).is_err(),
        "Active job accepted light update"
    );
    renderer.cancel()?;
    while !renderer.poll()? {
        std::thread::sleep(Duration::from_millis(1));
    }
    for step in 0..18 {
        if step == 9 {
            environment.background = false;
            renderer.commit(&model.descriptor_with_light(
                &camera.bytes(),
                size,
                &environment,
                &light,
            ))?;
        }
        environment.intensity = 0.3 + step as f32 * 0.1;
        environment.rotation = step as f32 * 31.;
        let env_bytes = environment.update_bytes();
        if !environment.background {
            let full = model.descriptor_with_light(&camera.bytes(), size, &environment, &light);
            ensure!(
                env_bytes[16..32] == full[64..80],
                "Partial background color differs from full descriptor"
            );
        }
        ensure!(
            renderer.environment(&env_bytes)?,
            "Expected partial environment before light update"
        );
        light.intensity = if step % 6 == 0 {
            0.
        } else {
            0.5 + step as f32 * 0.4
        };
        light.color = [0.2 + step as f32 * 0.03, 0.8, 0.4];
        light.azimuth = step as f32 * 21.;
        light.elevation = 10. + (step % 8) as f32 * 9.;
        ensure!(
            renderer.light(&light.update_bytes())?,
            "Expected partial light update"
        );
        ensure!(
            renderer.samples()? == 0,
            "Light update did not reset samples"
        );
        let actual = renderer.finish(8)?;
        reference.commit(&model.descriptor_with_light(
            &camera.bytes(),
            size,
            &environment,
            &light,
        ))?;
        ensure!(
            actual == reference.finish(8)?
                && renderer.image(1)? == reference.image(1)?
                && renderer.image(2)? == reference.image(2)?,
            "Partial light/environment differed from full commit at {step}"
        );
    }
    let before = renderer.pixels()?;
    let mut different_type = light.update_bytes();
    different_type[16..20].copy_from_slice(&1u32.to_le_bytes());
    ensure!(
        !renderer.light(&different_type)? && renderer.pixels()? == before,
        "Light type rejection changed scene"
    );
    renderer::save(&out.join("partial.png"), &before, size, 0.)?;
    light.enabled = false;
    renderer.commit(&model.descriptor_with_light(&camera.bytes(), size, &environment, &light))?;
    ensure!(
        renderer.finish(8)? != before,
        "Removing key light had no effect"
    );
    println!(
        "PASS18 key-light updates interleaved with environment edits: HDR/normal/albedo byte-exact; invalid/busy/type rejection; removal renders"
    );
    Ok(())
}
fn transform_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
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
        renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
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
                let update = model.meshes[id].update_bytes(id);
                let before = renderer.pixels()?;
                let mut invalid = update.clone();
                invalid[16..20].copy_from_slice(&f32::NAN.to_le_bytes());
                ensure!(
                    renderer.transform(&invalid).is_err() && renderer.pixels()? == before,
                    "Invalid transform mutated scene"
                );
                if renderer.transform(&update)? {
                    partial += 1;
                } else {
                    ensure!(
                        renderer.pixels()? == before,
                        "Rejected transform changed output"
                    );
                    renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
                    fallback += 1;
                }
                ensure!(renderer.samples()? == 0, "Transform did not reset samples");
                let actual = renderer.finish(8)?;
                reference.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
                ensure!(
                    actual == reference.finish(8)?
                        && renderer.image(1)? == reference.image(1)?
                        && renderer.image(2)? == reference.image(2)?,
                    "Transform full/partial mismatch {mode}/{id}/{step}"
                );
                // Accepted transform lighting must survive subsequent environment edits.
                environment.intensity = 0.5 + step as f32 * 0.2;
                if !renderer.environment(&environment.update_bytes())? {
                    renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
                }
                let actual = renderer.finish(8)?;
                reference.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
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
    ensure!(partial > 0, "No partial transforms executed");
    println!(
        "PASS {partial} partial transforms, {fallback} explicit full fallbacks; software/auto HDR/normal/albedo exact; interleaved environment and invalid-update preservation"
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
    let mut environment_out = None;
    let mut light_out = None;
    let mut transform_out = None;
    let mut geometry_out = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
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
        r.commit(&m.descriptor(&c.bytes(), [160, 106], &Environment::default()))?;
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
    let viewer = Viewer::new(&model)?;
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_drag_and_drop(true)
            .with_inner_size([1200., 800.])
            .with_min_inner_size([800., 560.]),
        renderer: eframe::Renderer::Glow,
        ..Default::default()
    };
    eframe::run_native(
        "MuTracer Native Viewer",
        options,
        Box::new(move |cc| {
            let mut visuals = egui::Visuals::dark();
            visuals.panel_fill = egui::Color32::from_rgb(27, 30, 36);
            visuals.selection.bg_fill = egui::Color32::from_rgb(44, 91, 140);
            cc.egui_ctx.set_visuals(visuals);
            cc.egui_ctx.style_mut(|style| {
                style.spacing.item_spacing = egui::vec2(10., 10.);
                style.spacing.button_padding = egui::vec2(10., 6.);
                style.spacing.slider_width = 150.;
            });
            Ok(Box::new(viewer))
        }),
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))
}
