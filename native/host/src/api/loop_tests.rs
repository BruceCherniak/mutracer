use super::render_loop::{
    PreviewFrame, ProgressiveState, loop_status, preview_frame, waits_for_preview,
};
use super::tests::{assert_bytes, expected_descriptor, images, lit_scene, oracle, software_engine};
use super::*;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[test]
fn progressive_state_starts_final_for_isolated_edits() {
    let t0 = Instant::now();
    let ms = |v: u64| t0 + Duration::from_millis(v);
    // An isolated change does not count as motion.
    let one = ProgressiveState::default().update(true, false, ms(0), 150.);
    assert!(one.previous_changed && !one.changing);
    assert_eq!(one.last_continuous_change, None);
    // Consecutive changes do, until the idle delay passes without changes.
    let two = one.update(true, false, ms(10), 150.);
    assert!(two.changing);
    assert_eq!(two.last_continuous_change, Some(ms(10)));
    let quiet = two.update(false, false, ms(150), 150.);
    assert!(quiet.changing && !quiet.previous_changed);
    assert!(!quiet.update(false, false, ms(160), 150.).changing);
    // Sync activity is motion and clears the consecutive-edit timer.
    let active = two.update(true, true, ms(20), 150.);
    assert!(active.changing && !active.previous_changed);
    assert_eq!(active.last_continuous_change, None);
    let released = active.update(false, false, ms(21), 150.);
    assert!(!released.changing);
    // After activity, the next change is isolated again.
    assert!(!released.update(true, false, ms(22), 150.).changing);
    // A negative delay behaves like zero.
    assert!(!two.update(false, false, ms(10), -5.).changing);
    assert!(!two.update(true, false, ms(11), 0.).changing);
}

#[test]
fn preview_frame_and_presentation_decisions_follow_the_browser_tick() {
    let converging = Some((RenderStatus::Converging, 0, false));
    // No owner: nothing pending.
    assert_eq!(
        preview_frame(false, None, converging, false),
        PreviewFrame::default()
    );
    // The preview owns the frame and is tracing its first sample: hold.
    assert_eq!(
        preview_frame(true, Some(true), converging, false),
        PreviewFrame {
            pending: true,
            tracing: true,
            holding: true
        }
    );
    // The final render owns it but became complete: a preview never replaces it.
    assert_eq!(
        preview_frame(false, Some(true), converging, false),
        PreviewFrame::default()
    );
    // Final incomplete, preview already has a sample: present it, do not hold.
    assert_eq!(
        preview_frame(
            false,
            Some(false),
            Some((RenderStatus::Converging, 1, false)),
            false
        ),
        PreviewFrame {
            pending: true,
            tracing: false,
            holding: false
        }
    );
    // Coalescing holds while the preview filters.
    let denoising = Some((RenderStatus::Denoising, 4, true));
    assert!(preview_frame(true, Some(false), denoising, true).holding);
    assert!(!preview_frame(true, Some(false), denoising, false).holding);
    // A preparing preview is not tracing.
    assert!(
        !preview_frame(
            true,
            Some(false),
            Some((RenderStatus::Preparing, 0, false)),
            false
        )
        .holding
    );

    // Preview selected and tracing its first sample: wait.
    assert!(waits_for_preview(
        true,
        true,
        RenderStatus::Converging,
        0,
        false,
        false,
        false,
        false
    ));
    // Preview with a sample: present it.
    assert!(!waits_for_preview(
        true,
        true,
        RenderStatus::Converging,
        1,
        false,
        false,
        true,
        false
    ));
    // Final selected: only coalescing with a filtering preview fallback waits.
    assert!(!waits_for_preview(
        true,
        false,
        RenderStatus::Converging,
        0,
        false,
        false,
        false,
        true
    ));
    assert!(waits_for_preview(
        true,
        false,
        RenderStatus::Converging,
        0,
        true,
        true,
        false,
        true
    ));
    assert!(!waits_for_preview(
        true,
        false,
        RenderStatus::Converging,
        0,
        true,
        true,
        true,
        true
    ));
    assert!(!waits_for_preview(
        false,
        true,
        RenderStatus::Converging,
        0,
        true,
        true,
        false,
        true
    ));

    assert_eq!(
        loop_status(RenderStatus::Error, true),
        RenderLoopStatus::Error
    );
    assert_eq!(
        loop_status(RenderStatus::Finished, true),
        RenderLoopStatus::Previewing
    );
    assert_eq!(
        loop_status(RenderStatus::Preparing, false),
        RenderLoopStatus::Preparing
    );
    assert_eq!(
        select_default(SelectInfo { changing: true }),
        Selection::Preview
    );
    assert_eq!(
        select_default(SelectInfo { changing: false }),
        Selection::Final
    );
}

