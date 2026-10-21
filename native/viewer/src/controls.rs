//! Small egui wrappers for the native viewer. Keep egui's input, focus and value
//! editing behavior, with the Web viewer's full-row controls and visual hierarchy.
use crate::theme;
use eframe::egui::{self, Align2, Color32, FontId, Response, Sense, Stroke, Ui};

pub fn button(ui: &mut Ui, label: &str) -> Response {
    ui.add(egui::Button::new(label).min_size(egui::vec2(0., 24.)))
}

pub fn section(ui: &mut Ui, title: &str, contents: impl FnOnce(&mut Ui)) {
    section_open(ui, title, true, contents);
}

pub fn section_open(ui: &mut Ui, title: &str, open: bool, contents: impl FnOnce(&mut Ui)) {
    ui.push_id(title, |ui| {
        ui.spacing_mut().item_spacing.y = 0.;
        let mut state = egui::collapsing_header::CollapsingState::load_with_default_open(
            ui.ctx(),
            ui.id().with("open"),
            open,
        );
        let (rect, response) =
            ui.allocate_exact_size(egui::vec2(ui.available_width(), 34.), Sense::click());
        if response.clicked() {
            state.toggle(ui);
        }
        response.widget_info(|| {
            egui::WidgetInfo::selected(
                egui::WidgetType::CollapsingHeader,
                ui.is_enabled(),
                state.is_open(),
                title,
            )
        });
        if response.hovered() || response.has_focus() {
            ui.painter().rect_filled(
                rect.shrink2(egui::vec2(0., 3.)),
                6,
                theme::CONTROL.gamma_multiply(0.4),
            );
        }
        ui.painter().text(
            rect.left_center(),
            Align2::LEFT_CENTER,
            title,
            FontId::proportional(11.5),
            if state.is_open() {
                theme::TEXT
            } else {
                theme::MUTED
            },
        );
        let c = rect.right_center() - egui::vec2(8., 0.);
        let offsets = if state.is_open() {
            [
                egui::vec2(-3., -1.5),
                egui::vec2(0., 1.5),
                egui::vec2(3., -1.5),
            ]
        } else {
            [
                egui::vec2(-1.5, -3.),
                egui::vec2(1.5, 0.),
                egui::vec2(-1.5, 3.),
            ]
        };
        ui.painter().add(egui::Shape::line(
            offsets.map(|p| c + p).to_vec(),
            Stroke::new(1., theme::SUBTLE),
        ));
        state.show_body_unindented(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 7.;
            contents(ui);
            ui.add_space(7.);
        });
        ui.add(egui::Separator::default().spacing(0.));
    });
}

fn property<R>(ui: &mut Ui, label: &str, contents: impl FnOnce(&mut Ui, egui::Id) -> R) -> R {
    ui.push_id(label, |ui| {
        egui::Frame::new()
            .fill(theme::INPUT)
            .stroke(Stroke::new(1., theme::BORDER))
            .corner_radius(9)
            .inner_margin(egui::Margin::symmetric(10, 0))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                let label_width = (ui.available_width() * 0.37).min(104.);
                ui.horizontal(|ui| {
                    let label = ui
                        .allocate_ui_with_layout(
                            egui::vec2(label_width, 30.),
                            egui::Layout::left_to_right(egui::Align::Center),
                            |ui| {
                                ui.set_min_width(label_width);
                                ui.add(
                                    egui::Label::new(
                                        egui::RichText::new(label).size(11.).color(theme::SUBTLE),
                                    )
                                    .truncate(),
                                )
                                .on_hover_text(label)
                            },
                        )
                        .inner;
                    ui.visuals_mut().widgets.inactive.weak_bg_fill = Color32::TRANSPARENT;
                    ui.visuals_mut().widgets.inactive.bg_stroke = Stroke::NONE;
                    contents(ui, label.id)
                })
                .inner
            })
            .inner
    })
    .inner
}

