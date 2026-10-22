//! Viewport render dock, sharing the inspector's settings and native commit path.
use crate::{Change, Viewer, resolution, theme};
use eframe::egui::{self, Align2, Color32, FontId, Sense, Stroke};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
enum Action {
    Pause,
    Play,
    Restart,
    Settings,
}
fn action(ui: &mut egui::Ui, label: &str, icon: Action) -> egui::Response {
    let response = ui.add_sized(
        [24., 28.],
        egui::Button::new("").frame(false).corner_radius(7),
    );
    response.widget_info(|| {
        egui::WidgetInfo::labeled(egui::WidgetType::Button, ui.is_enabled(), label)
    });
    let c = response.rect.center();
    let p = ui.painter();
    let stroke = Stroke::new(1.3, theme::MUTED);
    match icon {
        Action::Pause => {
            for x in [-2.5, 2.5] {
                p.line_segment(
                    [c + egui::vec2(x, -5.), c + egui::vec2(x, 5.)],
                    Stroke::new(2.2, theme::MUTED),
                );
            }
        }
        Action::Play => {
            p.add(egui::Shape::convex_polygon(
                vec![
                    c + egui::vec2(-3., -5.),
                    c + egui::vec2(5., 0.),
                    c + egui::vec2(-3., 5.),
                ],
                theme::MUTED,
                Stroke::NONE,
            ));
        }
        Action::Restart => {
            let points = (0..24)
                .map(|i| c + egui::Vec2::angled(i as f32 / 23. * 5.2 + 0.5) * 5.5)
                .collect();
            p.add(egui::Shape::line(points, stroke));
            p.add(egui::Shape::line(
                vec![
                    c + egui::vec2(6., -6.),
                    c + egui::vec2(6., -1.),
                    c + egui::vec2(1., -1.),
                ],
                stroke,
            ));
        }
        Action::Settings => {
            for (y, x) in [(-4., -2.), (0., 3.), (4., -1.)] {
                p.line_segment([c + egui::vec2(-6., y), c + egui::vec2(6., y)], stroke);
                p.circle_filled(c + egui::vec2(x, y), 2., theme::SUBTLE);
            }
        }
    }
    response.on_hover_text(label)
}
impl Viewer {
    pub(super) fn update_resolution(&mut self, ctx: &egui::Context, viewport: egui::Vec2) {
        if let Some(size) = self.resolution.update(
            viewport,
            ctx.pixels_per_point(),
            self.size,
            ctx.input(|i| i.pointer.any_down()),
            Instant::now(),
        ) {
            self.size = size;
            self.dirty(Change::Scene);
        }
        if self.resolution.pending(self.size) {
            ctx.request_repaint_after(Duration::from_millis(16));
        }
    }
    pub(super) fn resolution_label(&self) -> String {
        match self.resolution.scale {
            Some(scale) => format!("{:.0}% · {} × {}", scale * 100., self.size[0], self.size[1]),
            None => match resolution::fixed_name(self.size) {
                Some(name) => format!("{name} · {} × {}", self.size[0], self.size[1]),
                None => format!("{} × {}", self.size[0], self.size[1]),
            },
        }
    }
    pub(super) fn resolution_choices(&mut self, ui: &mut egui::Ui) {
        for scale in [0.25, 0.5, 0.75, 1.] {
            let size = self.resolution.scaled(scale);
            ui.selectable_value(
                &mut self.resolution.scale,
                Some(scale),
                format!("{:.0}% · {} × {}", scale * 100., size[0], size[1]),
            );
        }
        ui.separator();
        ui.weak("Fixed pixels");
        for (name, size) in resolution::FIXED {
            if ui
                .selectable_label(
                    self.resolution.scale.is_none() && self.size == size,
                    format!("{name} · {} × {}", size[0], size[1]),
                )
                .clicked()
            {
                self.resolution.scale = None;
                if self.size != size {
                    self.size = size;
                    self.dirty(Change::Scene);
                }
            }
        }
    }
    pub(super) fn render_dock(&mut self, ctx: &egui::Context, viewport: egui::Rect) -> egui::Rect {
        let available = (viewport.width() - 24.).max(1.);
        let compact = available < 440.;
        let width = available.min(if compact { 280. } else { 452. });
        let height = if compact { 80. } else { 46. };
        let position = viewport.center_bottom() - egui::vec2(width * 0.5, height + 12.);
        egui::Area::new(egui::Id::new("render-dock"))
            .order(egui::Order::Foreground)
            .movable(false)
            .constrain(false)
            .default_size(egui::vec2(width, height))
            .fixed_pos(position)
            .show(ctx, |ui| {
                egui::Frame::new()
                    .fill(Color32::from_rgba_unmultiplied(26, 27, 31, 244))
                    .corner_radius(12)
                    .inner_margin(egui::Margin::symmetric(8, 7))
                    .show(ui, |ui| {
                        ui.set_width(width - 16.);
                        ui.spacing_mut().item_spacing = egui::vec2(4., 4.);
                        ui.spacing_mut().interact_size.y = 28.;
                        ui.spacing_mut().button_padding = egui::vec2(5., 2.);
                        ui.spacing_mut().icon_width = 13.;
                        if compact {
                            ui.horizontal(|ui| {
                                self.dock_status(ui);
                            });
                            ui.horizontal(|ui| {
                                self.dock_settings(ui, compact);
                            });
                        } else {
                            ui.horizontal(|ui| {
                                self.dock_status(ui);
                                ui.separator();
                                self.dock_settings(ui, compact);
                            });
                        }
                    });
            })
            .response
            .rect
    }
    fn dock_status(&mut self, ui: &mut egui::Ui) {
        let preparing = self.loading.is_some() || self.preparing() || self.candidate.is_some();
        let done = self.samples >= self.settings.max_samples;
        let label = if self.loading.is_some() {
            "Opening"
        } else if preparing {
            "Preparing"
        } else if !self.running {
            "Paused"
        } else if done {
            "Done"
        } else {
            "Converging"
        };
        let (rect, response) = ui.allocate_exact_size(egui::vec2(26., 28.), Sense::hover());
        let progress = self.samples as f32 / self.settings.max_samples.max(1) as f32;
        response.widget_info(|| {
            egui::WidgetInfo::slider(true, progress as f64 * 100., "Sample progress")
        });
        ui.painter().circle_stroke(
            rect.center(),
            10.,
            Stroke::new(2., Color32::from_white_alpha(25)),
        );
        let color = if done {
            Color32::from_rgb(114, 198, 156)
        } else {
            theme::ACCENT
        };
        let (start, amount) = if preparing {
            (ui.input(|i| i.time as f32 * 4.), 0.28)
        } else {
            (-std::f32::consts::FRAC_PI_2, progress.clamp(0., 1.))
        };
        let points = (0..=32)
            .map(|i| {
                rect.center()
                    + egui::Vec2::angled(start + std::f32::consts::TAU * amount * i as f32 / 32.)
                        * 10.
            })
            .collect();
        ui.painter()
            .add(egui::Shape::line(points, Stroke::new(2., color)));
        if done {
            ui.painter().add(egui::Shape::line(
                vec![
                    rect.center() + egui::vec2(-4., 0.),
                    rect.center() + egui::vec2(-1., 3.),
                    rect.center() + egui::vec2(5., -4.),
                ],
                Stroke::new(1.8, color),
            ));
        }
        if preparing {
            ui.ctx().request_repaint_after(Duration::from_millis(32));
        }
        let (rect, _) = ui.allocate_exact_size(egui::vec2(72., 30.), Sense::hover());
        ui.painter().text(
            rect.left_top(),
            Align2::LEFT_TOP,
            label,
            FontId::proportional(11.5),
            theme::TEXT,
        );
        ui.painter().text(
            rect.left_bottom(),
            Align2::LEFT_BOTTOM,
            format!("{} spp", self.samples),
            FontId::monospace(10.5),
            theme::SUBTLE,
        );
        if action(
            ui,
            if self.running {
                "Pause rendering (Space)"
            } else {
                "Resume rendering (Space)"
            },
            if self.running {
                Action::Pause
            } else {
                Action::Play
            },
        )
        .clicked()
        {
            self.running = !self.running;
        }
        if action(ui, "Restart rendering", Action::Restart).clicked() {
            self.dirty(Change::Reset);
        }
    }
    fn dock_settings(&mut self, ui: &mut egui::Ui, compact: bool) {
        let previous = self.settings.max_samples;
        egui::ComboBox::from_id_salt("dock-samples")
            .width(if compact { 58. } else { 88. })
            .selected_text(if compact {
                previous.to_string()
            } else {
                format!("Samples {}", previous)
            })
            .show_ui(ui, |ui| {
                for value in [
                    4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384,
                ] {
                    ui.selectable_value(&mut self.settings.max_samples, value, value.to_string());
                }
            });
        if previous != self.settings.max_samples {
            self.dirty(Change::Scene);
        }
        let label = self.resolution.scale.map_or_else(
            || {
                resolution::fixed_name(self.size).map_or_else(
                    || format!("{}×{}", self.size[0], self.size[1]),
                    str::to_string,
                )
            },
            |s| {
                if compact {
                    format!("{:.0}%", s * 100.)
                } else {
                    format!("Res {:.0}%", s * 100.)
                }
            },
        );
        egui::ComboBox::from_id_salt("dock-resolution")
            .height(320.)
            .wrap_mode(egui::TextWrapMode::Truncate)
            .width(76.)
            .selected_text(label)
            .show_ui(ui, |ui| self.resolution_choices(ui))
            .response
            .on_hover_text(self.resolution_label());
        ui.checkbox(&mut self.denoise, "Denoise")
            .on_hover_text(&self.denoise_status);
        if action(ui, "Render settings", Action::Settings).clicked() {
            self.tab = 0;
            self.inspector_open = true;
        }
    }
}