#[test]
fn sync_activity_tracks_flags_and_deadlines() {
    let mut activity = SyncActivity::default();
    assert!(!activity.active());
    activity.set_active(true);
    assert!(activity.active());
    activity.set_active(false);
    activity.activate_for(Duration::from_millis(40));
    activity.activate_for(Duration::from_millis(1));
    assert!(activity.active());
    std::thread::sleep(Duration::from_millis(50));
    assert!(!activity.active());
    activity.set_active(true);
    activity.clear();
    assert!(!activity.active());
    let preview = RenderLoop::preview_settings();
    assert_eq!(preview.size, RenderSize::Scale(0.5));
    assert_eq!(preview.time_budget_ms, 80.);
    assert_eq!(preview.bounces, 2);
    assert!(!preview.bevel);
    assert_eq!(preview.dispersion_wavelengths, 1);
    assert_eq!(preview.direct_light_candidates, 2);
    assert_eq!(
        preview.adaptive_resolution,
        Some(AdaptiveResolution {
            target_frame_ms: 80.,
            min_scale: 0.125
        })
    );
    assert!(preview.validate().is_ok());
    let options = RenderLoopOptions::default();
    assert!(matches!(options.preview, Some(LoopRender::Default)));
    assert_eq!(options.idle_ms, 150.);
    assert!(!options.coalesce_scene_updates);
}