/// Visual wrapper only: egui still handles pointer/keyboard input, numeric editing
/// and accessibility. Keep live lens values untouched until an actual edit.
pub struct Scrub<'a, Num: egui::emath::Numeric> {
    value: &'a mut Num,
    range: std::ops::RangeInclusive<Num>,
    logarithmic: bool,
    decimals: usize,
    suffix: &'a str,
    prefix: &'a str,
}
impl<'a, Num: egui::emath::Numeric> Scrub<'a, Num> {
    pub fn new(value: &'a mut Num, range: std::ops::RangeInclusive<Num>) -> Self {
        Self {
            value,
            range,
            logarithmic: false,
            decimals: if Num::INTEGRAL { 0 } else { 2 },
            suffix: "",
            prefix: "",
        }
    }
    pub fn logarithmic(mut self, logarithmic: bool) -> Self {
        self.logarithmic = logarithmic;
        self
    }
    pub fn max_decimals(mut self, decimals: usize) -> Self {
        self.decimals = decimals;
        self
    }
    pub fn suffix(mut self, suffix: &'a str) -> Self {
        self.suffix = suffix;
        self
    }
    pub fn prefix(mut self, prefix: &'a str) -> Self {
        self.prefix = prefix;
        self
    }
}

pub fn parameter<Num: egui::emath::Numeric>(
    ui: &mut Ui,
    label: &str,
    scrub: Scrub<'_, Num>,
) -> Response {
    ui.push_id(label, |ui| {
        let Scrub {
            value,
            range,
            logarithmic,
            decimals,
            suffix,
            prefix,
        } = scrub;
        let min = range.start().to_f64();
        let max = range.end().to_f64();
        let (rect, _) =
            ui.allocate_exact_size(egui::vec2(ui.available_width(), 30.), Sense::hover());
        ui.painter().rect_filled(rect, 9, theme::INPUT);
        let mut response = ui
            .scope_builder(egui::UiBuilder::new().max_rect(rect), |ui| {
                ui.spacing_mut().slider_width = rect.width();
                ui.spacing_mut().interact_size.y = 30.;
                // Paint our full-row fill below; retain the standard slider's interaction.
                let widgets = &mut ui.visuals_mut().widgets;
                for visuals in [
                    &mut widgets.inactive,
                    &mut widgets.hovered,
                    &mut widgets.active,
                ] {
                    visuals.bg_fill = Color32::TRANSPARENT;
                    visuals.fg_stroke = Stroke::NONE;
                }
                ui.add(
                    egui::Slider::new(&mut *value, range.clone())
                        .show_value(false)
                        .logarithmic(logarithmic)
                        .max_decimals(decimals)
                        .clamping(egui::SliderClamping::Edits)
                        .trailing_fill(false)
                        .handle_shape(egui::style::HandleShape::Rect { aspect_ratio: 0.08 }),
                )
            })
            .inner;
        let v = value.to_f64();
        let fraction = if logarithmic {
            (v / min).ln() / (max / min).ln()
        } else {
            (v - min) / (max - min)
        };
        let x = egui::lerp(rect.x_range(), fraction.clamp(0., 1.) as f32);
        if x > rect.left() {
            ui.painter()
                .with_clip_rect(rect.intersect(egui::Rect::from_min_max(
                    rect.min,
                    egui::pos2(x, rect.bottom()),
                )))
                .rect_filled(rect, 9, theme::SCRUB_FILL);
        }
        if x > rect.left() + 2. && x < rect.right() - 2. {
            ui.painter().line_segment(
                [
                    egui::pos2(x, rect.top() + 7.),
                    egui::pos2(x, rect.bottom() - 7.),
                ],
                Stroke::new(1.5, theme::MUTED),
            );
        }
        let value_width = (rect.width() * 0.36).clamp(66., 100.);
        let text = egui::WidgetText::from(egui::RichText::new(label).size(11.).color(theme::TEXT))
            .into_galley(
                ui,
                Some(egui::TextWrapMode::Truncate),
                (rect.width() - value_width - 22.).max(1.),
                egui::TextStyle::Body,
            );
        ui.painter().galley(
            rect.left_center() + egui::vec2(10., -text.size().y * 0.5),
            text,
            theme::TEXT,
        );
        let numeric = egui::Rect::from_center_size(
            rect.right_center() - egui::vec2(value_width * 0.5 + 4., 0.),
            egui::vec2(value_width, 24.),
        );
        let edit = ui
            .scope_builder(egui::UiBuilder::new().max_rect(numeric), |ui| {
                ui.spacing_mut().button_padding = egui::vec2(2., 1.);
                ui.visuals_mut().widgets.inactive.weak_bg_fill = Color32::TRANSPARENT;
                ui.visuals_mut().widgets.inactive.bg_stroke = Stroke::NONE;
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.add(
                        egui::DragValue::new(&mut *value)
                            .range(range)
                            .clamp_existing_to_range(false)
                            .speed((max - min) / rect.width() as f64)
                            .max_decimals(decimals)
                            .prefix(prefix)
                            .suffix(suffix),
                    )
                })
                .inner
            })
            .inner;
        if edit.changed() {
            response.mark_changed();
        }
        let border = if response.has_focus() || edit.has_focus() {
            theme::ACCENT
        } else if response.hovered() || edit.hovered() {
            theme::CONTROL_BORDER_HOVER
        } else {
            theme::BORDER
        };
        ui.painter()
            .rect_stroke(rect, 9, Stroke::new(1., border), egui::StrokeKind::Inside);
        response.widget_info(|| egui::WidgetInfo::slider(ui.is_enabled(), value.to_f64(), label));
        response.union(edit).on_hover_text(label)
    })
    .inner
}

