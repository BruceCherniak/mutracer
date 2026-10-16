use eframe::egui::{Event, InputState, PointerButton, Pos2, Rect, Vec2};

#[derive(Default)]
pub struct ViewportDrag {
    active: Option<(PointerButton, Pos2, bool, Pos2, bool)>,
    click: Option<Pos2>,
}
impl ViewportDrag {
    pub fn take_click(&mut self) -> Option<Pos2> {
        self.click.take()
    }
    // Process ordered events: an entire fast drag can arrive in one UI frame,
    // in which case egui's frame-level dragged/drag_stopped flags are both false.
    pub fn motion(&mut self, rect: Rect, can_start: bool, input: &InputState) -> Vec<(bool, Vec2)> {
        self.click = None;
        let mut motion = Vec::new();
        for event in &input.events {
            match *event {
                Event::PointerButton {
                    pos,
                    button,
                    pressed: true,
                    modifiers,
                } if can_start
                    && rect.contains(pos)
                    && self.active.is_none()
                    && matches!(
                        button,
                        PointerButton::Primary | PointerButton::Secondary | PointerButton::Middle
                    ) =>
                {
                    self.active = Some((
                        button,
                        pos,
                        button != PointerButton::Primary || modifiers.shift,
                        pos,
                        false,
                    ));
                }
                Event::PointerMoved(pos) => self.move_to(pos, input.modifiers.shift, &mut motion),
                Event::PointerButton {
                    pos,
                    button,
                    pressed: false,
                    ..
                } if self.active.is_some_and(|active| active.0 == button) => {
                    self.move_to(pos, input.modifiers.shift, &mut motion);
                    if self.active.is_some_and(|(button, _, pan, _, moved)| {
                        button == PointerButton::Primary && !pan && !moved
                    }) {
                        self.click = Some(pos);
                    }
                    self.active = None;
                }
                Event::PointerGone | Event::WindowFocused(false) => self.active = None,
                _ => {}
            }
        }
        motion
    }
    fn move_to(&mut self, pos: Pos2, shift: bool, motion: &mut Vec<(bool, Vec2)>) {
        if let Some((_, last, pan, origin, moved)) = &mut self.active {
            *moved |= pos.distance(*origin) > 4.;
            let delta = pos - *last;
            *last = pos;
            if delta != Vec2::ZERO {
                motion.push((*pan || shift, delta));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eframe::egui;
    fn frame(
        ctx: &egui::Context,
        drag: &mut ViewportDrag,
        events: Vec<Event>,
    ) -> Vec<(bool, Vec2)> {
        let mut motion = vec![];
        let _ = ctx.run(
            egui::RawInput {
                events,
                ..Default::default()
            },
            |ctx| {
                egui::CentralPanel::default().show(ctx, |ui| {
                    let rect = Rect::from_min_max(egui::pos2(10., 10.), egui::pos2(300., 300.));
                    let response = ui.interact(rect, ui.id().with("viewport"), egui::Sense::drag());
                    motion = ui.input(|i| drag.motion(rect, response.contains_pointer(), i));
                });
            },
        );
        motion
    }
    fn button(pos: Pos2, button: PointerButton, pressed: bool, shift: bool) -> Event {
        Event::PointerButton {
            pos,
            button,
            pressed,
            modifiers: egui::Modifiers {
                shift,
                ..Default::default()
            },
        }
    }
    #[test]
    fn fast_orbit_and_pan_work_with_coalesced_and_separate_frames() {
        for combined in [false, true] {
            for (button_id, shift, pan) in [
                (PointerButton::Primary, false, false),
                (PointerButton::Secondary, false, true),
                (PointerButton::Primary, true, true),
            ] {
                let ctx = egui::Context::default();
                let mut drag = ViewportDrag::default();
                frame(&ctx, &mut drag, vec![]);
                let start = egui::pos2(50., 60.);
                let end = egui::pos2(110., 90.);
                let mut events = vec![
                    Event::PointerMoved(start),
                    button(start, button_id, true, shift),
                ];
                if !combined {
                    assert!(frame(&ctx, &mut drag, std::mem::take(&mut events)).is_empty());
                }
                events.extend([
                    Event::PointerMoved(end),
                    button(end, button_id, false, shift),
                ]);
                assert_eq!(
                    frame(&ctx, &mut drag, events),
                    vec![(pan, egui::vec2(60., 30.))]
                );
                assert!(frame(&ctx, &mut drag, vec![Event::PointerMoved(start)]).is_empty());
            }
        }
    }
    #[test]
    fn click_is_distinct_from_drag_pan_and_focus_loss() {
        for combined in [false, true] {
            let ctx = egui::Context::default();
            let mut drag = ViewportDrag::default();
            frame(&ctx, &mut drag, vec![]);
            let p = egui::pos2(60., 60.);
            let mut events = vec![
                Event::PointerMoved(p),
                button(p, PointerButton::Primary, true, false),
            ];
            if !combined {
                frame(&ctx, &mut drag, std::mem::take(&mut events));
            }
            events.push(button(p, PointerButton::Primary, false, false));
            frame(&ctx, &mut drag, events);
            assert_eq!(drag.take_click(), Some(p));
            assert_eq!(drag.take_click(), None);
            frame(
                &ctx,
                &mut drag,
                vec![
                    button(p, PointerButton::Primary, true, false),
                    Event::PointerMoved(egui::pos2(100., 80.)),
                    button(p, PointerButton::Primary, false, false),
                ],
            );
            assert_eq!(drag.take_click(), None);
            frame(
                &ctx,
                &mut drag,
                vec![
                    button(p, PointerButton::Secondary, true, false),
                    button(p, PointerButton::Secondary, false, false),
                ],
            );
            assert_eq!(drag.take_click(), None);
            frame(
                &ctx,
                &mut drag,
                vec![
                    button(p, PointerButton::Primary, true, false),
                    Event::WindowFocused(false),
                    button(p, PointerButton::Primary, false, false),
                ],
            );
            assert_eq!(drag.take_click(), None);
        }
    }
    #[test]
    fn stationary_press_and_outside_drag_do_not_move_camera() {
        let ctx = egui::Context::default();
        let mut drag = ViewportDrag::default();
        frame(
            &ctx,
            &mut drag,
            vec![Event::PointerMoved(egui::pos2(400., 400.))],
        );
        let inside = egui::pos2(50., 60.);
        assert!(
            frame(
                &ctx,
                &mut drag,
                vec![
                    Event::PointerMoved(inside),
                    button(inside, PointerButton::Primary, true, false)
                ]
            )
            .is_empty()
        );
        assert!(
            frame(
                &ctx,
                &mut drag,
                vec![button(inside, PointerButton::Primary, false, false)]
            )
            .is_empty()
        );
        let outside = egui::pos2(400., 400.);
        assert!(
            frame(
                &ctx,
                &mut drag,
                vec![
                    Event::PointerMoved(outside),
                    button(outside, PointerButton::Primary, true, false)
                ]
            )
            .is_empty()
        );
        assert!(
            frame(
                &ctx,
                &mut drag,
                vec![
                    Event::PointerMoved(inside),
                    button(inside, PointerButton::Primary, false, false)
                ]
            )
            .is_empty()
        );
    }
}
