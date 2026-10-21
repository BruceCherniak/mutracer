//! Native viewer layout. Rendering and scene updates stay in Viewer.
use crate::renderer::Camera;
use crate::{Change, Viewer, default_model, renderer, scene::Environment};
use crate::{controls, theme};
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
        // Narrow windows keep the viewport usable; hiding the inspector makes room for the list.
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
        egui::Panel::top("toolbar")
            .exact_size(42.)
            .resizable(false)
            .frame(
                egui::Frame::new()
                    .fill(egui::Color32::from_rgb(0x14, 0x15, 0x17))
                    .inner_margin(egui::Margin::symmetric(12, 6)),
            )
            .show_separator_line(false)
            .show(root, |ui| {
                ui.horizontal(|ui| {
                    ui.strong("MuTracer");
                    ui.separator();
                    ui.toggle_value(&mut self.scene_open, "Scene")
                        .on_hover_text("Toggle scene list");
                    ui.toggle_value(&mut self.inspector_open, "Inspector")
                        .on_hover_text("Toggle inspector");
                    if controls::button(ui, "Open GLTF / GLB…").clicked() {
                        if let Some(path) = rfd::FileDialog::new()
                            .add_filter("glTF", &["gltf", "glb"])
                            .pick_file()
                        {
                            self.load(path, &ctx);
                        }
                    }
                    if ui.available_width() > 360. && controls::button(ui, "Sample").clicked() {
                        self.load(default_model(), &ctx);
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui
                            .add_enabled(
                                self.frame_samples > 0,
                                egui::Button::new("Save PNG…")
                                    .fill(theme::ACCENT_SURFACE)
                                    .stroke(egui::Stroke::new(1., theme::ACCENT)),
                            )
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
                        if ui.available_width() > 100. {
                            ui.add(
                                egui::Label::new(
                                    egui::RichText::new(&self.model.name).color(theme::MUTED),
                                )
                                .truncate(),
                            );
                        }
                    });
                });
            });
    }
    fn status_bar(&mut self, root: &mut egui::Ui) {
        let ctx = root.ctx().clone();
        egui::Panel::bottom("status")
            .exact_size(28.)
            .resizable(false)
            .frame(
                egui::Frame::new()
                    .fill(theme::BG)
                    .inner_margin(egui::Margin::symmetric(16, 4)),
            )
            .show_separator_line(false)
            .show(root, |ui| {
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
                    if ui.available_width() > 380. {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let hint =
                                "Click: select · Drag: orbit · Shift-drag: pan · Scroll: zoom";
                            ui.small(hint);
                        });
                    }
                });
            });
    }
    fn inspector_rail(&mut self, root: &mut egui::Ui) {
        egui::Panel::right("inspector_rail")
            .exact_size(60.)
            .resizable(false)
            .show_separator_line(false)
            .frame(theme::panel().inner_margin(4))
            .show(root, |ui| {
                ui.spacing_mut().button_padding.x = 2.;
                use controls::Icon;
                for (tab, name, icon) in [
                    (2, "Lighting", Icon::Lighting),
                    (1, "Material", Icon::Material),
                    (4, "Camera", Icon::Camera),
                    (0, "Render", Icon::Render),
                    (3, "Object", Icon::Object),
                ] {
                    if controls::category(ui, name, icon, self.inspector_open && self.tab == tab)
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
            .default_size(224.)
            .min_size(180.)
            .max_size(320.)
            .show_separator_line(false)
            .frame(theme::panel().outer_margin(egui::Margin {
                left: 6,
                right: 0,
                top: 6,
                bottom: 6,
            }))
            .show(root, |ui| {
                ui.horizontal(|ui| {
                    ui.strong("Scene");
                    ui.add(
                        egui::Label::new(
                            egui::RichText::new(&self.model.name)
                                .small()
                                .color(theme::SUBTLE),
                        )
                        .truncate(),
                    );
                });
                ui.add(
                    egui::TextEdit::singleline(&mut self.object_query)
                        .hint_text("Search objects")
                        .desired_width(f32::INFINITY),
                );
                ui.separator();
                egui::Panel::bottom("scene_summary")
                    .frame(egui::Frame::new().inner_margin(egui::Margin::symmetric(0, 8)))
                    .show(ui, |ui| {
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
                        let mut visible = 0;
                        for (id, mesh) in self.model.meshes.iter().enumerate() {
                            if !mesh.name.to_lowercase().contains(&query) {
                                continue;
                            }
                            visible += 1;
                            if controls::tree_row(
                                ui,
                                &mesh.name,
                                &self.model.materials[mesh.material].name,
                                self.selected_mesh == Some(id),
                            )
                            .clicked()
                            {
                                self.selected_mesh = Some(id);
                                self.selected = mesh.material;
                                self.tab = 1;
                                self.inspector_open = true;
                            }
                        }
                        if visible == 0 {
                            ui.weak("No matching objects");
                        }
                    });
            });
    }
    fn inspector(&mut self, root: &mut egui::Ui) {
        egui::Panel::right("settings")
            .resizable(true)
            .default_size(300.)
            .min_size(250.)
            .max_size(420.)
            .show_separator_line(false)
            .frame(theme::panel().inner_margin(10))
            .show(root, |ui| {
                let (title, subtitle) = match self.tab {
                    0 => ("Render", "Path tracing quality and display"),
                    1 => ("Material", "Edits apply to objects sharing this material"),
                    2 => ("Lighting", "Environment, background and key light"),
                    3 => ("Object", "Position, rotation and scale"),
                    _ => ("Camera", "Framing and field of view"),
                };
                ui.strong(title).on_hover_text(subtitle);
                ui.separator();
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
        controls::section(ui, "Sampling", |ui| {
            ui.small(format!("{} / {} samples", self.samples, self.target));
            ui.add(
                egui::ProgressBar::new(self.samples as f32 / self.target.max(1) as f32)
                    .fill(theme::ACCENT)
                    .desired_height(4.),
            );
            ui.horizontal(|ui| {
                if controls::button(ui, if self.running { "Pause" } else { "Resume" }).clicked() {
                    self.running = !self.running;
                }
                if controls::button(ui, "Restart").clicked() {
                    self.dirty(Change::Reset);
                }
            });
            controls::parameter(
                ui,
                "Samples",
                egui::Slider::new(&mut self.target, 8..=1024).logarithmic(true),
            );
            let old = self.size;
            controls::select(
                ui,
                "Resolution",
                format!("{} × {}", self.size[0], self.size[1]),
                |ui| {
                    for width in [320, 480, 640, 960] {
                        let size = [width, width * 2 / 3];
                        ui.selectable_value(
                            &mut self.size,
                            size,
                            format!("{} × {}", size[0], size[1]),
                        );
                    }
                },
            );
            if old != self.size {
                self.dirty(Change::Scene);
            }
        });
        controls::section(ui, "Display", |ui| {
            if controls::parameter(
                ui,
                "Exposure",
                egui::Slider::new(&mut self.exposure, -4.0..=4.0),
            )
            .changed()
            {
                self.display_dirty = true;
            }
            if controls::toggle(ui, "Native OIDN", &mut self.denoise).changed() {
                self.display_dirty = true;
                self.last_denoise = None;
            }
            if self.denoise {
                ui.weak(&self.denoise_status);
            }
        });
        controls::section(ui, "Device", |ui| {
            let old = self.backend;
            controls::select(
                ui,
                "Ray tracing",
                ["Software", "HWRT"][self.backend as usize],
                |ui| {
                    for (mode, name) in [(1, "HWRT"), (0, "Software")] {
                        ui.selectable_value(&mut self.backend, mode, name);
                    }
                },
            );
            if old != self.backend {
                self.dirty(Change::Scene);
            }
            ui.weak(&self.backend_status);
        });
    }
    fn material_settings(&mut self, ui: &mut egui::Ui) {
        if let Some(id) = self.selected_mesh {
            ui.horizontal(|ui| {
                if controls::button(ui, "Frame selection").clicked() {
                    let (min, max) = self.model.mesh_bounds(id);
                    self.camera = Camera::fit((min + max) * 0.5, (max - min).length() * 0.5);
                    self.dirty(Change::Camera);
                }
                ui.add(
                    egui::Label::new(
                        egui::RichText::new(&self.model.meshes[id].name)
                            .small()
                            .color(theme::SUBTLE),
                    )
                    .truncate(),
                );
            });
        }
        let previous = self.selected;
        controls::select(
            ui,
            "Material",
            &self.model.materials[self.selected].name,
            |ui| {
                for (i, material) in self.model.materials.iter().enumerate() {
                    if self.model.meshes.iter().any(|mesh| mesh.material == i) {
                        ui.selectable_value(&mut self.selected, i, &material.name);
                    }
                }
            },
        );
        if previous != self.selected {
            self.selected_mesh = None;
        }
        let material = &mut self.model.materials[self.selected];
        let mut changed = false;
        controls::section(ui, "Surface", |ui| {
            changed |= controls::color(ui, "Base color", &mut material.color).changed();
            changed |= controls::parameter(
                ui,
                "Roughness",
                egui::Slider::new(&mut material.roughness, 0.0..=1.0),
            )
            .changed();
            changed |= controls::parameter(
                ui,
                "Metalness",
                egui::Slider::new(&mut material.metalness, 0.0..=1.0),
            )
            .changed();
            changed |= controls::parameter(
                ui,
                "Transmission",
                egui::Slider::new(&mut material.transmission, 0.0..=1.0),
            )
            .changed();
        });
        if changed {
            self.dirty(Change::Material);
        }
    }
    fn lighting_settings(&mut self, ui: &mut egui::Ui) {
        let mut changed = false;
        controls::section(ui, "Environment", |ui| {
            ui.add(
                egui::Label::new(egui::RichText::new(&self.environment.name).color(theme::MUTED))
                    .truncate(),
            );
            ui.horizontal(|ui| {
                if controls::button(ui, "Load HDR…").clicked() {
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
                if controls::button(ui, "Studio").clicked() {
                    self.environment = Environment::default();
                    changed = true;
                }
            });
            changed |= controls::parameter(
                ui,
                "Intensity",
                egui::Slider::new(&mut self.environment.intensity, 0.0..=5.0),
            )
            .changed();
            changed |= controls::parameter(
                ui,
                "Rotation",
                egui::Slider::new(&mut self.environment.rotation, 0.0..=360.0),
            )
            .changed();
            changed |= controls::color(ui, "Tint", &mut self.environment.color).changed();
            changed |= controls::toggle(ui, "Show environment", &mut self.environment.background)
                .changed();
        });
        if changed {
            self.dirty(Change::Environment);
        }
        let mut light_changed = false;
        let was_enabled = self.light.enabled;
        controls::section(ui, "Key light", |ui| {
            controls::toggle(ui, "Directional light", &mut self.light.enabled);
            ui.add_enabled_ui(self.light.enabled, |ui| {
                light_changed |= controls::parameter(
                    ui,
                    "Intensity",
                    egui::Slider::new(&mut self.light.intensity, 0.0..=10.0),
                )
                .changed();
                light_changed |= controls::color(ui, "Color", &mut self.light.color).changed();
                light_changed |= controls::parameter(
                    ui,
                    "Azimuth",
                    egui::Slider::new(&mut self.light.azimuth, 0.0..=360.0),
                )
                .changed();
                light_changed |= controls::parameter(
                    ui,
                    "Elevation",
                    egui::Slider::new(&mut self.light.elevation, 5.0..=85.0),
                )
                .changed();
            });
        });
        if was_enabled != self.light.enabled {
            self.dirty(Change::Scene);
        } else if light_changed {
            self.dirty(Change::Light);
        }
    }
    fn object_settings(&mut self, ui: &mut egui::Ui) {
        if let Some(id) = self.selected_mesh {
            ui.add(
                egui::Label::new(
                    egui::RichText::new(&self.model.meshes[id].name).color(theme::ACCENT),
                )
                .truncate(),
            );
            let mesh = &mut self.model.meshes[id];
            let mut position = mesh.transform.w_axis.truncate();
            let mut changed = false;
            controls::section(ui, "Transform", |ui| {
                ui.weak("World position");
                for (label, value) in [
                    ("X", &mut position.x),
                    ("Y", &mut position.y),
                    ("Z", &mut position.z),
                ] {
                    changed |= controls::number(ui, label, value, self.model.radius as f64 * 0.005)
                        .changed();
                }
                if changed {
                    mesh.transform.w_axis = position.extend(1.);
                }
                ui.horizontal(|ui| {
                    for (label, degrees) in [("Y −15°", -15f32), ("Y +15°", 15f32)] {
                        if controls::button(ui, label).clicked() {
                            mesh.transform *= glam::Mat4::from_rotation_y(degrees.to_radians());
                            changed = true;
                        }
                    }
                });
                ui.horizontal(|ui| {
                    for (label, scale) in [("Smaller", 1. / 1.1), ("Larger", 1.1)] {
                        if controls::button(ui, label).clicked() {
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
            });
            if changed {
                self.model.refresh_bounds();
                self.dirty(Change::Transform);
            }
        } else {
            ui.weak("Select an object in the scene list or viewport to edit its transform.");
        }
        controls::section(ui, "Scene info", |ui| {
            ui.weak(format!(
                "{} meshes · {} triangles",
                self.model.meshes.len(),
                self.model
                    .geometries
                    .iter()
                    .map(|g| g.indices.len() / 3)
                    .sum::<usize>()
            ));
            for warning in &self.model.warnings {
                ui.colored_label(theme::WARNING, warning);
            }
        });
    }
    fn camera_settings(&mut self, ui: &mut egui::Ui) {
        controls::section(ui, "Framing", |ui| {
            if controls::button(ui, "Fit model").clicked() {
                self.camera = Camera::fit(self.model.center, self.model.radius);
                self.dirty(Change::Camera);
            }
            if controls::parameter(
                ui,
                "Field of view",
                egui::Slider::new(&mut self.camera.fov, 20.0..=90.0),
            )
            .changed()
            {
                self.dirty(Change::Camera);
            }
            ui.weak("Drag to orbit · Shift/right drag to pan\nScroll to zoom · F to fit");
        });
    }
    fn viewport(&mut self, root: &mut egui::Ui) {
        let ctx = root.ctx().clone();
        if !self.error.is_empty() {
            egui::Window::new("Unable to complete action")
                .collapsible(false).resizable(true).default_width(480.)
                .show(&ctx, |ui| {
                    ui.colored_label(theme::ERROR, &self.error);
                    ui.small("The previous image is kept. You can open another model or change settings.");
                    if controls::button(ui, "Dismiss").clicked() { self.error.clear(); }
                });
        }
        egui::CentralPanel::default()
            .frame(theme::panel().fill(theme::WORKSPACE).outer_margin(6))
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
                        theme::ACCENT,
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