pub fn scalar(
    ui: &mut Ui,
    label: &str,
    value: &mut f32,
    range: std::ops::RangeInclusive<f32>,
) -> bool {
    parameter(ui, label, Scrub::new(value, range)).changed()
}

pub fn segmented<T: Copy + PartialEq>(
    ui: &mut Ui,
    label: &str,
    value: &mut T,
    options: &[(T, &str)],
) -> bool {
    let mut changed = false;
    ui.push_id(label, |ui| {
        egui::Frame::new()
            .fill(theme::INPUT)
            .stroke(Stroke::new(1., theme::BORDER))
            .corner_radius(10)
            .inner_margin(3)
            .show(ui, |ui| {
                let width =
                    (ui.available_width() - 3. * (options.len() - 1) as f32) / options.len() as f32;
                ui.spacing_mut().item_spacing.x = 3.;
                ui.horizontal(|ui| {
                    for &(option, text) in options {
                        let selected = *value == option;
                        let response = ui.add_sized(
                            [width, 24.],
                            egui::Button::new(
                                egui::RichText::new(text).size(11.).color(if selected {
                                    theme::TEXT
                                } else {
                                    theme::SUBTLE
                                }),
                            )
                            .fill(if selected {
                                theme::CONTROL
                            } else {
                                Color32::TRANSPARENT
                            })
                            .stroke(if selected {
                                Stroke::new(1., theme::CONTROL_BORDER_HOVER)
                            } else {
                                Stroke::NONE
                            })
                            .corner_radius(7),
                        );
                        if response.clicked() && !selected {
                            *value = option;
                            changed = true;
                        }
                    }
                });
            });
    });
    changed
}

pub fn number(ui: &mut Ui, label: &str, value: &mut f32, speed: f64) -> Response {
    property(ui, label, |ui, label_id| {
        ui.add_sized(
            [ui.available_width(), 24.],
            egui::DragValue::new(value).speed(speed).range(-1e6..=1e6),
        )
        .labelled_by(label_id)
    })
}

pub fn select(
    ui: &mut Ui,
    label: &str,
    value: impl Into<egui::WidgetText>,
    contents: impl FnOnce(&mut Ui),
) {
    property(ui, label, |ui, label_id| {
        egui::ComboBox::from_id_salt("choice")
            .selected_text(value)
            .width(ui.available_width())
            .wrap_mode(egui::TextWrapMode::Truncate)
            .show_ui(ui, contents)
            .response
            .labelled_by(label_id);
    });
}

pub fn color(ui: &mut Ui, label: &str, value: &mut [f32; 3]) -> Response {
    ui.push_id(label, |ui| {
        egui::Frame::new()
            .fill(theme::INPUT)
            .stroke(Stroke::new(1., theme::BORDER))
            .corner_radius(9)
            .inner_margin(egui::Margin::symmetric(4, 3))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().interact_size = egui::vec2(22., 22.);
                    let mut edited = *value;
                    let response = ui.color_edit_button_rgb(&mut edited);
                    if response.changed() {
                        *value = edited;
                    }
                    ui.label(egui::RichText::new(label).size(11.));
                    let color: Color32 = egui::Rgba::from_rgb(value[0], value[1], value[2]).into();
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(
                            egui::RichText::new(format!(
                                "#{:02X}{:02X}{:02X}",
                                color.r(),
                                color.g(),
                                color.b()
                            ))
                            .monospace()
                            .size(10.5)
                            .color(theme::SUBTLE),
                        );
                    });
                    response.on_hover_text(label)
                })
                .inner
            })
            .inner
    })
    .inner
}

