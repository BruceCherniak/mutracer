use super::*;
#[test]
fn aov_options_validate_without_a_device() {
    let defaults = RenderSettings::default();
    assert_eq!((defaults.aovs, defaults.aov_samples), (0, 16));
    for options in [
        RenderSettings {
            aovs: 128,
            ..defaults.clone()
        },
        RenderSettings {
            aov_samples: 0,
            ..defaults.clone()
        },
    ] {
        assert_eq!(
            options.validate().unwrap_err().status,
            Status::InvalidArgument
        );
    }
}
#[test]
#[ignore = "requires real GPU"]
fn independent_surface_aovs_preserve_beauty_and_exact_ids() {
    independent_surface_aovs(aov_test_backend());
}
fn independent_surface_aovs(backend: Backend) {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = Engine::new(EngineOptions { backend }).unwrap();
    let mut descriptor = tests::lit_scene();
    let mut words: Vec<_> = descriptor
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    words[24] = words.len() as u32;
    words.extend([101, 102]);
    words[25] = words.len() as u32;
    words.extend([202, 203]);
    words[1] = words.len() as u32;
    descriptor = words.into_iter().flat_map(u32::to_le_bytes).collect();
    engine.display().set_size(48, 32).unwrap();
    engine.set_scene(&descriptor).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 4,
            bounces: 1,
            ..Default::default()
        },
    )
    .unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    if backend == Backend::Hardware {
        assert_eq!(render.backend().unwrap().0, Backend::Hardware);
    }
    let before = render.read_pixels(PixelKind::Hdr).unwrap();
    let mut settings = render.settings().unwrap();
    settings.aovs = 127;
    settings.aov_samples = 4;
    render.set_settings(settings).unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    assert_eq!(before, render.read_pixels(PixelKind::Hdr).unwrap());
    let depth = render.read_pixels(PixelKind::Depth).unwrap();
    assert!(depth.data.iter().all(|v| v.is_finite()));
    assert!(depth.data.chunks_exact(4).any(|v| v[0] > 0. && v[3] > 0.));
    let ids = render.read_pixels(PixelKind::Id).unwrap().id_data.unwrap();
    assert!(ids.chunks_exact(4).any(|v| v[0] == 102 && v[2] == 203));
    assert!(ids.chunks_exact(4).all(|v| v[0] == u32::MAX || v[3] < 2));
    assert!(ids.chunks_exact(4).any(|v| v[0] == 101 && v[2] == 202));
    assert!(
        ids.chunks_exact(4)
            .all(|v| v[0] == u32::MAX || [101, 102].contains(&v[0]))
    );
    assert!(
        render
            .read_pixels(PixelKind::Motion)
            .unwrap()
            .data
            .iter()
            .all(|v| *v == 0.)
    );
    for kind in [PixelKind::DiffuseAlbedo, PixelKind::SpecularAlbedo] {
        let values = render.read_pixels(kind).unwrap().data;
        assert!(values.iter().all(|v| v.is_finite()));
        assert!(values.chunks_exact(4).any(|v| v[3] > 0. && v[0] > 0.));
    }
    let mut camera = Camera::from_bytes(&descriptor[160 * 4..192 * 4]).unwrap();
    camera.world_matrix[12] += 0.25;
    engine.set_camera(Some(camera)).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    let motion = render.read_pixels(PixelKind::Motion).unwrap();
    let identity = render.read_pixels(PixelKind::Id).unwrap().id_data.unwrap();
    let expected = 32. * 0.5 / (std::f32::consts::PI / 8.).tan() * 0.25 / 4.;
    let valid: Vec<_> = motion
        .data
        .chunks_exact(4)
        .zip(identity.chunks_exact(4))
        .filter(|(m, id)| m[3] == 3. && id[0] == 101)
        .collect();
    assert!(valid.len() > 40);
    assert!(
        valid
            .iter()
            .all(|(m, _)| (m[0] - expected).abs() < 0.001 && m[1].abs() < 0.001)
    );
    descriptor[(44 + 4 + 12) * 4..(44 + 4 + 13) * 4].copy_from_slice(&0.25f32.to_le_bytes());
    engine.set_scene(&descriptor).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    let motion = render.read_pixels(PixelKind::Motion).unwrap();
    let identity = render.read_pixels(PixelKind::Id).unwrap().id_data.unwrap();
    let valid: Vec<_> = motion
        .data
        .chunks_exact(4)
        .zip(identity.chunks_exact(4))
        .filter(|(m, id)| m[3] == 3. && id[0] == 101)
        .collect();
    assert!(valid.len() > 40);
    assert!(valid.iter().all(|(m, _)| (m[0] + expected).abs() < 0.001));
    let mut transform = glam::Mat4::from_rotation_z(0.1).to_cols_array();
    transform[12] = 0.25;
    for (i, v) in transform.iter().enumerate() {
        descriptor[(48 + i) * 4..(49 + i) * 4].copy_from_slice(&v.to_le_bytes());
    }
    engine.set_scene(&descriptor).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    let rotated = render.read_pixels(PixelKind::Motion).unwrap();
    let identity = render.read_pixels(PixelKind::Id).unwrap().id_data.unwrap();
    let mut count = 0;
    let focal = 16. / (std::f32::consts::PI / 8.).tan();
    let (c, s) = (0.1f32.cos(), -0.1f32.sin());
    for (y, row) in rotated.data.chunks_exact(48 * 4).enumerate() {
        for (x, m) in row.chunks_exact(4).enumerate() {
            if m[3] != 3. || identity[(y * 48 + x) * 4] != 101 {
                continue;
            }
            let wx = camera.world_matrix[12] + (x as f32 + 0.5 - 24.) * 4. / focal;
            let wy = camera.world_matrix[13] + (16. - y as f32 - 0.5) * 4. / focal;
            let px = 0.25 + c * (wx - 0.25) - s * wy;
            let py = s * (wx - 0.25) + c * wy;
            let expected_x = (px - camera.world_matrix[12]) * focal / 4. + 24. - x as f32 - 0.5;
            let expected_y = 16. - (py - camera.world_matrix[13]) * focal / 4. - y as f32 - 0.5;
            assert!((m[0] - expected_x).abs() < 0.001 && (m[1] - expected_y).abs() < 0.001);
            count += 1;
        }
    }
    assert!(count > 40);
    descriptor[192 * 4..193 * 4].copy_from_slice(&(-1.2f32).to_le_bytes());
    engine.set_scene(&descriptor).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    assert!(
        render
            .read_pixels(PixelKind::Motion)
            .unwrap()
            .data
            .chunks_exact(4)
            .all(|v| v[3] == 0.)
    );
    if let Ok(directory) = std::env::var("MUTRACER_AOV_EVIDENCE") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            format!("{directory}/native-ids.bin"),
            ids.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>(),
        )
        .unwrap();
        std::fs::write(
            format!("{directory}/native-depth.bin"),
            depth
                .data
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        )
        .unwrap();
    }
}

