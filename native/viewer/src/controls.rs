//! Small egui wrappers for the native viewer. Keep egui's input, focus and value
//! editing behavior; only the switch and category glyphs need custom painting.
use crate::theme;
use eframe::egui::{self, Align2, Color32, FontId, Response, Sense, Stroke, Ui};

pub fn button(ui: &mut Ui, label: &str) -> Response {
    ui.add(egui::Button::new(label).min_size(egui::vec2(0., 24.)))
}

pub fn section(ui: &mut Ui, title: &str, contents: impl FnOnce(&mut Ui)) {
    egui::CollapsingHeader::new(egui::RichText::new(title).strong())
        .default_open(true)
        .show_unindented(ui, contents);
    ui.separator();
}

fn property<R>(ui: &mut Ui, label: &str, contents: impl FnOnce(&mut Ui, egui::Id) -> R) -> R {
    ui.push_id(label, |ui| {
        egui::Frame::new()
            .fill(theme::INPUT)
            .stroke(Stroke::new(1., theme::BORDER))
            .corner_radius(5)
            .inner_margin(egui::Margin::symmetric(7, 0))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                let label_width = (ui.available_width() * 0.37).min(104.);
                ui.horizontal(|ui| {
                    let label = ui
                        .allocate_ui_with_layout(
                            egui::vec2(label_width, 24.),
                            egui::Layout::left_to_right(egui::Align::Center),
                            |ui| {
                                ui.set_min_width(label_width);
                                ui.add(
                                    egui::Label::new(
                                        egui::RichText::new(label).size(11.).color(theme::MUTED),
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

pub fn parameter(ui: &mut Ui, label: &str, slider: egui::Slider<'_>) -> Response {
    property(ui, label, |ui, label_id| {
        ui.spacing_mut().interact_size = egui::vec2(36., 18.);
        ui.spacing_mut().button_padding = egui::vec2(3., 1.);
        ui.spacing_mut().slider_width = (ui.available_width() - 50.).max(24.);
        ui.visuals_mut().selection.bg_fill = theme::SUBTLE;
        ui.add(slider.handle_shape(egui::style::HandleShape::Rect { aspect_ratio: 0.16 }))
            .labelled_by(label_id)
    })
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
    property(ui, label, |ui, label_id| {
        ui.color_edit_button_rgb(value).labelled_by(label_id)
    })
}

pub fn toggle(ui: &mut Ui, label: &str, value: &mut bool) -> Response {
    let (rect, mut response) =
        ui.allocate_exact_size(egui::vec2(ui.available_width(), 24.), Sense::click());
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
        rect.right_center() - egui::vec2(14., 0.),
        egui::vec2(28., 14.),
    );
    painter.rect_filled(
        track,
        9,
        if *value {
            theme::ACCENT
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
                track.right() - 7.
            } else {
                track.left() + 7.
            },
            track.center().y,
        ),
        5.,
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

pub fn category(ui: &mut Ui, label: &str, icon: Icon, selected: bool) -> Response {
    let response = ui.add_sized(
        [ui.available_width(), 44.],
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
    let center = response.rect.center_top() + egui::vec2(0., 15.);
    paint_icon(ui, center, icon, color);
    ui.painter().text(
        response.rect.center_bottom() - egui::vec2(0., 5.),
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