pub fn toggle(ui: &mut Ui, label: &str, value: &mut bool) -> Response {
    let (rect, mut response) =
        ui.allocate_exact_size(egui::vec2(ui.available_width(), 30.), Sense::click());
    if response.clicked() {
        *value = !*value;
        response.mark_changed();
    }
    response.widget_info(|| {
        egui::WidgetInfo::selected(egui::WidgetType::Checkbox, ui.is_enabled(), *value, label)
    });
    let painter = ui.painter();
    painter.text(
        rect.left_center(),
        Align2::LEFT_CENTER,
        label,
        FontId::proportional(11.),
        theme::MUTED,
    );
    let track = egui::Rect::from_center_size(
        rect.right_center() - egui::vec2(17., 0.),
        egui::vec2(34., 20.),
    );
    painter.rect_filled(
        track,
        9,
        if *value {
            theme::ACCENT_SOLID
        } else {
            theme::CONTROL
        },
    );
    if response.has_focus() || response.hovered() {
        painter.rect_stroke(
            track.expand(2.),
            11,
            Stroke::new(1., theme::ACCENT),
            egui::StrokeKind::Outside,
        );
    }
    painter.circle_filled(
        egui::pos2(
            if *value {
                track.right() - 10.
            } else {
                track.left() + 10.
            },
            track.center().y,
        ),
        8.,
        theme::TEXT,
    );
    response
}

#[derive(Clone, Copy)]
pub enum Icon {
    Lighting,
    Material,
    Camera,
    Render,
    Object,
}

pub fn preset_card(ui: &mut Ui, width: f32, name: &str, detail: &str, selected: bool) -> Response {
    let response = ui.add_sized(
        [width, 44.],
        egui::Button::new("")
            .fill(if selected {
                theme::ACCENT_SURFACE
            } else {
                theme::INPUT
            })
            .stroke(Stroke::new(
                1.,
                if selected {
                    theme::ACCENT
                } else {
                    theme::BORDER
                },
            ))
            .corner_radius(9),
    );
    response.widget_info(|| {
        egui::WidgetInfo::selected(
            egui::WidgetType::RadioButton,
            ui.is_enabled(),
            selected,
            name,
        )
    });
    for (text, y, size, color) in [
        (name, 7., 11., theme::TEXT),
        (detail, 24., 9.5, theme::SUBTLE),
    ] {
        let galley = egui::WidgetText::from(egui::RichText::new(text).size(size).color(color))
            .into_galley(
                ui,
                Some(egui::TextWrapMode::Truncate),
                (width - 16.).max(1.),
                egui::TextStyle::Body,
            );
        ui.painter()
            .galley(response.rect.left_top() + egui::vec2(8., y), galley, color);
    }
    response.on_hover_text(format!("{name} · {detail}"))
}

pub fn heading(ui: &mut Ui, title: &str, subtitle: &str, icon: Icon) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 44.), Sense::hover());
    let badge = egui::Rect::from_min_size(rect.left_top(), egui::vec2(32., 32.));
    ui.painter().rect_filled(badge, 10, theme::ACCENT_SURFACE);
    ui.painter().rect_stroke(
        badge,
        10,
        Stroke::new(1., theme::ACCENT.gamma_multiply(0.35)),
        egui::StrokeKind::Inside,
    );
    paint_icon(ui, badge.center(), icon, theme::ACCENT);
    ui.painter().text(
        rect.left_top() + egui::vec2(42., 1.),
        Align2::LEFT_TOP,
        title,
        FontId::proportional(13.),
        theme::TEXT,
    );
    let text = egui::WidgetText::from(
        egui::RichText::new(subtitle)
            .size(10.5)
            .color(theme::SUBTLE),
    )
    .into_galley(
        ui,
        Some(egui::TextWrapMode::Truncate),
        (rect.width() - 42.).max(1.),
        egui::TextStyle::Small,
    );
    ui.painter()
        .galley(rect.left_top() + egui::vec2(42., 19.), text, theme::SUBTLE);
}