struct AovFilter {
    resident: bool,
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl CustomDenoiser for AovFilter {
    fn aovs(&self) -> u32 {
        1 | 8 | 32
    }
    fn input_mode(&self) -> DenoiseInputMode {
        if self.resident {
            DenoiseInputMode::ResidentGpu
        } else {
            DenoiseInputMode::Cpu
        }
    }
    fn denoise(
        &self,
        mut input: DenoiseInput,
        _cancel: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        self.calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if self.resident {
            assert!(input.aovs.is_empty());
            let resident = input.resident.take().unwrap();
            assert_eq!(resident.aovs.len(), 3);
            for aov in &resident.aovs {
                assert_eq!(
                    aov.buffer.size(),
                    (input.size[0] * input.size[1] * 16) as u64
                );
            }
            let output = resident.buffers.color.clone();
            Ok(DenoiseOutput::Resident(resident.submit([], output)?))
        } else {
            assert!(input.resident.is_none());
            assert_eq!(input.aovs.len(), 3);
            let depth = input
                .aovs
                .iter()
                .find(|a| a.kind == PixelKind::Depth)
                .unwrap();
            assert!(depth.data.iter().any(|v| *v > 0.));
            let id = input
                .aovs
                .iter()
                .find(|a| a.kind == PixelKind::Id)
                .unwrap()
                .id_data
                .as_ref()
                .unwrap();
            assert!(id.iter().any(|v| *v == 0));
            Ok(DenoiseOutput::Cpu(input.color))
        }
    }
}
#[test]
#[ignore = "requires real GPU"]
fn custom_filters_receive_only_declared_aovs_in_cpu_and_resident_modes() {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = Engine::new(EngineOptions {
        backend: aov_test_backend(),
    })
    .unwrap();
    engine.display().set_size(16, 12).unwrap();
    engine.set_scene(&tests::lit_scene()).unwrap();
    engine.update().unwrap();
    for resident in [false, true] {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let render = Render::new(
            &engine,
            RenderSettings {
                max_samples: 2,
                aovs: 0,
                ..Default::default()
            },
        )
        .unwrap();
        render
            .set_custom_denoiser(
                Some(std::sync::Arc::new(AovFilter {
                    resident,
                    calls: calls.clone(),
                })),
                DenoiseSchedule::Converged,
            )
            .unwrap();
        render.converge(ConvergeOptions::new(2)).unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert!(render.read_pixels(PixelKind::Depth).is_err());
        assert!(
            render
                .read_pixels(PixelKind::Denoised)
                .unwrap()
                .data
                .iter()
                .all(|v| v.is_finite())
        );
    }
}

struct TemporalFilter {
    engine: Engine,
    frames: std::sync::Arc<std::sync::Mutex<Vec<(u32, usize, Vec<TemporalResetReason>)>>>,
}
impl CustomDenoiser for TemporalFilter {
    fn input_mode(&self) -> DenoiseInputMode {
        DenoiseInputMode::TemporalGpu
    }
    fn denoise(
        &self,
        mut input: DenoiseInput,
        _cancel: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        let resident = input.resident.take().unwrap();
        let frame = resident.temporal.as_ref().unwrap();
        assert_eq!(frame.metadata().sample_count, 1);
        assert_eq!(frame.metadata().pre_exposure, 1.);
        assert_eq!(
            frame.pixel_records().size(),
            (input.size[0] * input.size[1] * 240) as u64
        );
        assert_eq!(
            frame.stable_ids().size(),
            (input.size[0] * input.size[1] * 16) as u64
        );
        let validity = super::gpu_output_tests::bytes(
            &self.engine,
            frame.guide(TemporalGuide::Validity).unwrap(),
            4,
        );
        let motion = super::gpu_output_tests::bytes(
            &self.engine,
            frame.guide(TemporalGuide::Motion).unwrap(),
            8,
        );
        let flags: Vec<_> = validity
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        let valid = flags.iter().filter(|f| **f & 2 != 0).count();
        if frame.metadata().sample_index == 0 {
            assert_eq!(valid, 0);
            assert!(frame.previous_metadata().is_none());
        }
        let motion_x: Vec<_> = motion
            .chunks_exact(8)
            .map(|b| f32::from_le_bytes(b[..4].try_into().unwrap()))
            .collect();
        if frame.metadata().sample_index == 1 {
            assert!(valid > 10);
            assert!(motion_x.iter().any(|x| *x > 0.5));
            assert!(frame.previous_metadata().is_some());
        }
        if frame.metadata().sample_index == 2 {
            assert!(valid > 10);
            assert!(motion_x.iter().any(|x| *x < -0.5));
        }
        self.frames.lock().unwrap().push((
            frame.metadata().sample_index,
            valid,
            frame.reset_reasons().to_vec(),
        ));
        let output = resident.buffers.color.clone();
        Ok(DenoiseOutput::Resident(resident.submit([], output)?))
    }
}
#[test]
#[ignore = "requires real GPU"]
fn temporal_resident_frames_advance_only_after_acceptance_and_support_rigid_motion() {
    accepted_temporal_frames(aov_test_backend());
}
fn accepted_temporal_frames(backend: Backend) {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = Engine::new(EngineOptions { backend }).unwrap();
    let mut scene = tests::lit_scene();
    engine.display().set_size(16, 12).unwrap();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 2,
            ..Default::default()
        },
    )
    .unwrap();
    render
        .set_custom_denoiser(
            Some(std::sync::Arc::new(TemporalFilter {
                engine: engine.clone(),
                frames: frames.clone(),
            })),
            DenoiseSchedule::Converged,
        )
        .unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    if backend == Backend::Hardware {
        assert_eq!(render.backend().unwrap().0, Backend::Hardware);
    }
    let mut camera = Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap();
    camera.world_matrix[12] += 0.25;
    engine.set_camera(Some(camera)).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    scene[(44 + 4 + 12) * 4..(44 + 4 + 13) * 4].copy_from_slice(&0.25f32.to_le_bytes());
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    assert_eq!(frames.lock().unwrap().len(), 3);
    assert!(
        frames.lock().unwrap()[0]
            .2
            .contains(&TemporalResetReason::FirstFrame)
    );
    assert!(frames.lock().unwrap()[1].2.is_empty());
    render.reset_temporal_history().unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    assert!(
        frames.lock().unwrap()[3]
            .2
            .contains(&TemporalResetReason::Explicit)
    );
}

