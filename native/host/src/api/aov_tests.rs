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
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = Engine::new(EngineOptions {
        backend: Backend::Software,
    })
    .unwrap();
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
        backend: Backend::Software,
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
