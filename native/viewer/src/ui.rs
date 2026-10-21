//! Native viewer layout. Rendering and scene updates stay in Viewer.
use crate::renderer::Camera;
use crate::{Change, Viewer, default_model, renderer, scene::Environment};
use eframe::egui;
use std::time::Duration;

impl Viewer {
    pub(super) fn panels(&mut self, root: &mut egui::Ui) {
        let ctx = root.ctx().clone();
        self.toolbar(root);
        self.status_bar(root);
        self.inspector_rail(root);
        if self.inspector_open {
            self.inspector(root);
        }
        // Give narrow windows back their viewport; the toolbar restores the list.
        if self.scene_open && root.available_width() > 600. {
            self.scene_panel(root);
        }
        self.viewport(root);
        if !ctx.egui_wants_keyboard_input() {
            if ctx.input(|i| i.key_pressed(egui::Key::OpenBracket)) {
                self.scene_open = !self.scene_open;
            }
            if ctx.input(|i| i.key_pressed(egui::Key::CloseBracket)) {
                self.inspector_open = !self.inspector_open;
            }
        }
    }
    fn toolbar(&mut self, root: &mut egui::Ui) {
        let ctx = root.ctx().clone();
        egui::Panel::top("toolbar").show(root, |ui| {
            ui.horizontal(|ui| {
                ui.strong("MuTracer");
                ui.separator();
                ui.toggle_value(&mut self.scene_open, "Scene")
                    .on_hover_text("Toggle scene list");
                ui.toggle_value(&mut self.inspector_open, "Inspector")
                    .on_hover_text("Toggle inspector");
                if ui.button("Open GLTF / GLB…").clicked() {
                    if let Some(path) = rfd::FileDialog::new()
                        .add_filter("glTF", &["gltf", "glb"])
                        .pick_file()
                    {
                        self.load(path, &ctx);
                    }
                }
                ui.label(
                    egui::RichText::new(&self.model.name)
                        .color(egui::Color32::from_rgb(190, 196, 208)),
                );
                if ui.small_button("Sample").clicked() {
                    self.load(default_model(), &ctx);
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui
                        .add_enabled(self.frame_samples > 0, egui::Button::new("Save PNG…"))
                        .clicked()
                    {
                        if let Some(path) = rfd::FileDialog::new()
                            .set_file_name("mutracer.png")
                            .add_filter("PNG", &["png"])
                            .save_file()
                        {
                            let linear = if let Some(display) = &self.gpu_display {
                                display
                                    .read_linear()
                                    .map_err(|e| anyhow::anyhow!(e.to_string()))
                            } else {
                                Ok(self.display_pixels().to_vec())
                            };
                            if let Err(e) = linear.and_then(|pixels| {
                                renderer::save(&path, &pixels, self.pixel_size, self.exposure)
                            }) {
                                self.error = e.to_string();
                            }
                        }
                    }
                });
            });
        });
    }
    fn status_bar(&mut self, root: &mut egui::Ui) {
        let ctx = root.ctx().clone();
        egui::Panel::bottom("status").show(root, |ui| {
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
    }
    fn inspector_rail(&mut self, root: &mut egui::Ui) {
        egui::Panel::right("inspector_rail")
            .exact_size(64.)
            .resizable(false)
            .show(root, |ui| {
                for (tab, name) in [
                    (2, "Lighting"),
                    (1, "Material"),
                    (4, "Camera"),
                    (0, "Render"),
                    (3, "Object"),
                ] {
                    if ui
                        .add_sized(
                            [ui.available_width(), 48.],
                            egui::Button::new(egui::RichText::new(name).size(10.))
                                .selected(self.inspector_open && self.tab == tab),
                        )
                        .clicked()
                    {
                        self.inspector_open = !(self.inspector_open && self.tab == tab);
                        self.tab = tab;
                    }
                }
            });
    }
    fn scene_panel(&mut self, root: &mut egui::Ui) {
        egui::Panel::left("scene")
            .resizable(true)
            .default_size(252.)
            .min_size(180.)
            .max_size(320.)
            .show(root, |ui| {
                ui.heading("Scene");
                ui.label(&self.model.name);
                ui.add(
                    egui::TextEdit::singleline(&mut self.object_query)
                        .hint_text("Search objects")
                        .desired_width(f32::INFINITY),
                );
                ui.separator();
                egui::Panel::bottom("scene_summary").show(ui, |ui| {
                    ui.small(format!(
                        "{} meshes · {} triangles",
                        self.model.meshes.len(),
                        self.model
                            .geometries
                            .iter()
                            .map(|g| g.indices.len() / 3)
                            .sum::<usize>()
                    ));
                });
                egui::ScrollArea::vertical()
                    .id_salt("objects")
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        let query = self.object_query.to_lowercase();
                        for (id, mesh) in self.model.meshes.iter().enumerate() {
                            if !mesh.name.to_lowercase().contains(&query) {
                                continue;
                            }
                            if ui
                                .selectable_label(self.selected_mesh == Some(id), &mesh.name)
                                .clicked()
                            {
                                self.selected_mesh = Some(id);
                                self.selected = mesh.material;
                                self.tab = 1;
                                self.inspector_open = true;
                            }
                        }
                    });
            });
    }
    fn inspector(&mut self, root: &mut egui::Ui) {
        egui::Panel::right("settings")
            .resizable(true)
            .default_size(316.)
            .min_size(270.)
            .max_size(420.)
            .show(root, |ui| {
                egui::ScrollArea::vertical()
                    .id_salt(("inspector", self.tab))
                    .auto_shrink([false, false])
                    .show(ui, |ui| match self.tab {
                        0 => self.render_settings(ui),
                        1 => self.material_settings(ui),
                        2 => self.lighting_settings(ui),
                        3 => self.object_settings(ui),
                        _ => self.camera_settings(ui),
                    });
            });
    }
    fn render_settings(&mut self, ui: &mut egui::Ui) {
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
                    ui.selectable_value(&mut self.size, size, format!("{} × {}", size[0], size[1]));
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
    }
    fn material_settings(&mut self, ui: &mut egui::Ui) {
        ui.heading("Material");
        ui.small("Click a surface in the image to select its material.");
        if let Some(id) = self.selected_mesh {
            ui.label(
                egui::RichText::new(&self.model.meshes[id].name)
                    .color(egui::Color32::from_rgb(126, 190, 255)),
            );
            if ui.small_button("Frame selection").clicked() {
                let (min, max) = self.model.mesh_bounds(id);
                self.camera = Camera::fit((min + max) * 0.5, (max - min).length() * 0.5);
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
            .add(egui::Slider::new(&mut m.transmission, 0.0..=1.0).text("Transmission"))
            .changed();
        if changed {
            self.dirty(Change::Material);
        }
        ui.add_space(14.);
    }
    fn lighting_settings(&mut self, ui: &mut egui::Ui) {
        ui.heading("Environment");
        ui.label(&self.environment.name);
        let mut changed = false;
        changed |= ui
            .add(egui::Slider::new(&mut self.environment.intensity, 0.0..=5.0).text("Intensity"))
            .changed();
        changed |= ui
            .add(egui::Slider::new(&mut self.environment.rotation, 0.0..=360.0).text("Rotation"))
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
                        Err(e) => self.error = format!("Could not load environment: {e:#}"),
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
                .add(egui::Slider::new(&mut self.light.intensity, 0.0..=10.0).text("Intensity"))
                .changed();
            ui.horizontal(|ui| {
                ui.label("Color");
                light_changed |= ui.color_edit_button_rgb(&mut self.light.color).changed();
            });
            light_changed |= ui
                .add(egui::Slider::new(&mut self.light.azimuth, 0.0..=360.0).text("Azimuth"))
                .changed();
            light_changed |= ui
                .add(egui::Slider::new(&mut self.light.elevation, 5.0..=85.0).text("Elevation"))
                .changed();
        });
        if light_changed {
            self.dirty(Change::Light);
        }
        ui.add_space(14.);
    }
    fn object_settings(&mut self, ui: &mut egui::Ui) {
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
                    mesh.transform *= glam::Mat4::from_rotation_y(-15f32.to_radians());
                    changed = true;
                }
                if ui.small_button("Rotate Y +15°").clicked() {
                    mesh.transform *= glam::Mat4::from_rotation_y(15f32.to_radians());
                    changed = true;
                }
            });
            ui.horizontal(|ui| {
                for (label, scale) in [("Smaller", 1. / 1.1), ("Larger", 1.1)] {
                    if ui.small_button(label).clicked() {
                        let candidate =
                            mesh.transform * glam::Mat4::from_scale(glam::Vec3::splat(scale));
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
                self.dirty(Change::Transform);
            }
            ui.separator();
        }
        if self.selected_mesh.is_none() {
            ui.label("Select an object in the scene list or viewport to edit its transform.");
        }
        for warning in &self.model.warnings {
            ui.colored_label(egui::Color32::YELLOW, warning);
        }
    }
    fn camera_settings(&mut self, ui: &mut egui::Ui) {
        ui.add_space(14.);
        ui.heading("Camera");
        if ui.button("Fit model").clicked() {
            self.camera = Camera::fit(self.model.center, self.model.radius);
            self.dirty(Change::Camera);
        }
        if ui
            .add(egui::Slider::new(&mut self.camera.fov, 20.0..=90.0).text("Field of view"))
            .changed()
        {
            self.dirty(Change::Camera);
        }
        ui.small("Drag to orbit · Shift/right drag to pan\nScroll to zoom · F to fit");
        ui.add_space(14.);
    }
    fn viewport(&mut self, root: &mut egui::Ui) {
        let ctx = root.ctx().clone();
        if !self.error.is_empty() {
            egui::Window::new("Unable to complete action").collapsible(false).resizable(true).default_width(480.).show(&ctx,|ui|{
                ui.colored_label(egui::Color32::LIGHT_RED,&self.error);
                ui.small("The previous image is kept. You can open another model or change settings.");
                if ui.button("Dismiss").clicked(){self.error.clear();}
            });
        }
        egui::CentralPanel::default()
            .frame(
                egui::Frame::central_panel(&ctx.style_of(egui::Theme::Dark))
                    .fill(egui::Color32::from_rgb(18, 20, 24)),
            )
            .show(root, |ui| {
                let available = ui.available_size();
                let aspect = self.pixel_size[0] as f32 / self.pixel_size[1] as f32;
                let width = available.x.min(available.y * aspect);
                let size = egui::vec2(width, width / aspect);
                let rect = egui::Rect::from_center_size(ui.max_rect().center(), size);
                if let Some(texture) = self
                    .gpu_texture
                    .or_else(|| self.texture.as_ref().map(|t| t.id()))
                {
                    ui.painter().image(
                        texture,
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
                        self.inspector_open = true;
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
        if ctx.input(|i| i.key_pressed(egui::Key::F)) && !ctx.egui_wants_keyboard_input() {
            self.camera = Camera::fit(self.model.center, self.model.radius);
            self.dirty(Change::Camera);
        }
    }
}