struct RejectTemporal {
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    resets: std::sync::Arc<std::sync::Mutex<Vec<Vec<TemporalResetReason>>>>,
}
impl CustomDenoiser for RejectTemporal {
    fn input_mode(&self) -> DenoiseInputMode {
        DenoiseInputMode::TemporalGpu
    }
    fn denoise(
        &self,
        mut input: DenoiseInput,
        _: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        let n = self
            .calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let resident = input.resident.take().unwrap();
        self.resets
            .lock()
            .unwrap()
            .push(resident.temporal.as_ref().unwrap().reset_reasons().to_vec());
        if n == 1 {
            return Err("deliberate temporal rejection".into());
        }
        let output = resident.buffers.color.clone();
        Ok(DenoiseOutput::Resident(resident.submit([], output)?))
    }
}
#[test]
#[ignore = "requires real GPU"]
fn temporal_rejection_resets_the_next_frame_and_pinhole_limits_are_enforced() {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = Engine::new(EngineOptions {
        backend: aov_test_backend(),
    })
    .unwrap();
    let scene = tests::lit_scene();
    engine.display().set_size(16, 12).unwrap();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let resets = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let filter = std::sync::Arc::new(RejectTemporal {
        calls: calls.clone(),
        resets: resets.clone(),
    });
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 2,
            ..Default::default()
        },
    )
    .unwrap();
    render
        .set_custom_denoiser(Some(filter.clone()), DenoiseSchedule::Converged)
        .unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    let _ = render.converge(ConvergeOptions::new(2));
    assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 2);
    render
        .set_custom_denoiser(Some(filter), DenoiseSchedule::Converged)
        .unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    assert!(resets.lock().unwrap()[2].contains(&TemporalResetReason::ConsumerRejected));
    let mut camera = Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap();
    camera.f_stop = 2.;
    engine.set_camera(Some(camera)).unwrap();
    engine.update().unwrap();
    let failure = render.converge(ConvergeOptions::new(2)).unwrap_err();
    assert!(failure.message.contains("pinhole"));
}