pub fn category(ui: &mut Ui, label: &str, icon: Icon, selected: bool) -> Response {
    let response = ui.add_sized(
        [ui.available_width(), 54.],
        egui::Button::selectable(selected, "").corner_radius(6),
    );
    response.widget_info(|| {
        egui::WidgetInfo::selected(
            egui::WidgetType::SelectableLabel,
            ui.is_enabled(),
            selected,
            label,
        )
    });
    let color = if selected {
        theme::ACCENT
    } else if response.hovered() {
        theme::TEXT
    } else {
        theme::SUBTLE
    };
    let center = response.rect.center_top() + egui::vec2(0., 18.);
    paint_icon(ui, center, icon, color);
    ui.painter().text(
        response.rect.center_bottom() - egui::vec2(0., 8.),
        Align2::CENTER_BOTTOM,
        label,
        FontId::proportional(9.),
        color,
    );
    response.on_hover_text(label)
}

pub fn tree_row(ui: &mut Ui, name: &str, material: &str, selected: bool) -> Response {
    let response = ui.add_sized(
        [ui.available_width(), 26.],
        egui::Button::selectable(selected, "").corner_radius(5),
    );
    response.widget_info(|| {
        egui::WidgetInfo::selected(
            egui::WidgetType::SelectableLabel,
            ui.is_enabled(),
            selected,
            name,
        )
    });
    let color = if selected {
        theme::ACCENT
    } else {
        theme::MUTED
    };
    paint_icon(
        ui,
        response.rect.left_center() + egui::vec2(13., 0.),
        Icon::Object,
        color,
    );
    let galley = egui::WidgetText::from(name).into_galley(
        ui,
        Some(egui::TextWrapMode::Truncate),
        (response.rect.width() - 40.).max(0.),
        egui::TextStyle::Button,
    );
    ui.painter().galley(
        response.rect.left_center() + egui::vec2(28., -galley.size().y * 0.5),
        galley,
        color,
    );
    response.on_hover_text(format!("{name}\n{material}"))
}