/// Moves the camera on every update while `moving`.
struct CameraSync {
    engine: Engine,
    activity: SyncActivity,
    moving: bool,
    step: u32,
    base: Camera,
}
impl LoopSync for CameraSync {
    fn update(&mut self) {
        if self.moving {
            self.step += 1;
            let mut camera = self.base;
            camera.world_matrix[12] = 0.2 + 0.02 * (self.step % 10) as f32;
            self.engine.set_camera(Some(camera)).unwrap();
        }
    }
    fn activity(&self) -> &SyncActivity {
        &self.activity
    }
    fn activity_mut(&mut self) -> &mut SyncActivity {
        &mut self.activity
    }
}
fn camera_sync(engine: &Engine) -> Arc<Mutex<CameraSync>> {
    let scene = lit_scene();
    Arc::new(Mutex::new(CameraSync {
        engine: engine.clone(),
        activity: SyncActivity::default(),
        moving: false,
        step: 0,
        base: Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap(),
    }))
}
fn texture_bytes(engine: &Engine, texture: &wgpu::Texture) -> Vec<u8> {
    let gpu = &engine.inner.gpu;
    let [width, height] = [texture.width(), texture.height()];
    let stride = (width * 4).div_ceil(256) * 256;
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: stride as u64 * height as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: None,
            },
        },
        texture.size(),
    );
    gpu.queue.submit([encoder.finish()]);
    let (send, receive) = std::sync::mpsc::channel();
    buffer.map_async(wgpu::MapMode::Read, .., move |r| send.send(r).unwrap());
    gpu.device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })
        .unwrap();
    receive.recv().unwrap().unwrap();
    let mapped = buffer.get_mapped_range(..).unwrap();
    mapped
        .chunks_exact(stride as usize)
        .flat_map(|row| row[..width as usize * 4].iter().copied())
        .collect()
}
fn tick_until(
    render_loop: &mut RenderLoop,
    done: impl Fn(&RenderLoop, RenderLoopStatus) -> bool,
) -> Vec<RenderLoopStatus> {
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut seen = Vec::new();
    loop {
        let status = render_loop.tick().unwrap();
        if seen.last() != Some(&status) {
            seen.push(status);
        }
        if done(render_loop, status) {
            return seen;
        }
        assert_ne!(status, RenderLoopStatus::Error);
        assert!(Instant::now() < deadline, "loop stuck at {status:?}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn loop_converge_matches_a_fresh_l0_context() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    engine.display().set_size(16, 12).unwrap();
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    let mut render_loop = RenderLoop::new(&engine, RenderLoopOptions::default()).unwrap();
    let preview = render_loop.preview().unwrap().clone();
    assert_eq!(preview.settings().unwrap(), RenderLoop::preview_settings());
    assert_eq!(render_loop.final_render().fallback_id(), Some(preview.id()));
    assert_eq!(render_loop.status(), RenderLoopStatus::Preparing);
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let recorded = statuses.clone();
    let _status = render_loop
        .on_status(move |status, previous| recorded.lock().unwrap().push((previous, status)));
    let samples = Arc::new(Mutex::new(Vec::new()));
    let counted = samples.clone();
    let _samples = render_loop.on_sample(move |event| counted.lock().unwrap().push(event.samples));
    let mut options = ConvergeOptions::new(6);
    options.samples_per_batch = 4;
    let result = render_loop.converge(options).unwrap();
    assert_eq!(result.samples, 6);
    assert_eq!(render_loop.status(), RenderLoopStatus::Finished);
    assert_eq!(render_loop.samples(), 6);
    assert_eq!(
        render_loop.presented(),
        Some(render_loop.final_render().id())
    );
    assert_eq!(
        statuses.lock().unwrap().last(),
        Some(&(RenderLoopStatus::Converging, RenderLoopStatus::Finished))
    );
    assert_eq!(*samples.lock().unwrap(), vec![4, 6]);
    let settings = render_loop.final_render().settings().unwrap();
    assert_bytes(
        &images(render_loop.final_render()),
        &oracle(
            0,
            &expected_descriptor(&scene, [16, 12], 3, None),
            &settings.l0(settings.sample_cap(6), 0),
            6,
        ),
        "loop converge",
    );
}

#[test]
fn interaction_keeps_an_image_and_never_reverts_a_finished_final() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let display = engine.display();
    display.set_size(32, 24).unwrap();
    engine.set_scene(&lit_scene()).unwrap();
    let sync = camera_sync(&engine);
    let mut render_loop = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            preview: Some(LoopRender::Default),
            final_render: LoopRender::Settings(RenderSettings {
                max_samples: 4,
                ..Default::default()
            }),
            syncs: vec![sync.clone()],
            ..Default::default()
        },
    )
    .unwrap();
    let preview = render_loop.preview().unwrap().id();
    let final_id = render_loop.final_render().id();
    assert_eq!(render_loop.final_render().fallback_id(), Some(preview));
    assert!(render_loop.needs_tick());
    tick_until(&mut render_loop, |l, s| {
        s == RenderLoopStatus::Finished && !l.needs_tick()
    });
    assert_eq!(render_loop.presented(), Some(final_id));
    let settled = texture_bytes(&engine, &display.texture().unwrap());
    assert!(
        settled.chunks(4).any(|p| p[3] != 0),
        "settled image is blank"
    );

    // Continuous camera motion with an active sync: every frame shows an image.
    {
        let mut sync = sync.lock().unwrap();
        sync.moving = true;
        sync.set_active(true);
    }
    let mut statuses = Vec::new();
    let mut preview_shown = false;
    for _ in 0..40 {
        statuses.push(render_loop.tick().unwrap());
        assert!(render_loop.changing());
        let image = texture_bytes(&engine, &display.texture().unwrap());
        assert!(image.chunks(4).any(|p| p[3] != 0), "blank frame");
        preview_shown |= render_loop.presented() == Some(preview);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(
        preview_shown,
        "no preview frame was presented: {statuses:?}"
    );
    assert!(statuses.contains(&RenderLoopStatus::Previewing));
    assert_eq!(render_loop.samples(), 0);

    // Release: the final image replaces the preview and stays.
    {
        let mut sync = sync.lock().unwrap();
        sync.moving = false;
        sync.set_active(false);
    }
    let after = tick_until(&mut render_loop, |l, s| {
        s == RenderLoopStatus::Finished && !l.needs_tick()
    });
    assert!(!render_loop.changing());
    assert_eq!(render_loop.presented(), Some(final_id));
    assert_eq!(render_loop.samples(), 4);
    let finished = texture_bytes(&engine, &display.texture().unwrap());
    for _ in 0..10 {
        assert_eq!(render_loop.tick().unwrap(), RenderLoopStatus::Finished);
        assert_eq!(render_loop.presented(), Some(final_id));
        assert!(!render_loop.needs_tick());
    }
    assert_eq!(
        texture_bytes(&engine, &display.texture().unwrap()),
        finished
    );
    // A display edit re-presents the finished final image, not the preview.
    display
        .set_settings(DisplaySettings {
            tone_mapping_exposure: 2.,
            ..Default::default()
        })
        .unwrap();
    assert!(render_loop.needs_tick());
    assert_eq!(render_loop.tick().unwrap(), RenderLoopStatus::Finished);
    assert_eq!(render_loop.presented(), Some(final_id));
    assert_ne!(
        texture_bytes(&engine, &display.texture().unwrap()),
        finished
    );
    assert!(!render_loop.needs_tick());
    // An engine edit needs a tick even before update.
    let mut moved = sync.lock().unwrap().base;
    moved.fov = 50.;
    engine.set_camera(Some(moved)).unwrap();
    assert!(render_loop.needs_tick());
    println!("loop statuses after release: {after:?}");
}

