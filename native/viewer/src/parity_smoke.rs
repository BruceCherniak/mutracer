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
        if let Err(error) = viewer.tick(ctx) {
            if !renderer::NativeError::is_busy(&error) {
                return Err(error);
            }
        }
        if viewer.commit.is_none()
            && viewer.change == Change::None
            && !viewer.renderer.busy()
            && viewer.samples >= viewer.settings.max_samples
        {
            ensure!(
                viewer.samples == viewer.settings.max_samples,
                "Viewer overshot the sample target"
            );
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
        let display = mutracer_native_probe::display::Settings::default();
        let hdr = viewer.renderer.pixels()?;
        let generation = viewer.generation;
        let samples = viewer.samples;
        let before = viewer
            .gpu_display
            .as_ref()
            .unwrap()
            .read_rgba(&display)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        for case in 0..12 {
            viewer.display_settings = display;
            match case {
                0..=4 => viewer.display_settings.tone_mapping = case,
                5 => viewer.display_settings.exposure = 0.5,
                6 => viewer.display_settings.contrast = 1.4,
                7 => viewer.display_settings.saturation = 0.,
                8 => viewer.display_settings.temperature = -0.8,
                9 => viewer.display_settings.tint = 0.8,
                10 => viewer.display_settings.output = 1,
                _ => viewer.display_settings.output = 2,
            }
            viewer.display_dirty = true;
            viewer.tick(&ctx)?;
            ensure!(
                viewer.generation == generation
                    && viewer.samples == samples
                    && viewer.renderer.pixels()? == hdr,
                "Display control restarted or mutated HDR"
            );
            let png = out.join(format!("display-{mode}-{case}.png"));
            viewer.save_image(&png)?;
            let exported = image::open(&png)?.into_rgba8();
            let rgba = viewer
                .gpu_display
                .as_ref()
                .unwrap()
                .read_rgba(&viewer.display_settings)
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
            ensure!(
                exported.as_raw() == &rgba,
                "PNG differs from current composition"
            );
            ensure!(
                case == 0 || rgba != before,
                "Display control had no visible effect: {case}"
            );
        }
        viewer.display_settings = display;
        for transparent in [false, true] {
            viewer.environment.background = false;
            viewer.environment.background_color = [0.6, 0.1, 0.2];
            viewer.environment.background_alpha = if transparent { 0. } else { 1. };
            viewer.dirty(Change::Environment);
            settle(&mut viewer, &ctx)?;
            let rgba = viewer
                .gpu_display
                .as_ref()
                .unwrap()
                .read_rgba(&display)
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
            if transparent {
                ensure!(
                    rgba.chunks_exact(4).any(|p| p[3] == 0)
                        && rgba.chunks_exact(4).any(|p| p[3] == 255)
                        && rgba.chunks_exact(4).any(|p| p[3] > 0 && p[3] < 255),
                    "Missing transparent/opaque/antialiased pixels"
                );
            } else {
                ensure!(
                    rgba.chunks_exact(4).all(|p| p[3] == 255),
                    "Color background is not opaque"
                );
            }
            let png = out.join(format!("background-{mode}-{transparent}.png"));
            viewer.save_image(&png)?;
            ensure!(
                image::open(&png)?.into_rgba8().as_raw() == &rgba,
                "Background export mismatch"
            );
        }
        // OIDN must preserve alpha, and AOVs bypass both denoising and color controls.
        viewer.denoise = true;
        let deadline = Instant::now() + Duration::from_secs(30);
        while viewer.denoised.is_empty() {
            viewer.tick(&ctx)?;
            ensure!(
                Instant::now() < deadline,
                "Transparent OIDN timed out: {}",
                viewer.denoise_status
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        ensure!(
            viewer
                .denoised
                .chunks_exact(4)
                .zip(viewer.pixels.chunks_exact(4))
                .all(|(a, b)| a[3] == b[3]),
            "Denoise changed alpha"
        );
        viewer.save_image(&out.join(format!("denoised-transparent-{mode}.png")))?;
        viewer.display_settings.output = 1;
        viewer.display_dirty = true;
        viewer.tick(&ctx)?;
        let normal = viewer
            .gpu_display
            .as_ref()
            .unwrap()
            .read_rgba(&viewer.display_settings)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        viewer.denoise = false;
        viewer.display_settings.exposure = 0.;
        viewer.display_dirty = true;
        viewer.tick(&ctx)?;
        ensure!(
            viewer
                .gpu_display
                .as_ref()
                .unwrap()
                .read_rgba(&viewer.display_settings)
                .map_err(|e| anyhow::anyhow!(e.to_string()))?
                == normal,
            "AOV affected by denoise or exposure"
        );
        println!(
            "PASS display controls, HDR retention, alpha, OIDN, AOV and PNG export backend {}",
            1 - mode
        );
    }
    Ok(())
}
