//! Real-device checks for viewer settings, including the asynchronous commit path.
use crate::{
    Change, Viewer,
    renderer::{self, Renderer},
};
use anyhow::{Result, ensure};
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn settle(viewer: &mut Viewer, ctx: &eframe::egui::Context) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        viewer.tick(ctx)?;
        if viewer.commit.is_none()
            && viewer.change == Change::None
            && !viewer.renderer.busy()
            && viewer.samples >= viewer.settings.max_samples
        {
            return Ok(());
        }
        ensure!(Instant::now() < deadline, "Viewer settings timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

pub fn run(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    for mode in [0, 1] {
        let mut viewer = Viewer::new(path)?;
        viewer.denoise = false;
        viewer.backend = mode;
        viewer.size = [96, 64];
        viewer.settings.max_samples = 4;
        let ctx = eframe::egui::Context::default();
        viewer.dirty(Change::Scene);
        settle(&mut viewer, &ctx)?;
        ensure!(
            viewer.renderer.backend()?.0 == mode,
            "Requested backend unavailable"
        );
        let camera = viewer.camera.clone();
        let settings = viewer.settings;
        let baseline = viewer.pixels.clone();
        for case in 0..10 {
            viewer.camera = camera.clone();
            viewer.settings = settings;
            match case {
                0 => viewer.camera.orthographic = true,
                1 => viewer.camera.f_stop = 0.7,
                2 => {
                    viewer.camera.f_stop = 1.4;
                    viewer.camera.meters_per_unit = 0.01;
                }
                3 => {
                    viewer.camera.f_stop = 1.4;
                    viewer.camera.meters_per_unit = 0.01;
                    viewer.camera.focus_distance *= 0.7;
                }
                4 => viewer.settings.bounces = 1,
                5 => viewer.settings.bounces = 12,
                6 => viewer.settings.sampling_pattern = 1,
                7 => viewer.settings.sampling_pattern = 2,
                8 => viewer.settings.clamping = 0.1,
                _ => {
                    viewer.settings.sampling_pattern = 1;
                    viewer.settings.max_samples = 16;
                }
            }
            viewer.dirty(if case < 4 {
                Change::Camera
            } else {
                Change::Scene
            });
            settle(&mut viewer, &ctx)?;
            let mut fresh = Renderer::with_backend(mode)?;
            fresh.commit_with_settings(
                &viewer.model.descriptor_with_light(
                    &viewer.camera.bytes(viewer.size),
                    viewer.size,
                    &viewer.environment,
                    &viewer.light,
                ),
                &viewer.settings,
            )?;
            ensure!(
                viewer.pixels == fresh.finish(viewer.samples)?
                    && viewer.renderer.image(1)? == fresh.image(1)?
                    && viewer.renderer.image(2)? == fresh.image(2)?,
                "Viewer/fresh mismatch: backend {mode}, case {case}"
            );
            ensure!(
                viewer.pixels != baseline,
                "Control had no effect: backend {mode}, case {case}"
            );
            if case == 0 || case == 3 {
                renderer::save(
                    &out.join(format!("camera-{mode}-{case}.png")),
                    &viewer.pixels,
                    viewer.size,
                    0.,
                )?;
            }
            println!("PASS viewer settings backend {mode}, case {case}");
        }
        // Following quality changes, camera/material/environment edits must keep
        // using the selected settings, including when their commit is incremental.
        for change in [Change::Camera, Change::Material, Change::Environment] {
            match change {
                Change::Camera => viewer.camera.orbit([8., 2.]),
                Change::Material => viewer.model.materials[0].roughness = 0.85,
                _ => viewer.environment.rotation = 75.,
            }
            viewer.dirty(change);
            settle(&mut viewer, &ctx)?;
            let mut fresh = Renderer::with_backend(mode)?;
            fresh.commit_with_settings(
                &viewer.model.descriptor_with_light(
                    &viewer.camera.bytes(viewer.size),
                    viewer.size,
                    &viewer.environment,
                    &viewer.light,
                ),
                &viewer.settings,
            )?;
            ensure!(
                viewer.pixels == fresh.finish(viewer.samples)?,
                "Settings lost after an edit"
            );
        }
        viewer.backend = 1 - mode;
        viewer.dirty(Change::Scene);
        settle(&mut viewer, &ctx)?;
        let mut fresh = Renderer::with_backend(1 - mode)?;
        fresh.commit_with_settings(
            &viewer.model.descriptor_with_light(
                &viewer.camera.bytes(viewer.size),
                viewer.size,
                &viewer.environment,
                &viewer.light,
            ),
            &viewer.settings,
        )?;
        ensure!(
            viewer.pixels == fresh.finish(viewer.samples)?,
            "Settings lost after backend switch"
        );
        println!("PASS retained settings after edits and backend switch {mode}");
    }
    Ok(())
}