#[test]
fn final_render_presents_the_preview_until_it_is_complete() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    engine.display().set_size(16, 12).unwrap();
    engine.set_scene(&lit_scene()).unwrap();
    let selection = Arc::new(Mutex::new(Selection::Preview));
    let chosen = selection.clone();
    let mut render_loop = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            preview: Some(LoopRender::Settings(RenderSettings {
                max_samples: 1,
                ..RenderLoop::preview_settings()
            })),
            final_render: LoopRender::Settings(RenderSettings {
                max_samples: 2,
                ..Default::default()
            }),
            select: Some(Box::new(move |_| *chosen.lock().unwrap())),
            ..Default::default()
        },
    )
    .unwrap();
    let preview = render_loop.preview().unwrap().clone();
    let final_render = render_loop.final_render().clone();
    tick_until(&mut render_loop, |l, _| {
        l.presented() == Some(preview.id()) && preview.samples() == 1
    });
    assert_eq!(render_loop.status(), RenderLoopStatus::Previewing);
    assert_eq!(render_loop.samples(), 0);
    *selection.lock().unwrap() = Selection::Final;
    // The final render has no complete image: its fallback is presented.
    assert_eq!(render_loop.tick().unwrap(), RenderLoopStatus::Previewing);
    assert!(!final_render.complete());
    assert_eq!(render_loop.presented(), Some(preview.id()));
    let shown = engine.display().present(&final_render).unwrap().unwrap();
    assert!(shown.fallback);
    let statuses = tick_until(&mut render_loop, |l, s| {
        s == RenderLoopStatus::Finished && l.presented() == Some(final_render.id())
    });
    assert!(!statuses.contains(&RenderLoopStatus::Error));
    assert!(
        !engine
            .display()
            .present(&final_render)
            .unwrap()
            .unwrap()
            .fallback
    );
    // Selecting the preview again shows it; the final image is not lost.
    *selection.lock().unwrap() = Selection::Preview;
    assert_eq!(render_loop.tick().unwrap(), RenderLoopStatus::Previewing);
    assert_eq!(final_render.samples(), 2);
}

#[test]
fn sync_activity_and_consecutive_edits_drive_changing() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    engine.display().set_size(8, 6).unwrap();
    engine.set_scene(&lit_scene()).unwrap();
    let sync = camera_sync(&engine);
    let shared: SharedSync = sync.clone();
    let mut render_loop = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            final_render: LoopRender::Settings(RenderSettings {
                max_samples: 1,
                ..Default::default()
            }),
            idle_ms: 60.,
            ..Default::default()
        },
    )
    .unwrap();
    render_loop.add_sync(shared.clone());
    render_loop.add_sync(shared.clone());
    tick_until(&mut render_loop, |_, s| s == RenderLoopStatus::Finished);
    assert!(!render_loop.changing());
    // Explicit activity without edits.
    sync.lock().unwrap().set_active(true);
    render_loop.tick().unwrap();
    assert!(render_loop.changing());
    assert!(render_loop.needs_tick());
    sync.lock().unwrap().set_active(false);
    render_loop.tick().unwrap();
    assert!(!render_loop.changing());
    sync.lock().unwrap().activate_for(Duration::from_millis(40));
    render_loop.tick().unwrap();
    assert!(render_loop.changing());
    std::thread::sleep(Duration::from_millis(50));
    render_loop.tick().unwrap();
    assert!(!render_loop.changing());
    // Consecutive edits without activity: changing until the idle delay passes.
    sync.lock().unwrap().moving = true;
    render_loop.tick().unwrap();
    assert!(!render_loop.changing(), "an isolated edit is not motion");
    render_loop.tick().unwrap();
    assert!(render_loop.changing());
    sync.lock().unwrap().moving = false;
    render_loop.tick().unwrap();
    assert!(render_loop.changing());
    std::thread::sleep(Duration::from_millis(70));
    render_loop.tick().unwrap();
    assert!(!render_loop.changing());
    // A removed sync is no longer updated or consulted.
    render_loop.remove_sync(&shared);
    sync.lock().unwrap().set_active(true);
    render_loop.tick().unwrap();
    assert!(!render_loop.changing());
    sync.lock().unwrap().dispose();
    assert!(!sync.lock().unwrap().active());
}