fn paint_icon(ui: &Ui, center: egui::Pos2, icon: Icon, color: Color32) {
    let painter = ui.painter();
    let stroke = Stroke::new(1.2, color);
    let rect = egui::Rect::from_center_size(center, egui::vec2(16., 14.));
    match icon {
        Icon::Lighting => {
            painter.circle_stroke(center, 4., stroke);
            for i in 0..8 {
                let d = egui::Vec2::angled(i as f32 * std::f32::consts::TAU / 8.);
                painter.line_segment([center + d * 6., center + d * 8.], stroke);
            }
        }
        Icon::Material => {
            painter.circle_stroke(center, 7., stroke);
            for offset in [
                egui::vec2(-3., -2.),
                egui::vec2(3., -2.),
                egui::vec2(0., 3.),
            ] {
                painter.circle_filled(center + offset, 1.4, color);
            }
        }
        Icon::Camera => {
            painter.rect_stroke(rect, 3, stroke, egui::StrokeKind::Inside);
            painter.circle_stroke(center, 3.5, stroke);
            painter.line_segment(
                [center + egui::vec2(-4., -9.), center + egui::vec2(3., -9.)],
                stroke,
            );
        }
        Icon::Render => {
            painter.circle_stroke(center, 7., stroke);
            for i in 0..6 {
                let d = egui::Vec2::angled(i as f32 * std::f32::consts::TAU / 6.);
                let side = egui::Vec2::angled((i + 1) as f32 * std::f32::consts::TAU / 6.);
                painter.line_segment([center + d * 7., center + side * 3.], stroke);
            }
        }
        Icon::Object => {
            let top = center - egui::vec2(0., 8.);
            let left = center - egui::vec2(7., 4.);
            let right = center + egui::vec2(7., -4.);
            let bottom = center + egui::vec2(0., 8.);
            painter.add(egui::Shape::closed_line(
                vec![
                    top,
                    right,
                    right + egui::vec2(0., 8.),
                    bottom,
                    left + egui::vec2(0., 8.),
                    left,
                ],
                stroke,
            ));
            for (a, b) in [(left, center), (right, center), (center, bottom)] {
                painter.line_segment([a, b], stroke);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use egui::{Context, Event, Key, Modifiers, PointerButton, RawInput};

    fn draw(ctx: &Context, value: &mut bool, enabled: bool, events: Vec<Event>) -> Response {
        let mut response = None;
        let mut output = ctx.run_ui(
            RawInput {
                events,
                ..Default::default()
            },
            |root| {
                egui::CentralPanel::default().show(root, |ui| {
                    ui.set_width(280.);
                    ui.add_enabled_ui(enabled, |ui| {
                        response = Some(toggle(ui, "Native OIDN", value));
                    });
                });
            },
        );
        output.textures_delta.clear();
        response.unwrap()
    }

    #[test]
    fn full_row_scrub_preserves_idle_values_and_accepts_pointer_and_keyboard_edits() {
        fn draw_scrub(ctx: &Context, value: &mut f32, events: Vec<Event>) -> Response {
            let mut response = None;
            let mut output = ctx.run_ui(
                RawInput {
                    events,
                    ..Default::default()
                },
                |root| {
                    egui::CentralPanel::default().show(root, |ui| {
                        ui.set_width(280.);
                        response = Some(parameter(
                            ui,
                            "Live focus",
                            Scrub::new(value, 0.01..=10.).max_decimals(2),
                        ));
                        let mut color = [0.1234567, 0.7654321, 0.2345678];
                        let before = color;
                        assert!(!super::color(ui, "Color", &mut color).changed());
                        assert_eq!(color, before);
                    });
                },
            );
            output.textures_delta.clear();
            response.unwrap()
        }
        let ctx = Context::default();
        let mut value = 0.1234567;
        let response = draw_scrub(&ctx, &mut value, vec![]);
        assert!(!response.changed());
        assert_eq!(value, 0.1234567);
        let pos = response.rect.left_center() + egui::vec2(response.rect.width() * 0.25, 0.);
        draw_scrub(
            &ctx,
            &mut value,
            vec![
                Event::PointerMoved(pos),
                Event::PointerButton {
                    pos,
                    button: PointerButton::Primary,
                    pressed: true,
                    modifiers: Modifiers::NONE,
                },
            ],
        );
        let response = draw_scrub(
            &ctx,
            &mut value,
            vec![Event::PointerButton {
                pos,
                button: PointerButton::Primary,
                pressed: false,
                modifiers: Modifiers::NONE,
            }],
        );
        assert!(
            (value - 2.5).abs() < 0.1,
            "Full-row pointer position: {value}"
        );
        ctx.memory_mut(|m| m.request_focus(response.id));
        let before = value;
        let response = draw_scrub(
            &ctx,
            &mut value,
            vec![Event::Key {
                key: Key::ArrowRight,
                physical_key: None,
                pressed: true,
                repeat: false,
                modifiers: Modifiers::NONE,
            }],
        );
        assert!(response.changed() && value > before);
    }

    #[test]
    fn switch_click_updates_once_on_release_and_respects_disabled_state() {
        for enabled in [true, false] {
            let ctx = Context::default();
            let mut value = false;
            let pos = draw(&ctx, &mut value, enabled, vec![]).rect.center();
            let pressed = draw(
                &ctx,
                &mut value,
                enabled,
                vec![
                    Event::PointerMoved(pos),
                    Event::PointerButton {
                        pos,
                        button: PointerButton::Primary,
                        pressed: true,
                        modifiers: Modifiers::NONE,
                    },
                ],
            );
            assert!(!value);
            assert!(!pressed.changed());
            let released = draw(
                &ctx,
                &mut value,
                enabled,
                vec![Event::PointerButton {
                    pos,
                    button: PointerButton::Primary,
                    pressed: false,
                    modifiers: Modifiers::NONE,
                }],
            );
            assert_eq!(value, enabled);
            assert_eq!(released.changed(), enabled);
            assert!(!draw(&ctx, &mut value, enabled, vec![]).changed());
        }
    }

    #[test]
    fn focused_switch_accepts_space_and_disabled_switch_ignores_it() {
        for enabled in [true, false] {
            let ctx = Context::default();
            let mut value = false;
            let response = draw(&ctx, &mut value, enabled, vec![]);
            ctx.memory_mut(|m| m.request_focus(response.id));
            let mut changes = 0;
            for pressed in [true, false] {
                changes += usize::from(
                    draw(
                        &ctx,
                        &mut value,
                        enabled,
                        vec![Event::Key {
                            key: Key::Space,
                            physical_key: None,
                            pressed,
                            repeat: false,
                            modifiers: Modifiers::NONE,
                        }],
                    )
                    .changed(),
                );
            }
            assert_eq!(value, enabled);
            assert_eq!(changes, usize::from(enabled));
        }
    }
}