#[test]
#[ignore = "requires real GPU"]
fn surface_aov_plane_matches_cross_backend_fixture_with_uint32_ids() {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = Engine::new(EngineOptions {
        backend: aov_test_backend(),
    })
    .unwrap();
    let mut words: Vec<_> = tests::lit_scene()
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    // Rotate the shared edge away from exact pixel centers: ties have no unique
    // surface triangle and depend on camera matrix rounding across hosts.
    let rotation = glam::Mat4::from_rotation_z(0.17);
    for (i, v) in rotation.to_cols_array().iter().enumerate() {
        words[48 + i] = v.to_bits();
    }
    words[5] = 1;
    words[6] = 1;
    words[7] = 0;
    for (i, v) in [-10f32, 10., 0., 10., 10., 0., -10., -10., 0., 10., -10., 0.]
        .iter()
        .enumerate()
    {
        words[192 + i] = v.to_bits();
    }
    words[204..210].copy_from_slice(&[0, 2, 1, 2, 3, 1]);
    words[84..89].copy_from_slice(&[
        1f32.to_bits(),
        1f32.to_bits(),
        1f32.to_bits(),
        0.4f32.to_bits(),
        0.2f32.to_bits(),
    ]);
    let mut camera = Camera::default();
    camera.far_clip = 100.;
    camera.world_matrix[14] = 4.;
    words[160..192].copy_from_slice(
        &camera
            .to_bytes()
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>(),
    );
    words[24] = words.len() as u32;
    words.push(0xfffffffe);
    words[25] = words.len() as u32;
    words.push(0x800001ff);
    words[1] = words.len() as u32;
    let descriptor: Vec<_> = words.into_iter().flat_map(u32::to_le_bytes).collect();
    engine.display().set_size(48, 32).unwrap();
    engine.set_scene(&descriptor).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            seed: 0,
            aovs: 127,
            aov_samples: 4,
            max_samples: 4,
            bounces: 1,
            ..Default::default()
        },
    )
    .unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    for kind in [
        PixelKind::Id,
        PixelKind::Depth,
        PixelKind::Position,
        PixelKind::DiffuseAlbedo,
        PixelKind::SpecularAlbedo,
    ] {
        let image = render.read_pixels(kind).unwrap();
        if kind == PixelKind::Id {
            assert!(
                image
                    .id_data
                    .as_ref()
                    .unwrap()
                    .chunks_exact(4)
                    .all(|p| p[0] == 0xfffffffe && p[1] == 0 && p[2] == 0x800001ff && p[3] < 2)
            );
        }
        if kind == PixelKind::Depth {
            assert!(
                image
                    .data
                    .chunks_exact(4)
                    .all(|p| (p[0] - 4.).abs() < 1e-4 && p[3] == 1.)
            );
        }
        if let Ok(directory) = std::env::var("MUTRACER_AOV_EVIDENCE") {
            let bytes: Vec<_> = if let Some(ids) = image.id_data {
                ids.into_iter().flat_map(u32::to_le_bytes).collect()
            } else {
                image.data.into_iter().flat_map(f32::to_le_bytes).collect()
            };
            std::fs::write(format!("{directory}/cross-native-{kind:?}.bin"), bytes).unwrap();
        }
    }
}
fn aov_test_backend() -> Backend {
    if std::env::var_os("MUTRACER_AOV_HWRT").is_some() {
        Backend::Hardware
    } else {
        Backend::Software
    }
}

#[test]
#[ignore = "requires real hardware ray-query GPU"]
fn hardware_surface_aovs_preserve_beauty_ids_and_motion() {
    independent_surface_aovs(Backend::Hardware);
}
#[test]
#[ignore = "requires real hardware ray-query GPU"]
fn hardware_temporal_frames_support_rigid_motion_and_accepted_history() {
    accepted_temporal_frames(Backend::Hardware);
}