#[test]
fn unsubscribing_inside_a_callback_stops_later_events() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    engine.display().set_size(8, 6).unwrap();
    engine.set_scene(&lit_scene()).unwrap();
    let mut render_loop = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            final_render: LoopRender::Settings(RenderSettings {
                max_samples: 4,
                ..Default::default()
            }),
            ..Default::default()
        },
    )
    .unwrap();
    // Each callback drops its own subscription on its first call.
    fn once<S: Send + 'static>() -> (Arc<Mutex<Option<S>>>, Arc<Mutex<u32>>) {
        (Arc::new(Mutex::new(None)), Arc::new(Mutex::new(0)))
    }
    let (status_slot, status_calls) = once::<LoopSubscription>();
    let (slot, calls) = (status_slot.clone(), status_calls.clone());
    *status_slot.lock().unwrap() = Some(render_loop.on_status(move |_, _| {
        *calls.lock().unwrap() += 1;
        slot.lock().unwrap().take();
    }));
    let (loop_sample_slot, loop_sample_calls) = once::<LoopSubscription>();
    let (slot, calls) = (loop_sample_slot.clone(), loop_sample_calls.clone());
    *loop_sample_slot.lock().unwrap() = Some(render_loop.on_sample(move |_| {
        *calls.lock().unwrap() += 1;
        slot.lock().unwrap().take();
    }));
    let (render_slot, render_calls) = once::<Subscription>();
    let (slot, calls) = (render_slot.clone(), render_calls.clone());
    *render_slot.lock().unwrap() = Some(render_loop.final_render().on_sample(move |_| {
        *calls.lock().unwrap() += 1;
        slot.lock().unwrap().take();
    }));
    let (engine_slot, engine_calls) = once::<Subscription>();
    let (slot, calls) = (engine_slot.clone(), engine_calls.clone());
    *engine_slot.lock().unwrap() = Some(engine.on(move |_| {
        *calls.lock().unwrap() += 1;
        slot.lock().unwrap().take();
    }));
    // Control listeners that stay subscribed.
    let statuses = Arc::new(Mutex::new(0));
    let counted = statuses.clone();
    let _statuses = render_loop.on_status(move |_, _| *counted.lock().unwrap() += 1);
    let samples = Arc::new(Mutex::new(0));
    let counted = samples.clone();
    let _samples = render_loop.on_sample(move |_| *counted.lock().unwrap() += 1);
    let progress = Arc::new(Mutex::new(0));
    let counted = progress.clone();
    let _progress = engine.on(move |_| *counted.lock().unwrap() += 1);
    tick_until(&mut render_loop, |_, s| s == RenderLoopStatus::Finished);
    assert!(*statuses.lock().unwrap() >= 2);
    assert_eq!(*samples.lock().unwrap(), 4);
    assert!(*progress.lock().unwrap() >= 2);
    for (name, calls) in [
        ("loop status", &status_calls),
        ("loop sample", &loop_sample_calls),
        ("render sample", &render_calls),
        ("engine", &engine_calls),
    ] {
        assert_eq!(*calls.lock().unwrap(), 1, "{name}");
    }
}

#[test]
fn collect_accounts_a_batch_without_submitting_another() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    engine.set_scene(&lit_scene()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 8,
            size: RenderSize::Fixed {
                width: 16,
                height: 12,
            },
            ..Default::default()
        },
    )
    .unwrap();
    // Refine until one batch is in flight.
    let deadline = Instant::now() + Duration::from_secs(60);
    while !render.engine().lock().renders[&render.id()].in_flight() {
        render.refine().unwrap();
        assert!(Instant::now() < deadline);
    }
    let before = render.samples();
    while !render.collect().unwrap() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(render.samples(), before + 1);
    assert!(!render.engine().lock().renders[&render.id()].in_flight());
    assert!(render.complete());
    // Collecting again changes nothing; the next refine continues.
    assert!(render.collect().unwrap());
    assert_eq!(render.samples(), before + 1);
    render.refine().unwrap();
    assert!(render.engine().lock().renders[&render.id()].in_flight());
}
