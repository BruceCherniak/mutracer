//! Native viewer layout. Rendering and scene updates stay in Viewer.
use crate::{Change, Viewer, scene::Environment};
use crate::{controls, theme};
use eframe::egui;

impl Viewer {
    pub(super) fn panels(&mut self, root: &mut egui::Ui) {
        let ctx = root.ctx().clone();
        self.texture_browser.drop_targets.clear();
        self.titlebar(root);
        self.inspector_rail(root);
        if self.inspector_open {
            self.inspector(root);
        }
        // Narrow windows keep the viewport usable; hiding the inspector makes room for the list.
        if self.scene_open && root.available_width() > 600. {
            self.scene_panel(root);
        }
        self.texture_browser_panel(root);
        self.viewport(root);
        let grip = crate::shell::resize_grip(root);
        if self.startup_smoke.is_some() {
            ctx.data_mut(|data| data.insert_temp(egui::Id::new("smoke-grip"), grip));
        }
        if !ctx.egui_wants_keyboard_input() {
            if ctx.input(|i| i.key_pressed(egui::Key::Space)) {
                self.toggle_animation_or_render();
            }
            if ctx.input(|i| i.key_pressed(egui::Key::D)) {
                self.denoise = !self.denoise;
            }
            if ctx.input(|i| i.key_pressed(egui::Key::OpenBracket)) {
                self.scene_open = !self.scene_open;
            }
            if ctx.input(|i| i.key_pressed(egui::Key::CloseBracket)) {
                self.inspector_open = !self.inspector_open;
            }
        }
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
            .frame(theme::panel().inner_margin(12))
            .show(root, |ui| {
                let (title, subtitle) = match self.tab {
                    0 => ("Render", "Path tracing quality and display"),
                    1 => ("Material", "Edits apply to objects sharing this material"),
                    2 => ("Lighting", "Environment, background and key light"),
                    3 => ("Object", "Position, rotation and scale"),
                    _ => ("Camera", "Framing and field of view"),
                };
                let icon = match self.tab {
                    0 => controls::Icon::Render,
                    1 => controls::Icon::Material,
                    2 => controls::Icon::Lighting,
                    3 => controls::Icon::Object,
                    _ => controls::Icon::Camera,
                };
                controls::heading(ui, title, subtitle, icon);
                ui.add(egui::Separator::default().spacing(0.));
                egui::ScrollArea::vertical()
                    .id_salt(("inspector", self.tab))
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 7.;
                        ui.add_space(5.);
                        match self.tab {
                            0 => self.render_settings(ui),
                            1 => self.material_settings(ui),
                            2 => self.lighting_settings(ui),
                            3 => self.object_settings(ui),
                            _ => self.camera_settings(ui),
                        }
                    });
            });
    }
    fn render_settings(&mut self, ui: &mut egui::Ui) {
        let previous = self.settings;
        controls::section(ui, "Quality", |ui| {
            controls::parameter(
                ui,
                "Max samples",
                controls::Scrub::new(&mut self.settings.max_samples, 4..=16384).logarithmic(true),
            );
            controls::parameter(
                ui,
                "Bounces",
                controls::Scrub::new(&mut self.settings.bounces, 1..=16),
            );
            controls::select(
                ui,
                "Sampling",
                ["Sobol", "Z-Sobol", "Random"][self.settings.sampling_pattern as usize],
                |ui| {
                    for (mode, name) in [(0, "Sobol"), (1, "Z-Sobol"), (2, "Random")] {
                        ui.selectable_value(&mut self.settings.sampling_pattern, mode, name);
                    }
                },
            );
            controls::parameter(
                ui,
                "Clamping",
                controls::Scrub::new(&mut self.settings.clamping, 0.0..=100.0),
            );
            let label = self.resolution_label();
            ui.scope(|ui| {
                ui.spacing_mut().combo_height = 320.;
                controls::select(ui, "Resolution", label, |ui| self.resolution_choices(ui));
            });
        });
        if previous != self.settings {
            self.dirty(Change::Scene);
        }
        controls::section(ui, "Color", |ui| {
            controls::select(
                ui,
                "Tone mapping",
                ["AgX", "ACES", "Cineon", "Reinhard", "Linear"]
                    [self.display_settings.tone_mapping as usize],
                |ui| {
                    for (mode, name) in [
                        (0, "AgX"),
                        (1, "ACES"),
                        (2, "Cineon"),
                        (3, "Reinhard"),
                        (4, "Linear"),
                    ] {
                        ui.selectable_value(&mut self.display_settings.tone_mapping, mode, name);
                    }
                },
            );
            controls::scalar(
                ui,
                "Exposure",
                &mut self.display_settings.exposure,
                0.0..=4.0,
            );
            controls::scalar(
                ui,
                "Contrast",
                &mut self.display_settings.contrast,
                0.5..=1.5,
            );
            controls::scalar(
                ui,
                "Saturation",
                &mut self.display_settings.saturation,
                0.0..=2.0,
            );
            controls::scalar(
                ui,
                "Temperature",
                &mut self.display_settings.temperature,
                -1.0..=1.0,
            );
            controls::scalar(ui, "Tint", &mut self.display_settings.tint, -1.0..=1.0);
        });
        controls::section(ui, "Denoiser", |ui| {
            controls::toggle(ui, "Native OIDN", &mut self.denoise);
            if self.denoise {
                ui.weak(&self.denoise_status);
            }
        });
        controls::section_open(ui, "Output", false, |ui| {
            controls::select(
                ui,
                "Channel",
                ["Final", "Normal", "Albedo"][self.display_settings.output as usize],
                |ui| {
                    for (mode, name) in [(0, "Final"), (1, "Normal"), (2, "Albedo")] {
                        ui.selectable_value(&mut self.display_settings.output, mode, name);
                    }
                },
            );
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
                    self.camera
                        .frame((min + max) * 0.5, (max - min).length() * 0.5);
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
        let material_name = &self.model.materials[self.selected].name;
        ui.add(egui::Label::new(egui::RichText::new(material_name).strong()).truncate())
            .on_hover_text(material_name);
        ui.add_space(6.);
        controls::segmented(
            ui,
            "Preset category",
            &mut self.texture_browser.preset_category,
            &[(0, "Basic"), (1, "Metal"), (2, "Glass"), (3, "Soft")],
        );
        let category = ["basic", "metal", "glass", "soft"][self.texture_browser.preset_category];
        let presets: Vec<_> = crate::material_presets::presets()
            .iter()
            .filter(|p| p.category == category)
            .collect();
        let width = (ui.available_width() - 18.) / 4.;
        for presets in presets.chunks(4) {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 6.;
                for preset in presets {
                    let texture = preset.texture(ui.ctx());
                    let response = ui.add_sized(
                        [width, width + 24.],
                        egui::Button::new("")
                            .fill(theme::INPUT)
                            .stroke(egui::Stroke::new(1., theme::BORDER))
                            .corner_radius(9),
                    );
                    response.widget_info(|| {
                        egui::WidgetInfo::labeled(
                            egui::WidgetType::Button,
                            ui.is_enabled(),
                            format!("Apply {} preset", preset.label),
                        )
                    });
                    egui::Image::from_texture(&texture)
                        .corner_radius(egui::CornerRadius {
                            nw: 8,
                            ne: 8,
                            sw: 0,
                            se: 0,
                        })
                        .paint_at(
                            ui,
                            egui::Rect::from_min_size(
                                response.rect.min + egui::vec2(1., 1.),
                                egui::vec2(width - 2., width - 2.),
                            ),
                        );
                    let label = egui::WidgetText::from(
                        egui::RichText::new(&preset.label)
                            .size(9.5)
                            .color(theme::MUTED),
                    )
                    .into_galley(
                        ui,
                        Some(egui::TextWrapMode::Truncate),
                        (width - 6.).max(1.),
                        egui::TextStyle::Small,
                    );
                    ui.painter().galley(
                        response.rect.center_bottom() - egui::vec2(label.size().x / 2., 18.),
                        label,
                        theme::MUTED,
                    );
                    if response
                        .on_hover_text(format!("Apply {} preset", preset.label))
                        .clicked()
                    {
                        self.texture_browser.cancel();
                        preset.apply(&mut self.model.materials[self.selected]);
                        self.dirty(Change::Material);
                    }
                }
            });
        }
        if crate::textures::browse_button(ui, self.texture_browser.open).clicked() {
            self.texture_browser.open = !self.texture_browser.open;
        }
        let material = &mut self.model.materials[self.selected];
        let mut changed = false;
        ui.push_id(self.selected, |ui| {
            controls::section(ui, "Base", |ui| {
                changed |= controls::color(ui, "Color", &mut material.color).changed();
                changed |= controls::scalar(ui, "Roughness", &mut material.roughness, 0.0..=1.0);
                changed |= controls::scalar(ui, "Metalness", &mut material.metalness, 0.0..=1.0);
                changed |= controls::scalar(ui, "IOR", &mut material.ior, 1.0..=3.0);
            });
            controls::section_open(ui, "Transmission", material.transmission > 0., |ui| {
                changed |= controls::scalar(ui, "Weight", &mut material.transmission, 0.0..=1.0);
                changed |=
                    controls::color(ui, "Color", &mut material.layers.transmission_color).changed();
                changed |= controls::scalar(
                    ui,
                    "Depth (m)",
                    &mut material.layers.transmission_depth,
                    0.0..=5.0,
                );
                changed |=
                    controls::scalar(ui, "Dispersion", &mut material.layers.dispersion, 0.0..=1.0);
                changed |=
                    controls::toggle(ui, "Thin walled", &mut material.layers.thin_walled).changed();
            });
            controls::section_open(ui, "Coat", material.layers.coat_weight > 0., |ui| {
                changed |=
                    controls::scalar(ui, "Weight", &mut material.layers.coat_weight, 0.0..=1.0);
                changed |= controls::scalar(
                    ui,
                    "Roughness",
                    &mut material.layers.coat_roughness,
                    0.0..=1.0,
                );
                changed |= controls::scalar(ui, "IOR", &mut material.layers.coat_ior, 1.0..=3.0);
                changed |= controls::color(ui, "Tint", &mut material.layers.coat_color).changed();
            });
            controls::section_open(
                ui,
                "Subsurface",
                material.layers.subsurface_weight > 0.,
                |ui| {
                    changed |= controls::scalar(
                        ui,
                        "Weight",
                        &mut material.layers.subsurface_weight,
                        0.0..=1.0,
                    );
                    changed |= controls::color(ui, "Color", &mut material.layers.subsurface_color)
                        .changed();
                    changed |= controls::scalar(
                        ui,
                        "Radius",
                        &mut material.layers.subsurface_radius,
                        0.0..=2.0,
                    );
                },
            );
            controls::section_open(ui, "Fuzz", material.layers.fuzz_weight > 0., |ui| {
                changed |=
                    controls::scalar(ui, "Weight", &mut material.layers.fuzz_weight, 0.0..=1.0);
                changed |= controls::color(ui, "Color", &mut material.layers.fuzz_color).changed();
                changed |= controls::scalar(
                    ui,
                    "Roughness",
                    &mut material.layers.fuzz_roughness,
                    0.0..=1.0,
                );
            });
            controls::section_open(ui, "Thin film", material.layers.film_weight > 0., |ui| {
                changed |=
                    controls::scalar(ui, "Weight", &mut material.layers.film_weight, 0.0..=1.0);
                changed |= controls::scalar(
                    ui,
                    "Thickness (µm)",
                    &mut material.layers.film_thickness,
                    0.0..=2.0,
                );
                changed |= controls::scalar(ui, "IOR", &mut material.layers.film_ior, 1.0..=3.0);
            });
            let emitting =
                material.emission_strength > 0. && material.emission.iter().any(|v| *v > 0.);
            controls::section_open(ui, "Emission", emitting, |ui| {
                changed |= controls::color(ui, "Color", &mut material.emission).changed();
                changed |=
                    controls::scalar(ui, "Luminance", &mut material.emission_strength, 0.0..=50.0);
            });
            controls::section_open(ui, "Advanced", false, |ui| {
                changed |=
                    controls::scalar(ui, "Anisotropy", &mut material.layers.anisotropy, 0.0..=1.0);
                changed |= controls::scalar(
                    ui,
                    "Diffuse roughness",
                    &mut material.layers.diffuse_roughness,
                    0.0..=1.0,
                );
                changed |= controls::scalar(
                    ui,
                    "Specular weight",
                    &mut material.layers.specular_weight,
                    0.0..=1.0,
                );
                changed |= controls::scalar(ui, "Bevel", &mut material.layers.bevel, 0.0..=0.05);
                let previous = material.alpha_mode;
                controls::select(
                    ui,
                    "Alpha",
                    ["Auto", "Opaque", "Mask", "Blend"][material.alpha_mode as usize],
                    |ui| {
                        for (value, label) in
                            [(0, "Auto"), (1, "Opaque"), (2, "Mask"), (3, "Blend")]
                        {
                            ui.selectable_value(&mut material.alpha_mode, value, label);
                        }
                    },
                );
                changed |= previous != material.alpha_mode;
                ui.add_enabled_ui(material.alpha_mode != 1, |ui| {
                    changed |= controls::scalar(ui, "Opacity", &mut material.opacity, 0.0..=1.0);
                })
                .response
                .on_hover_text("Opacity applies in Auto, Mask or Blend alpha mode.");
                ui.add_enabled_ui(material.maps[1] != u32::MAX, |ui| {
                    changed |= controls::scalar(
                        ui,
                        "Normal scale",
                        &mut material.normal_scale,
                        -2.0..=2.0,
                    );
                })
                .response
                .on_hover_text("Requires a normal map.");
                changed |=
                    controls::toggle(ui, "Double sided", &mut material.double_sided).changed();
                changed |= controls::toggle(ui, "Unlit", &mut material.unlit).changed();
                if material.alpha_mode == 2 {
                    changed |=
                        controls::scalar(ui, "Alpha cutoff", &mut material.alpha_cutoff, 0.0..=1.0);
                }
            });
        });
        controls::section_open(ui, "Displacement", true, |ui| {
            let material = &mut self.model.materials[self.selected];
            changed |= controls::scalar(
                ui,
                "Scale",
                &mut material.layers.displacement_scale,
                -self.model.radius * 0.1..=self.model.radius * 0.1,
            );
            changed |= controls::scalar(
                ui,
                "Bias",
                &mut material.layers.displacement_bias,
                -self.model.radius * 0.1..=self.model.radius * 0.1,
            );
            changed |= controls::scalar(
                ui,
                "Step size",
                &mut material.layers.displacement_step,
                0. ..=self.model.radius * 0.01,
            );
            let before = material.layers.displacement_projection;
            controls::select(
                ui,
                "Projection",
                ["UV", "Triplanar", "Spherical", "Cylindrical"][before as usize],
                |ui| {
                    for (id, label) in [
                        (0, "UV"),
                        (1, "Triplanar"),
                        (2, "Spherical"),
                        (3, "Cylindrical"),
                    ] {
                        ui.selectable_value(
                            &mut material.layers.displacement_projection,
                            id,
                            label,
                        );
                    }
                },
            );
            changed |= before != material.layers.displacement_projection;
            changed |= controls::scalar(
                ui,
                "Projection scale",
                &mut material.layers.displacement_projection_scale,
                0.01..=10.,
            );
            ui.small("Offset = texture × Scale + Bias, in mesh-local units. Requires a displacement texture. Adds preparation and render time.");
        });
        let textured = self.model.materials[self.selected]
            .maps
            .iter()
            .any(|id| *id != u32::MAX);
        controls::section_open(ui, "Textures", textured, |ui| {
            for &(slot, label, hint) in crate::textures::SLOTS {
                let id = self.model.materials[self.selected].maps[slot];
                ui.push_id((self.selected, slot), |ui| {
                    let row = ui.horizontal(|ui| {
                        let response = if let Some(texture) = self.model.textures.get(id as usize) {
                            let handle = self.texture_browser.preview(
                                self.selected,
                                slot,
                                texture,
                                ui.ctx(),
                            );
                            ui.add(egui::Button::image(
                                egui::Image::from_texture(&handle)
                                    .fit_to_exact_size(egui::vec2(40., 40.)),
                            ))
                        } else {
                            ui.add_sized([40., 40.], egui::Button::new("+"))
                        };
                        if response
                            .on_hover_text(format!("Upload or replace {label}"))
                            .clicked()
                        {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("Image", &["png", "jpg", "jpeg", "webp"])
                                .pick_file()
                            {
                                self.texture_browser.upload(
                                    &self.model,
                                    self.selected,
                                    slot,
                                    path,
                                    ui.ctx(),
                                );
                            }
                        }
                        ui.vertical(|ui| {
                            ui.label(label);
                            ui.small(hint);
                            if let Some(texture) = self.model.textures.get(id as usize) {
                                ui.small(format!("{} × {}", texture.width, texture.height));
                            }
                        });
                        if id != u32::MAX
                            && controls::button(ui, "×")
                                .on_hover_text(format!("Remove {label}"))
                                .clicked()
                        {
                            self.texture_browser.cancel();
                            match self
                                .model
                                .replace_textures(self.selected, vec![(slot, None)])
                            {
                                Ok(()) => changed = true,
                                Err(e) => self.error = e.to_string(),
                            }
                        }
                    });
                    self.texture_browser.drop_targets.push((
                        row.response.rect,
                        self.selected,
                        slot,
                    ));
                    let id = self.model.materials[self.selected].maps[slot];
                    if let Some(texture) = self.model.textures.get(id as usize) {
                        let mut wrap = texture.wrap;
                        let mut scale = texture.scale;
                        controls::section_open(ui, "Wrap & repeat", false, |ui| {
                            if controls::texture_sampling(ui, &mut wrap, &mut scale) {
                                self.texture_browser.cancel();
                                match self.model.set_texture_sampling(
                                    self.selected,
                                    slot,
                                    wrap,
                                    scale,
                                ) {
                                    Ok(edited) => changed |= edited,
                                    Err(e) => self.error = e.to_string(),
                                }
                            }
                        });
                    }
                });
            }
        });
        if changed {
            self.dirty(Change::Material);
        }
    }

    fn lighting_settings(&mut self, ui: &mut egui::Ui) {
        let previous_studio = self.environment.studio.clone();
        let mut changed = false;
        let was_studio = self.environment.studio.enabled;
        controls::segmented(
            ui,
            "Lighting",
            &mut self.environment.studio.enabled,
            &[(false, "Environment"), (true, "Studio")],
        );
        changed |= was_studio != self.environment.studio.enabled;
        if self.environment.studio.enabled {
            controls::section(ui, "Studio", |ui| {
                let studio = &mut self.environment.studio;
                let previous = studio.clone();
                let width = (ui.available_width() - 6.) / 2.;
                for row in crate::studio::presets().chunks(2).enumerate() {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 6.;
                        for (column, preset) in row.1.iter().enumerate() {
                            let id = row.0 * 2 + column;
                            if controls::preset_card(
                                ui,
                                width,
                                &preset.name,
                                &preset.tag,
                                studio.preset == id,
                            )
                            .clicked()
                            {
                                studio.preset = id;
                            }
                        }
                    });
                }
                controls::scalar(ui, "Intensity", &mut studio.intensity, 0.0..=4.0);
                controls::parameter(
                    ui,
                    "Rotation",
                    controls::Scrub::new(&mut studio.rotation, -180.0..=180.0)
                        .max_decimals(0)
                        .suffix("°"),
                );
                controls::parameter(
                    ui,
                    "Size",
                    controls::Scrub::new(&mut studio.size, 0.25..=3.0).suffix("×"),
                );
                controls::scalar(ui, "Ambient", &mut studio.ambient, 0.0..=1.0);
                controls::color(ui, "Ambient color", &mut studio.ambient_color);
                changed |= previous != *studio;
            });
        } else {
            controls::section(ui, "Environment", |ui| {
                ui.add(
                    egui::Label::new(
                        egui::RichText::new(&self.environment.name).color(theme::MUTED),
                    )
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
                    if controls::button(ui, "Built-in").clicked() {
                        self.environment.image = None;
                        self.environment.name = Environment::default().name;
                        changed = true;
                    }
                });
                changed |= controls::parameter(
                    ui,
                    "Intensity",
                    controls::Scrub::new(&mut self.environment.intensity, 0.0..=4.0),
                )
                .changed();
                changed |= controls::parameter(
                    ui,
                    "Rotation",
                    controls::Scrub::new(&mut self.environment.rotation, 0.0..=360.0).suffix("°"),
                )
                .changed();
                changed |= controls::color(ui, "Tint", &mut self.environment.color).changed();
            });
        }
        controls::section(ui, "Background", |ui| {
            let old = if self.environment.background {
                0
            } else if self.environment.background_alpha > 0. {
                1
            } else {
                2
            };
            let mut mode = old;
            controls::segmented(
                ui,
                "Background",
                &mut mode,
                &[
                    (
                        0,
                        if self.environment.studio.enabled {
                            "Studio"
                        } else {
                            "Environment"
                        },
                    ),
                    (1, "Color"),
                    (2, "Transparent"),
                ],
            );
            if mode != old {
                self.environment.background = mode == 0;
                self.environment.background_alpha = if mode == 2 { 0. } else { 1. };
                changed = true;
            }
            if mode == 1 {
                changed |=
                    controls::color(ui, "Color", &mut self.environment.background_color).changed();
            }
            if mode == 2 {
                ui.weak("The environment still lights the scene. PNG keeps transparency.");
            }
        });
        if changed {
            self.dirty(
                if previous_studio.enabled != self.environment.studio.enabled
                    || previous_studio.preset != self.environment.studio.preset
                {
                    Change::Scene
                } else {
                    Change::Environment
                },
            );
        }
        let mut light_changed = false;
        let was_enabled = self.light.enabled;
        controls::section(ui, "Key light", |ui| {
            controls::toggle(ui, "Directional light", &mut self.light.enabled);
            ui.add_enabled_ui(self.light.enabled, |ui| {
                light_changed |= controls::parameter(
                    ui,
                    "Intensity",
                    controls::Scrub::new(&mut self.light.intensity, 0.0..=10.0),
                )
                .changed();
                light_changed |= controls::color(ui, "Color", &mut self.light.color).changed();
                light_changed |= controls::parameter(
                    ui,
                    "Azimuth",
                    controls::Scrub::new(&mut self.light.azimuth, 0.0..=360.0).suffix("°"),
                )
                .changed();
                light_changed |= controls::parameter(
                    ui,
                    "Elevation",
                    controls::Scrub::new(&mut self.light.elevation, 5.0..=85.0).suffix("°"),
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
            let before = mesh.transform;
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
                if let Some(animation) = &mut self.model.animation {
                    animation.edit_transform(id, before, self.model.meshes[id].transform);
                }
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
        let mut changed = false;
        controls::section(ui, "View", |ui| {
            let before = self.camera.orthographic;
            controls::segmented(
                ui,
                "Projection",
                &mut self.camera.orthographic,
                &[(false, "Perspective"), (true, "Orthographic")],
            );
            changed |= before != self.camera.orthographic;
            ui.add_enabled_ui(!self.camera.orthographic, |ui| {
                changed |= controls::parameter(
                    ui,
                    "Field of view",
                    controls::Scrub::new(&mut self.camera.fov, 10.0..=100.0)
                        .max_decimals(0)
                        .suffix("°"),
                )
                .changed();
            });
            if ui
                .add_sized(
                    [ui.available_width(), 30.],
                    egui::Button::new("Fit to model · F"),
                )
                .clicked()
            {
                self.camera.frame(self.model.center, self.model.radius);
                changed = true;
            }
        });
        controls::section(ui, "Depth of field", |ui| {
            ui.add_enabled_ui(!self.camera.orthographic, |ui| {
                let mut enabled = self.camera.f_stop > 0.;
                if controls::toggle(ui, "Depth of field", &mut enabled).changed() {
                    self.camera.f_stop = if enabled { 2.8 } else { 0. };
                    self.picking_focus = false;
                    changed = true;
                }
                if enabled {
                    changed |= controls::parameter(
                        ui,
                        "f-number",
                        controls::Scrub::new(&mut self.camera.f_stop, 0.7..=22.)
                            .logarithmic(true)
                            .prefix("f/"),
                    )
                    .changed();
                    if controls::toggle(ui, "Area autofocus", &mut self.focus.enabled).changed() {
                        self.focus.request();
                        self.picking_focus = false;
                    }
                    ui.add_enabled_ui(self.focus.enabled, |ui| {
                        controls::toggle(ui, "Show focus frame", &mut self.focus.show_frame);
                    });
                    let unit = self.camera.meters_per_unit;
                    let mut focus = self.camera.focus_distance * unit;
                    let min = self.model.radius * 0.05 * unit;
                    let max = (self.model.radius * 60.).max(self.camera.focus_distance * 2.) * unit;
                    if controls::parameter(
                        ui,
                        "Focus (m)",
                        controls::Scrub::new(&mut focus, min..=max)
                            .logarithmic(true)
                            .max_decimals(4),
                    )
                    .changed()
                    {
                        self.camera.focus_distance = focus / unit;
                        self.focus.manual();
                        changed = true;
                    }
                    if !self.focus.enabled
                        && ui
                            .selectable_label(self.picking_focus, "Pick focus point")
                            .clicked()
                    {
                        self.picking_focus = !self.picking_focus;
                    }
                    if self.focus.enabled {
                        ui.weak(match self.focus.status {
                            crate::focus::Status::Locked => "Focus locked",
                            crate::focus::Status::Missed => "No surface in focus area · focus kept",
                            _ => "Focusing…",
                        });
                    }
                    let old = self.camera.meters_per_unit;
                    controls::select(
                        ui,
                        "Scene unit",
                        match old {
                            0.001 => "Millimetres",
                            0.01 => "Centimetres",
                            0.0254 => "Inches",
                            _ => "Metres",
                        },
                        |ui| {
                            for (value, name) in [
                                (0.001, "Millimetres"),
                                (0.01, "Centimetres"),
                                (0.0254, "Inches"),
                                (1., "Metres"),
                            ] {
                                ui.selectable_value(&mut self.camera.meters_per_unit, value, name);
                            }
                        },
                    );
                    changed |= old != self.camera.meters_per_unit;
                    if self.picking_focus {
                        ui.weak("Click a surface in the viewport to focus.");
                    }
                }
            });
            if self.camera.orthographic {
                self.picking_focus = false;
                ui.weak("Orthographic views have no depth of field.");
            }
        });
        if changed {
            self.dirty(Change::Camera);
        }
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
                self.update_resolution(&ctx, available);
                let dock_rect = self.render_dock(&ctx, ui.max_rect());
                let aspect = self.pixel_size[0] as f32 / self.pixel_size[1] as f32;
                let width = available.x.min(available.y * aspect);
                let size = egui::vec2(width, width / aspect);
                let rect = egui::Rect::from_center_size(ui.max_rect().center(), size);
                if !self.environment.background && self.environment.background_alpha == 0. {
                    let checker = self.checker.get_or_insert_with(|| {
                        ctx.load_texture(
                            "Transparency checker",
                            egui::ColorImage::new(
                                [2, 2],
                                vec![
                                    egui::Color32::from_gray(38),
                                    egui::Color32::from_gray(48),
                                    egui::Color32::from_gray(48),
                                    egui::Color32::from_gray(38),
                                ],
                            ),
                            egui::TextureOptions {
                                wrap_mode: egui::TextureWrapMode::Repeat,
                                ..egui::TextureOptions::NEAREST
                            },
                        )
                    });
                    ui.painter().image(
                        checker.id(),
                        rect,
                        egui::Rect::from_min_size(egui::Pos2::ZERO, rect.size() / 24.),
                        egui::Color32::WHITE,
                    );
                }
                if let Some(texture) = self
                    .gpu_texture
                    .as_ref()
                    .map(|(id, _)| *id)
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
                if self.picking_focus && response.hovered() {
                    ctx.set_cursor_icon(egui::CursorIcon::Crosshair);
                }
                if self.picking_focus && ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
                    self.picking_focus = false;
                }
                let focus_drag = self.focus.frame(ui, rect, &self.camera);
                if focus_drag {
                    self.drag = crate::input::ViewportDrag::default();
                }
                for (pan, delta) in ui.input(|i| {
                    self.drag.motion(
                        rect,
                        !focus_drag && response.contains_pointer(),
                        dock_rect,
                        i,
                    )
                }) {
                    if pan {
                        self.camera.pan([delta.x, delta.y]);
                    } else {
                        self.camera.orbit([delta.x, delta.y]);
                    }
                    self.dirty(Change::Camera);
                }
                if let Some(pos) = self
                    .drag
                    .take_click()
                    .filter(|p| rect.contains(*p) && !dock_rect.contains(*p))
                {
                    let uv = [
                        (pos.x - rect.min.x) / rect.width(),
                        (pos.y - rect.min.y) / rect.height(),
                    ];
                    if self.picking_focus {
                        if let Some((_, point)) = self.model.pick_hit(&self.camera, uv, aspect) {
                            let forward = (self.camera.target - self.camera.eye()).normalize();
                            self.camera.focus_distance =
                                (point - self.camera.eye()).dot(forward).max(1e-5);
                            self.picking_focus = false;
                            self.dirty(Change::Camera);
                        }
                    } else {
                        self.selected_mesh = self.model.pick(&self.camera, uv, aspect);
                        if let Some(id) = self.selected_mesh {
                            self.selected = self.model.meshes[id].material;
                            self.tab = 1;
                            self.inspector_open = true;
                        }
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
                if response.hovered()
                    && !dock_rect.contains(ctx.pointer_hover_pos().unwrap_or(egui::Pos2::ZERO))
                {
                    let scroll = ui.input(|i| i.smooth_scroll_delta.y);
                    if scroll != 0. {
                        self.camera.zoom(scroll);
                        self.dirty(Change::Camera);
                    }
                }
            });
        if ctx.input(|i| i.key_pressed(egui::Key::F)) && !ctx.egui_wants_keyboard_input() {
            self.camera.frame(self.model.center, self.model.radius);
            self.dirty(Change::Camera);
        }
    }
}
