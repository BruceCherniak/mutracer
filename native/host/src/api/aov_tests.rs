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
