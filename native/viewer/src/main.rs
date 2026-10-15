//! Small native example: glTF input → native MuTracer library → egui image.
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
            texture: None,
            display_dirty: false,
            error: String::new(),
        })
    }
    fn dirty(&mut self, change: Change) {
        self.change = self.change.max(change);
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
        if self.change == Change::Scene && ctx.input(|i| i.pointer.any_down()) {
            ctx.request_repaint_after(Duration::from_millis(16));
            return Ok(());
        }
        if !self.renderer.busy() {
            match self.change {
                Change::Scene => {
                    if let Some((model, camera)) = self.candidate.take() {
                        self.renderer.commit(&model.descriptor(
                            &camera.bytes(),
                            self.size,
                            &self.environment,
                        ))?;
                        self.model = model;
                        self.camera = camera;
                        self.selected = self.model.meshes[0].material;
                    } else {
                        self.renderer.commit(&self.model.descriptor(
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
                self.pixels.clear();
                self.texture = None;
                self.change = Change::None;
                self.error.clear();
            } else if finished {
                self.samples = self.renderer.samples()?;
                if self.samples > 0 {
                    self.pixels = self.renderer.pixels()?;
                    self.display_dirty = true;
                }
            }
            if self.running && self.samples < self.target {
                self.renderer.start((self.target - self.samples).min(4))?;
            }
        }
        if self.display_dirty && !self.pixels.is_empty() {
            let pixels = renderer::display(&self.pixels, self.size, self.exposure);
            let image = egui::ColorImage::from_rgba_unmultiplied(
                [self.size[0] as usize, self.size[1] as usize],
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
                            if let Err(e) =
                                renderer::save(&path, &self.pixels, self.size, self.exposure)
                            {
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
                        self.pixels.clear();
                        self.texture = None;
                        self.display_dirty = false;
                        self.dirty(Change::Scene);
                    }
                    if ui
                        .add(egui::Slider::new(&mut self.exposure, -4.0..=4.0).text("Exposure"))
                        .changed()
                    {
                        self.display_dirty = true;
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
        if let Err(e) = self.tick(ctx) {
            self.error = format!("Render stopped: {e:#}");
            self.running = false;
            self.change = Change::None;
        }
        self.panels(ctx);
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
fn main() -> Result<()> {
    let mut model = None;
    let mut smoke_out = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
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
