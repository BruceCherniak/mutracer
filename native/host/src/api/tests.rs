use super::display::{Selection, select};
use super::engine::{camera_offset, override_descriptor, override_shared};
use super::render::{Readiness, flip_rows};
use super::*;
use crate::context;
use crate::layout::header as h;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

#[test]
fn handles_can_move_between_threads() {
    fn shared<T: Send + Sync>() {}
    shared::<Engine>();
    shared::<Render>();
    shared::<Display>();
    shared::<CancelToken>();
    fn movable<T: Send>() {}
    movable::<RenderLoop>();
}

#[test]
fn defaults_match_the_browser_library() {
    let settings = RenderSettings::default();
    assert_eq!(settings.max_samples, 2048);
    assert_eq!(settings.bounces, 3);
    assert_eq!(settings.clamping, 0.);
    assert_eq!(settings.sampling_pattern, SamplingPattern::Sobol);
    assert_eq!(settings.direct_light_candidates, 4);
    assert!(settings.bevel);
    assert_eq!(settings.bevel_samples, 8);
    assert_eq!(settings.dispersion_wavelengths, 3);
    assert_eq!(settings.transmissive_output_alpha_min, 1.);
    assert_eq!(settings.time_budget_ms, 21.);
    assert!(!settings.allow_multiple_samples_per_frame);
    assert_eq!(settings.size, RenderSize::Scale(1.));
    assert_eq!(settings.seed, 12345);
    assert!(settings.validate().is_ok());
    let display = DisplaySettings::default();
    assert_eq!(display.tone_mapping, ToneMapping::Agx);
    assert_eq!(display.tone_mapping_exposure, 1.);
    assert_eq!((display.contrast, display.saturation), (1., 1.));
    assert_eq!((display.temperature, display.tint), (0., 0.));
    assert_eq!(display.channel, Channel::Final);
    assert_eq!(EngineOptions::default().backend, Backend::Hardware);
    assert_eq!(ConvergeOptions::new(9).samples_per_batch, 8);
    assert_eq!(ConvergeOptions::new(9).timeout_ms, 600_000);
    assert_eq!(
        DenoiserOptions::default().schedule,
        DenoiseSchedule::Converged
    );
}

#[test]
fn settings_validation_rejects_out_of_range_values() {
    let cases: [fn(&mut RenderSettings); 10] = [
        |s| s.max_samples = 0,
        |s| s.max_samples = 4097,
        |s| s.dispersion_wavelengths = 2,
        |s| s.clamping = -1.,
        |s| s.clamping = f64::NAN,
        |s| s.transmissive_output_alpha_min = f64::INFINITY,
        |s| s.time_budget_ms = 0.,
        |s| s.size = RenderSize::Scale(0.),
        |s| s.size = RenderSize::Scale(f64::NAN),
        |s| {
            s.size = RenderSize::Fixed {
                width: 0,
                height: 4,
            }
        },
    ];
    for (index, change) in cases.iter().enumerate() {
        let mut settings = RenderSettings::default();
        change(&mut settings);
        let failure = settings.validate().unwrap_err();
        assert_eq!(failure.status, Status::InvalidArgument, "case {index}");
    }
    // Values the shared TS core clamps are accepted as given.
    let clamped = RenderSettings {
        bounces: 99,
        direct_light_candidates: 0,
        bevel_samples: 1000,
        max_samples: 4096,
        ..Default::default()
    };
    assert!(clamped.validate().is_ok());
}

#[test]
fn settings_map_to_l0_record_quality_bits_and_size() {
    let settings = RenderSettings {
        sampling_pattern: SamplingPattern::Random,
        seed: 7,
        bounces: 5,
        direct_light_candidates: 2,
        bevel_samples: 3,
        clamping: 4.5,
        transmissive_output_alpha_min: 0.25,
        ..Default::default()
    };
    let record = settings.l0(17, 9);
    assert_eq!(record.sampling_pattern, 2);
    assert_eq!(record.seed, 7);
    assert_eq!(record.max_samples, 17);
    assert_eq!(record.sample_sequence_offset, 9);
    assert_eq!(record.bounces, 5);
    assert_eq!(record.direct_light_candidates, 2);
    assert_eq!(record.bevel_samples, 3);
    assert_eq!(record.clamping, 4.5);
    assert_eq!(record.transmissive_output_alpha_min, 0.25);
    assert_eq!(
        record.struct_size,
        crate::settings::RenderSettings::default().struct_size
    );
    assert_eq!(
        RenderSettings {
            sampling_pattern: SamplingPattern::ZSobol,
            ..Default::default()
        }
        .l0(1, 0)
        .sampling_pattern,
        1
    );
    assert_eq!(settings.quality(), 3);
    let plain = RenderSettings {
        bevel: false,
        dispersion_wavelengths: 1,
        ..Default::default()
    };
    assert_eq!(plain.quality(), 0);
    let scaled = RenderSettings {
        size: RenderSize::Scale(0.5),
        ..Default::default()
    };
    assert_eq!(scaled.resolve_size([301, 3]), [151, 2]);
    let tiny = RenderSettings {
        size: RenderSize::Scale(0.01),
        ..Default::default()
    };
    assert_eq!(tiny.resolve_size([10, 10]), [1, 1]);
    let fixed = RenderSettings {
        size: RenderSize::Fixed {
            width: 7,
            height: 5,
        },
        ..Default::default()
    };
    assert_eq!(fixed.resolve_size([300, 150]), [7, 5]);
}

fn word(bytes: &[u8], index: usize) -> u32 {
    u32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().unwrap())
}
fn set_word(bytes: &mut [u8], index: usize, value: u32) {
    bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
}

#[test]
fn descriptor_override_replaces_only_render_owned_fields() {
    let mut scene = lit_scene();
    set_word(&mut scene, h::QUALITY_FLAGS, 4 | 1);
    let camera = Camera {
        fov: 30.,
        ..Default::default()
    }
    .to_bytes();
    let bytes = override_descriptor(&scene, [33, 21], 2, Some(&camera)).unwrap();
    assert_eq!(bytes.len(), scene.len());
    assert_eq!(word(&bytes, h::WIDTH), 33);
    assert_eq!(word(&bytes, h::HEIGHT), 21);
    // The hidden-background bit belongs to the scene; bevel/dispersion to the render.
    assert_eq!(word(&bytes, h::QUALITY_FLAGS), 4 | 2);
    let at = camera_offset(&scene).unwrap();
    assert_eq!(&bytes[at..at + 128], &camera);
    for (index, (a, b)) in scene.chunks(4).zip(bytes.chunks(4)).enumerate() {
        let camera_words = at / 4..at / 4 + 32;
        if ![h::WIDTH, h::HEIGHT, h::QUALITY_FLAGS].contains(&index)
            && !camera_words.contains(&index)
        {
            assert_eq!(a, b, "word {index}");
        }
    }
    // The shared variant reuses the scene when nothing changes and copies otherwise.
    let shared = Arc::new(bytes.clone());
    let same = override_shared(&shared, [33, 21], 2, Some(&camera)).unwrap();
    assert!(Arc::ptr_eq(&same, &shared));
    for (size, quality, camera) in [([34, 21], 2, Some(&camera)), ([33, 21], 0, None)] {
        let other = override_shared(&shared, size, quality, camera).unwrap();
        assert!(!Arc::ptr_eq(&other, &shared));
        assert_eq!(
            *other,
            override_descriptor(&shared, size, quality, camera).unwrap()
        );
    }
    let unaligned = Arc::new(scene[..scene.len() - 2].to_vec());
    assert!(override_shared(&unaligned, [1, 1], 0, None).is_err());
    let kept = override_descriptor(&scene, [1, 1], 0, None).unwrap();
    assert_eq!(&kept[at..at + 128], &scene[at..at + 128]);
    assert_eq!(word(&kept, h::QUALITY_FLAGS), 4);

    assert!(override_descriptor(&scene[..64], [1, 1], 0, None).is_err());
    assert!(override_descriptor(&scene[..scene.len() - 2], [1, 1], 0, None).is_err());
    let mut version = scene.clone();
    set_word(&mut version, h::VERSION, 3);
    assert!(override_descriptor(&version, [1, 1], 0, None).is_err());
    let mut outside = scene.clone();
    set_word(
        &mut outside,
        h::CAMERA_OFFSET,
        (scene.len() / 4 - 31) as u32,
    );
    let failure = override_descriptor(&outside, [1, 1], 0, None).unwrap_err();
    assert_eq!(failure.status, Status::InvalidArgument);
}

#[test]
fn camera_record_round_trips_and_matches_c_default() {
    let camera = Camera::default();
    let bytes = camera.to_bytes();
    assert_eq!(Camera::from_bytes(&bytes), Some(camera));
    assert_eq!(Camera::from_bytes(&bytes[..127]), None);
    // mt_camera_v4_default(): perspective, 45°, 0.1–1000, unit ortho box, zoom 1.
    assert_eq!(word(&bytes, 0), 0);
    assert_eq!(f32::from_bits(word(&bytes, 1)), 45.);
    assert_eq!(f32::from_bits(word(&bytes, 10)), 10.);
    assert_eq!(f32::from_bits(word(&bytes, 11)), 24.);
    assert_eq!(f32::from_bits(word(&bytes, 16)), 1.);
    assert_eq!(f32::from_bits(word(&bytes, 31)), 1.);
    let scene = lit_scene();
    let at = camera_offset(&scene).unwrap();
    let parsed = Camera::from_bytes(&scene[at..at + 128]).unwrap();
    assert_eq!(parsed.to_bytes(), scene[at..at + 128]);
}

#[test]
fn present_selection_follows_the_browser_rule() {
    let none = Readiness::default();
    let complete = Readiness {
        complete: true,
        presentable: false,
    };
    let ready = Readiness {
        complete: true,
        presentable: true,
    };
    // No fallback: the final channel needs only a complete image.
    assert_eq!(select(true, complete, None), Some(Selection::Render));
    assert_eq!(select(true, none, None), None);
    // With a fallback, the final channel waits for a presentable render.
    assert_eq!(
        select(true, complete, Some(ready)),
        Some(Selection::Fallback)
    );
    assert_eq!(select(true, ready, Some(ready)), Some(Selection::Render));
    assert_eq!(select(true, none, Some(complete)), None);
    assert_eq!(select(true, none, Some(none)), None);
    // Other channels use completeness for both.
    assert_eq!(
        select(false, complete, Some(ready)),
        Some(Selection::Render)
    );
    assert_eq!(
        select(false, none, Some(complete)),
        Some(Selection::Fallback)
    );
    assert_eq!(select(false, none, Some(none)), None);
}

#[test]
fn rows_flip_to_top_first() {
    let data: Vec<f32> = (0..2 * 3 * 4).map(|v| v as f32).collect();
    let flipped = flip_rows(&data, 2, 3);
    assert_eq!(&flipped[..8], &data[16..24]);
    assert_eq!(&flipped[8..16], &data[8..16]);
    assert_eq!(&flipped[16..], &data[..8]);
    assert_eq!(flip_rows(&flipped, 2, 3), data);
}

#[test]
fn display_settings_map_to_the_shared_composition() {
    let settings = DisplaySettings {
        tone_mapping: ToneMapping::Reinhard,
        tone_mapping_exposure: 2.,
        contrast: 1.5,
        saturation: 0.5,
        temperature: -0.25,
        tint: 0.75,
        channel: Channel::Albedo,
    };
    let composition = settings.composition();
    assert_eq!(composition.tone_mapping, 3);
    assert_eq!(composition.output, 2);
    assert_eq!(composition.exposure, 2.);
    assert_eq!(composition.contrast, 1.5);
    assert_eq!(composition.saturation, 0.5);
    assert_eq!(composition.temperature, -0.25);
    assert_eq!(composition.tint, 0.75);
    assert!(composition.preserve_alpha);
    for (mode, code) in [
        (ToneMapping::Agx, 0),
        (ToneMapping::Aces, 1),
        (ToneMapping::Cineon, 2),
        (ToneMapping::Linear, 4),
    ] {
        let s = DisplaySettings {
            tone_mapping: mode,
            ..Default::default()
        };
        assert_eq!(s.composition().tone_mapping, code);
    }
    assert_eq!(
        DisplaySettings {
            channel: Channel::Normal,
            ..Default::default()
        }
        .composition()
        .output,
        1
    );
}

/// 16×12 lit scene: a diffuse quad, a small emissive quad and a directional light,
/// seen by an off-axis camera so rows and columns differ.
pub(super) fn lit_scene() -> Vec<u8> {
    let mut w = vec![0u32; 210];
    let f = |x: f32| x.to_bits();
    w[..15].copy_from_slice(&[4, 210, 16, 12, 1, 2, 2, 1, 0, 32, 44, 84, 132, 160, 160]);
    w[16..20].copy_from_slice(&[f(0.05), f(0.07), f(0.1), f(1.)]);
    w[32..36].copy_from_slice(&[4, 6, 192, 204]);
    for (mesh, material, transform) in [
        (
            44,
            0,
            [
                1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
            ],
        ),
        (
            64,
            1,
            [
                0.3, 0., 0., 0., 0., 0.3, 0., 0., 0., 0., 0.3, 0., 0.5, 0.4, 0.6, 1.,
            ],
        ),
    ] {
        w[mesh + 1] = material;
        for (k, v) in transform.into_iter().enumerate() {
            w[mesh + 4 + k] = f(v);
        }
    }
    for (material, base, emission, luminance) in [
        (84, [0.8, 0.6, 0.4], [0., 0., 0.], 0.),
        (108, [1., 1., 1.], [1., 0.9, 0.7], 4.),
    ] {
        for k in 0..3 {
            w[material + k] = f(base[k]);
            w[material + 7 + k] = f(emission[k]);
        }
        w[material + 3] = f(0.5);
        w[material + 6] = f(1.5);
        w[material + 10] = f(luminance);
        w[material + 13] = f(1.);
        for k in 15..19 {
            w[material + k] = u32::MAX;
        }
    }
    w[132] = 2;
    w[133..137].copy_from_slice(&[f(1.), f(1.), f(1.), f(3.)]);
    for k in [0, 5, 10, 15] {
        w[144 + k] = f(1.);
    }
    for (k, x) in [
        (1, 45.),
        (2, 0.1),
        (3, 100.),
        (4, -1.),
        (5, 1.),
        (6, -1.),
        (7, 1.),
        (8, 1.),
        (10, 10.),
        (11, 24.),
        (12, 1.),
    ] {
        w[160 + k] = f(x);
    }
    for k in [0, 5, 10, 15] {
        w[176 + k] = f(1.);
    }
    w[176 + 12] = f(0.2);
    w[176 + 13] = f(0.1);
    w[176 + 14] = f(4.);
    for (k, x) in [-1., -1., 0., 1., -1., 0., 1., 1., 0., -1., 1., 0.]
        .into_iter()
        .enumerate()
    {
        w[192 + k] = f(x);
    }
    w[204..210].copy_from_slice(&[0, 1, 2, 0, 2, 3]);
    w.into_iter().flat_map(u32::to_le_bytes).collect()
}

// ---- GPU oracle: L1 images equal a fresh L0 context given the same overridden
// descriptor and settings, byte for byte (software; fixed seed).

pub(super) fn software_engine(backend: Backend) -> Option<Engine> {
    Engine::new(EngineOptions { backend }).ok()
}
/// Independent expectation of `override_descriptor`.
pub(super) fn expected_descriptor(
    scene: &[u8],
    size: [u32; 2],
    quality: u32,
    camera: Option<&Camera>,
) -> Vec<u8> {
    let mut bytes = scene.to_vec();
    set_word(&mut bytes, h::WIDTH, size[0]);
    set_word(&mut bytes, h::HEIGHT, size[1]);
    let flags = word(scene, h::QUALITY_FLAGS) & 4;
    set_word(&mut bytes, h::QUALITY_FLAGS, flags | quality);
    if let Some(camera) = camera {
        let at = word(scene, h::CAMERA_OFFSET) as usize * 4;
        bytes[at..at + 128].copy_from_slice(&camera.to_bytes());
    }
    bytes
}
fn l0_check(code: i32, error: &[i8]) {
    let message: Vec<u8> = error
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    assert_eq!(code, 0, "{}", String::from_utf8_lossy(&message));
}
/// HDR, normal and albedo of a new L0 context, top row first.
pub(super) fn oracle(
    backend: u32,
    descriptor: &[u8],
    settings: &crate::settings::RenderSettings,
    samples: u32,
) -> [Vec<f32>; 3] {
    let mut error = [0i8; 1024];
    let mut handle = 0;
    unsafe {
        l0_check(
            context::mt_context_create_with_backend(
                backend,
                &mut handle,
                error.as_mut_ptr(),
                error.len(),
            ),
            &error,
        );
        l0_check(
            context::mt_context_commit_with_settings(
                handle,
                descriptor.as_ptr(),
                descriptor.len(),
                settings,
                error.as_mut_ptr(),
                error.len(),
            ),
            &error,
        );
        l0_check(
            context::mt_context_render(handle, samples, error.as_mut_ptr(), error.len()),
            &error,
        );
    }
    let size = [word(descriptor, h::WIDTH), word(descriptor, h::HEIGHT)];
    let images = [0, 1, 2].map(|kind| {
        let mut bytes = vec![0u8; size[0] as usize * size[1] as usize * 16];
        let mut written = 0;
        unsafe {
            l0_check(
                context::mt_context_read_pixels(
                    handle,
                    kind,
                    bytes.as_mut_ptr(),
                    bytes.len(),
                    &mut written,
                    error.as_mut_ptr(),
                    error.len(),
                ),
                &error,
            );
        }
        let data: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        flip_rows(&data, size[0], size[1])
    });
    unsafe {
        l0_check(
            context::mt_context_destroy(handle, error.as_mut_ptr(), error.len()),
            &error,
        );
    }
    images
}
pub(super) fn images(render: &Render) -> [Vec<f32>; 3] {
    [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo]
        .map(|kind| render.read_pixels(kind).unwrap().data)
}
pub(super) fn assert_bytes(actual: &[Vec<f32>; 3], expected: &[Vec<f32>; 3], what: &str) {
    for (kind, (a, b)) in ["hdr", "normal", "albedo"]
        .iter()
        .zip(actual.iter().zip(expected))
    {
        assert_eq!(a.len(), b.len(), "{what}: {kind} length");
        let first = a
            .iter()
            .zip(b)
            .position(|(x, y)| x.to_bits() != y.to_bits());
        assert!(
            first.is_none(),
            "{what}: {kind} differs at float {first:?}: {:?} vs {:?}",
            first.map(|i| a[i]),
            first.map(|i| b[i])
        );
    }
}
pub(super) fn finish(render: &Render) -> RenderStatus {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let status = render.refine().unwrap();
        if matches!(status, RenderStatus::Finished | RenderStatus::Error) {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "render did not finish: {status:?}"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn last_commit(render: &Render) -> u32 {
    let handle = render.engine().lock().renders[&render.id()].context();
    let mut info = context::ContextInfo {
        struct_size: std::mem::size_of::<context::ContextInfo>() as u32,
        width: 0,
        height: 0,
        samples: 0,
        state: 0,
        last_commit: 0,
    };
    let mut error = [0i8; 256];
    unsafe {
        l0_check(
            context::mt_context_info(handle, &mut info, error.as_mut_ptr(), error.len()),
            &error,
        );
    }
    info.last_commit
}

fn primary_oracle(backend: Backend) -> Option<Vec<String>> {
    let engine = software_engine(backend)?;
    let code = backend.code();
    let mut notes = Vec::new();
    let display = engine.display();
    display.set_size(16, 12).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = events.clone();
    let _subscription = engine.on(move |event| recorded.lock().unwrap().push(event.clone()));
    let first = RenderSettings {
        max_samples: 6,
        allow_multiple_samples_per_frame: true,
        ..Default::default()
    };
    let second = RenderSettings {
        max_samples: 5,
        bevel: false,
        dispersion_wavelengths: 1,
        sampling_pattern: SamplingPattern::ZSobol,
        seed: 7,
        direct_light_candidates: 2,
        bounces: 4,
        size: RenderSize::Fixed {
            width: 10,
            height: 7,
        },
        ..Default::default()
    };
    let a = Render::new(&engine, first.clone()).unwrap();
    let b = Render::new(&engine, second.clone()).unwrap();
    assert_eq!(a.status(), RenderStatus::Preparing);
    assert_eq!(a.refine().unwrap(), RenderStatus::Preparing);
    assert!(display.present(&a).unwrap().is_none());
    let samples = Arc::new(Mutex::new(Vec::new()));
    let seen = samples.clone();
    let _sample_subscription = a.on_sample(move |event| seen.lock().unwrap().push(*event));

    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    assert!(engine.update().unwrap());
    assert!(!engine.update().unwrap());
    assert_eq!(finish(&a), RenderStatus::Finished);
    assert_eq!(finish(&b), RenderStatus::Finished);
    assert_eq!((a.samples(), b.samples()), (6, 5));
    assert!(a.converged());
    assert_eq!(
        (a.width(), a.height(), b.width(), b.height()),
        (16, 12, 10, 7)
    );
    let sample_events = samples.lock().unwrap().clone();
    assert_eq!(sample_events.last().unwrap().samples, 6);
    assert!(sample_events[0].is_first_frame && !sample_events.last().unwrap().is_first_frame);
    notes.push(format!(
        "sample batches of render A: {:?}",
        sample_events.iter().map(|e| e.samples).collect::<Vec<_>>()
    ));
    let expected_a = oracle(
        code,
        &expected_descriptor(&scene, [16, 12], 3, None),
        &first.l0(6, 0),
        6,
    );
    let actual_a = images(&a);
    assert!(
        actual_a[0].chunks(4).any(|p| p[0] != actual_a[0][0]),
        "test scene renders a uniform image"
    );
    assert_bytes(&actual_a, &expected_a, "render A");
    assert_bytes(
        &images(&b),
        &oracle(
            code,
            &expected_descriptor(&scene, [10, 7], 0, None),
            &second.l0(5, 0),
            5,
        ),
        "render B",
    );
    notes.push(
        "multiple renders: A (scale, multi-sample batches) and B (fixed, other settings) exact"
            .into(),
    );
    // Row order: L1 row 0 is L0's last row.
    let hdr = a.read_pixels(PixelKind::Hdr).unwrap();
    let row = 16 * 4;
    assert_eq!((hdr.width, hdr.height), (16, 12));
    let bottom_first = flip_rows(&expected_a[0], 16, 12);
    assert_ne!(hdr.data, bottom_first, "test image is vertically symmetric");
    for y in 0..12 {
        assert_eq!(
            hdr.data[y * row..(y + 1) * row],
            bottom_first[(11 - y) * row..(12 - y) * row]
        );
    }

    // Display: present and export the same composition as the existing display path.
    let presented = display.present(&a).unwrap().unwrap();
    assert_eq!(
        presented,
        Presented {
            fallback: false,
            width: 16,
            height: 12,
            samples: 6
        }
    );
    let texture = display.texture().unwrap();
    assert_eq!((texture.width(), texture.height()), (16, 12));
    let (width, height, rgba) = display.read_rgba8(&a).unwrap();
    assert_eq!((width, height), (16, 12));
    let mut reference = None;
    let mut error = [0i8; 512];
    let mut handle = 0;
    let descriptor = expected_descriptor(&scene, [16, 12], 3, None);
    unsafe {
        l0_check(
            context::mt_context_create_with_backend(code, &mut handle, error.as_mut_ptr(), 512),
            &error,
        );
        l0_check(
            context::mt_context_commit_with_settings(
                handle,
                descriptor.as_ptr(),
                descriptor.len(),
                &first.l0(6, 0),
                error.as_mut_ptr(),
                512,
            ),
            &error,
        );
        l0_check(
            context::mt_context_render(handle, 6, error.as_mut_ptr(), 512),
            &error,
        );
    }
    assert!(context::capture_display(handle, &mut reference).unwrap());
    let composition = display.settings().composition();
    assert_eq!(
        reference.as_ref().unwrap().read_rgba(&composition).unwrap(),
        rgba
    );
    unsafe {
        l0_check(
            context::mt_context_destroy(handle, error.as_mut_ptr(), 512),
            &error,
        );
    }
    let png = display.encode_png(&a).unwrap();
    assert_eq!(&png[1..4], b"PNG");
    // Linear scaling to a larger display; B is smaller than the display.
    assert!(display.present(&b).unwrap().is_some());
    notes.push("display read_rgba8 equals display.rs composition of a fresh L0 capture".into());

    // Incremental material edit: synchronous in update, then exact.
    let mut edited = scene.clone();
    set_word(&mut edited, 84 + 1, 0.2f32.to_bits());
    engine.set_scene(&edited).unwrap();
    assert!(engine.update().unwrap());
    assert_eq!(last_commit(&a), context::COMMIT_INCREMENTAL);
    assert_eq!(last_commit(&b), context::COMMIT_INCREMENTAL);
    assert_eq!(a.status(), RenderStatus::Converging);
    assert_eq!(a.samples(), 0);
    assert_eq!(finish(&a), RenderStatus::Finished);
    assert_eq!(finish(&b), RenderStatus::Finished);
    assert_bytes(
        &images(&a),
        &oracle(
            code,
            &expected_descriptor(&edited, [16, 12], 3, None),
            &first.l0(6, 0),
            6,
        ),
        "render A after material edit",
    );
    assert_bytes(
        &images(&b),
        &oracle(
            code,
            &expected_descriptor(&edited, [10, 7], 0, None),
            &second.l0(5, 0),
            5,
        ),
        "render B after material edit",
    );
    // Engine camera: incremental camera record replacement in every render.
    let mut camera = Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap();
    camera.world_matrix[12] = -0.3;
    camera.fov = 40.;
    engine.set_camera(Some(camera)).unwrap();
    assert!(engine.update().unwrap());
    assert_eq!(last_commit(&a), context::COMMIT_INCREMENTAL);
    assert_eq!(finish(&a), RenderStatus::Finished);
    assert_bytes(
        &images(&a),
        &oracle(
            code,
            &expected_descriptor(&edited, [16, 12], 3, Some(&camera)),
            &first.l0(6, 0),
            6,
        ),
        "render A after camera edit",
    );
    notes.push("incremental material and camera edits: COMMIT_INCREMENTAL, exact".into());

    // Settings change: full preparation of this render only.
    let changed = RenderSettings {
        max_samples: 4,
        bounces: 2,
        bevel_samples: 3,
        ..first.clone()
    };
    a.set_settings(changed.clone()).unwrap();
    assert_eq!(finish(&a), RenderStatus::Finished);
    assert_eq!(last_commit(&a), context::COMMIT_FULL);
    assert_bytes(
        &images(&a),
        &oracle(
            code,
            &expected_descriptor(&edited, [16, 12], 3, Some(&camera)),
            &changed.l0(4, 0),
            4,
        ),
        "render A after settings change",
    );
    // Display resize: the scale-based render follows; the fixed render does not.
    display.set_size(20, 9).unwrap();
    assert_eq!(finish(&a), RenderStatus::Finished);
    assert_eq!((a.width(), a.height()), (20, 9));
    assert_eq!(finish(&b), RenderStatus::Finished);
    assert_eq!(b.width(), 10);
    assert_bytes(
        &images(&a),
        &oracle(
            code,
            &expected_descriptor(&edited, [20, 9], 3, Some(&camera)),
            &changed.l0(4, 0),
            4,
        ),
        "render A after display resize",
    );
    notes.push("settings change and display resize: full preparation, exact".into());

    // Restart keeps settings and reproduces the same accumulation.
    a.restart().unwrap();
    assert_eq!(a.samples(), 0);
    assert!(display.present(&a).unwrap().is_none());
    assert_eq!(finish(&a), RenderStatus::Finished);
    assert_bytes(
        &images(&a),
        &oracle(
            code,
            &expected_descriptor(&edited, [20, 9], 3, Some(&camera)),
            &changed.l0(4, 0),
            4,
        ),
        "render A after restart",
    );
    let events = events.lock().unwrap().clone();
    assert!(events.contains(&EngineEvent::Progress {
        stage: ProgressStage::Preparation,
        progress: 1.
    }));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, EngineEvent::Error { .. })),
        "{events:?}"
    );
    Some(notes)
}

#[test]
fn renders_match_fresh_l0_contexts_across_edits_settings_and_sizes() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(notes) = primary_oracle(Backend::Software) {
        for note in notes {
            println!("software oracle: {note}");
        }
    }
}

/// Known Metal HWRT limitations make this a recorded observation, run explicitly.
#[test]
#[ignore]
fn hardware_renders_match_fresh_l0_contexts() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let engine = software_engine(Backend::Hardware).unwrap();
    assert!(engine.info().hardware_ray_query, "no hardware ray queries");
    drop(engine);
    for note in primary_oracle(Backend::Hardware).unwrap() {
        println!("hardware oracle: {note}");
    }
}

#[test]
fn full_preparation_keeps_the_previous_image_and_publishes_atomically() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let display = engine.display();
    display.set_size(16, 12).unwrap();
    let settings = RenderSettings {
        max_samples: 3,
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    let other = Render::new(
        &engine,
        RenderSettings {
            max_samples: 2,
            size: RenderSize::Fixed {
                width: 8,
                height: 6,
            },
            ..Default::default()
        },
    )
    .unwrap();
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    assert_eq!(finish(&render), RenderStatus::Finished);
    assert_eq!(finish(&other), RenderStatus::Finished);
    assert!(display.present(&render).unwrap().is_some());
    let shown = display.read_rgba8(&render).unwrap();
    let before = images(&render);

    // Hold the AOT runtime so the full preparation cannot finish.
    let (started, entered) = mpsc::sync_channel(1);
    let (resume, resumed) = mpsc::sync_channel::<()>(1);
    crate::runtime::enqueue(move || {
        started.send(()).unwrap();
        let _ = resumed.recv_timeout(Duration::from_secs(60));
    });
    entered.recv().unwrap();
    let changed = RenderSettings {
        bevel_samples: 4,
        ..settings.clone()
    };
    render.set_settings(changed.clone()).unwrap();
    for _ in 0..20 {
        assert_eq!(render.refine().unwrap(), RenderStatus::Preparing);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(render.status(), RenderStatus::Preparing);
    assert_eq!(render.samples(), 0);
    assert!(display.present(&render).unwrap().is_none());
    assert!(display.read_rgba8(&render).is_err());
    // The previous accumulation stays readable; the other render keeps working.
    assert_bytes(
        &images(&render),
        &before,
        "previous image during preparation",
    );
    other.restart().unwrap();
    assert_eq!(finish(&other), RenderStatus::Finished);
    assert!(display.present(&other).unwrap().is_some());
    resume.send(()).unwrap();
    assert_eq!(finish(&render), RenderStatus::Finished);
    assert_bytes(
        &images(&render),
        &oracle(
            0,
            &expected_descriptor(&scene, [16, 12], 3, None),
            &changed.l0(3, 0),
            3,
        ),
        "after preparation",
    );
    assert!(display.present(&render).unwrap().is_some());
    assert_ne!(display.read_rgba8(&render).unwrap(), shown);
}

#[test]
fn converge_matches_l0_and_reports_progress_and_cancellation() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let settings = RenderSettings {
        size: RenderSize::Fixed {
            width: 12,
            height: 9,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    assert_eq!(
        render.converge(ConvergeOptions::new(3)).unwrap_err().status,
        Status::InvalidState
    );
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let mut camera = Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap();
    camera.world_matrix[13] = 0.4;
    let progress = Arc::new(Mutex::new(Vec::new()));
    let recorded = progress.clone();
    let mut options = ConvergeOptions::new(7);
    options.samples_per_batch = 3;
    options.sample_sequence_offset = 2;
    options.camera = Some(camera);
    options.on_progress = Some(Box::new(move |p| recorded.lock().unwrap().push(p)));
    assert_eq!(
        render.converge(options).unwrap(),
        ConvergeResult { samples: 7 }
    );
    assert_eq!(render.status(), RenderStatus::Finished);
    assert_eq!(render.samples(), 7);
    let progress: Vec<u32> = progress.lock().unwrap().iter().map(|p| p.samples).collect();
    assert_eq!(progress, vec![3, 6, 7]);
    assert_bytes(
        &images(&render),
        &oracle(
            0,
            &expected_descriptor(&scene, [12, 9], 3, Some(&camera)),
            &settings.l0(7, 2),
            7,
        ),
        "converge",
    );
    // The same converge again restarts and reproduces the image.
    let mut again = ConvergeOptions::new(7);
    again.samples_per_batch = 64;
    again.sample_sequence_offset = 2;
    again.camera = Some(camera);
    render.converge(again).unwrap();
    assert_bytes(
        &images(&render),
        &oracle(
            0,
            &expected_descriptor(&scene, [12, 9], 3, Some(&camera)),
            &settings.l0(7, 2),
            7,
        ),
        "repeated converge",
    );
    // Cancellation from the progress callback.
    let token = CancelToken::new();
    let cancel = token.clone();
    let mut cancelled = ConvergeOptions::new(40);
    cancelled.samples_per_batch = 2;
    cancelled.cancel = Some(token);
    cancelled.on_progress = Some(Box::new(move |_| cancel.cancel()));
    assert_eq!(
        render.converge(cancelled).unwrap_err().status,
        Status::Cancelled
    );
    assert_eq!(render.status(), RenderStatus::Error);
    // The cancelled converge used the interactive key (Sobol, offset 0, no camera),
    // so refine keeps its partial accumulation, as in the browser library.
    let interactive = RenderSettings {
        max_samples: 2,
        ..settings
    };
    render.set_settings(interactive.clone()).unwrap();
    assert_eq!(finish(&render), RenderStatus::Finished);
    let kept = render.samples();
    assert!(kept >= 2, "{kept}");
    assert_bytes(
        &images(&render),
        &oracle(
            0,
            &expected_descriptor(&scene, [12, 9], 3, None),
            &interactive.l0(interactive.sample_cap(2), 0),
            kept,
        ),
        "refine after cancelled converge",
    );
}

#[test]
fn fallback_is_presented_until_the_render_is_complete() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let display = engine.display();
    display.set_size(16, 12).unwrap();
    let preview = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            size: RenderSize::Scale(0.5),
            ..Default::default()
        },
    )
    .unwrap();
    let main = Render::new(
        &engine,
        RenderSettings {
            max_samples: 4,
            ..Default::default()
        },
    )
    .unwrap();
    main.set_fallback(Some(&preview)).unwrap();
    assert_eq!(
        preview.set_fallback(Some(&main)).unwrap_err().status,
        Status::InvalidArgument
    );
    assert_eq!(
        main.set_fallback(Some(&main)).unwrap_err().status,
        Status::InvalidArgument
    );
    let third = Render::new(&engine, RenderSettings::default()).unwrap();
    assert_eq!(
        third.set_fallback(Some(&main)).unwrap_err().status,
        Status::InvalidArgument
    );
    engine.set_scene(&lit_scene()).unwrap();
    engine.update().unwrap();
    // Only the main render is refined; it drives its fallback.
    assert_eq!(finish(&main), RenderStatus::Finished);
    assert!(!display.present(&main).unwrap().unwrap().fallback);

    // While the main render prepares, refining it refines the fallback, which is shown.
    let (started, entered) = mpsc::sync_channel(1);
    let (resume, resumed) = mpsc::sync_channel::<()>(1);
    crate::runtime::enqueue(move || {
        started.send(()).unwrap();
        let _ = resumed.recv_timeout(Duration::from_secs(60));
    });
    entered.recv().unwrap();
    main.set_settings(RenderSettings {
        max_samples: 4,
        bevel_samples: 5,
        ..Default::default()
    })
    .unwrap();
    preview.restart().unwrap();
    assert_eq!(preview.samples(), 0);
    let deadline = Instant::now() + Duration::from_secs(60);
    let presented = loop {
        assert_eq!(main.refine().unwrap(), RenderStatus::Preparing);
        if let Some(presented) = display.present(&main).unwrap() {
            break presented;
        }
        assert!(Instant::now() < deadline, "fallback never presented");
        std::thread::sleep(Duration::from_millis(1));
    };
    assert_eq!(
        presented,
        Presented {
            fallback: true,
            width: 8,
            height: 6,
            samples: 1
        }
    );
    assert_eq!(preview.samples(), 1);
    // The fallback stops at one sample.
    for _ in 0..5 {
        main.refine().unwrap();
    }
    assert_eq!(preview.samples(), 1);
    resume.send(()).unwrap();
    assert_eq!(finish(&main), RenderStatus::Finished);
    assert!(!display.present(&main).unwrap().unwrap().fallback);
    // Dropping the fallback detaches it.
    drop(preview);
    assert!(engine.lock().renders[&main.id()].fallback.is_none());
    // Another engine's render is rejected.
    if let Some(other) = software_engine(Backend::Software) {
        let foreign = Render::new(&other, RenderSettings::default()).unwrap();
        assert_eq!(
            display.present(&foreign).unwrap_err().status,
            Status::InvalidArgument
        );
        assert_eq!(
            main.set_fallback(Some(&foreign)).unwrap_err().status,
            Status::InvalidArgument
        );
    }
    engine.dispose();
    assert_eq!(main.refine().unwrap_err().status, Status::InvalidHandle);
    assert_eq!(engine.update().unwrap_err().status, Status::InvalidHandle);
    assert_eq!(main.status(), RenderStatus::Error);
}

#[test]
fn invalid_scenes_report_errors_without_stopping_other_renders() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    assert_eq!(
        engine.set_scene(&[0; 16]).unwrap_err().status,
        Status::InvalidArgument
    );
    let errors = Arc::new(Mutex::new(0));
    let counted = errors.clone();
    engine
        .on(move |event| {
            if matches!(event, EngineEvent::Error { .. }) {
                *counted.lock().unwrap() += 1;
            }
        })
        .detach();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            size: RenderSize::Fixed {
                width: 4,
                height: 4,
            },
            ..Default::default()
        },
    )
    .unwrap();
    // A bad mesh reference passes the header check and fails preparation.
    let mut broken = lit_scene();
    set_word(&mut broken, 44, 9);
    engine.set_scene(&broken).unwrap();
    engine.update().unwrap();
    assert_eq!(finish(&render), RenderStatus::Error);
    assert!(engine.last_error().is_some());
    assert_eq!(*errors.lock().unwrap(), 1);
    // Refining the same failed inputs does not report again.
    assert_eq!(render.refine().unwrap(), RenderStatus::Error);
    assert_eq!(*errors.lock().unwrap(), 1);
    engine.set_scene(&lit_scene()).unwrap();
    engine.update().unwrap();
    assert_eq!(finish(&render), RenderStatus::Finished);
}

/// Needs `MUTRACER_OIDN_LIBRARY`; uses CPU OIDN so the direct filter is a byte oracle.
#[test]
fn converged_oidn_matches_direct_filtering_of_the_same_inputs() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(library) = std::env::var_os("MUTRACER_OIDN_LIBRARY") else {
        return;
    };
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let settings = RenderSettings {
        max_samples: 4,
        size: RenderSize::Fixed {
            width: 16,
            height: 12,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    let options = DenoiserOptions {
        backend: 1,
        library: Some(library.clone().into()),
        schedule: DenoiseSchedule::Converged,
    };
    assert_eq!(
        render
            .set_denoiser(Some(DenoiserOptions {
                backend: 5,
                ..options.clone()
            }))
            .unwrap_err()
            .status,
        Status::InvalidArgument
    );
    render.set_denoiser(Some(options.clone())).unwrap();
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let mut statuses = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let status = render.refine().unwrap();
        if statuses.last() != Some(&status) {
            statuses.push(status);
        }
        if status == RenderStatus::Finished {
            break;
        }
        assert_ne!(status, RenderStatus::Error, "{:?}", engine.last_error());
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(statuses.contains(&RenderStatus::Denoising), "{statuses:?}");
    assert!(!render.denoising());
    let inputs = oracle(
        0,
        &expected_descriptor(&scene, [16, 12], 3, None),
        &settings.l0(4, 0),
        4,
    )
    .map(|image| flip_rows(&image, 16, 12));
    let mut filter = crate::denoise::Denoiser::from_library(library.as_ref(), 1).unwrap();
    let expected = flip_rows(
        &filter
            .run([16, 12], &inputs[0], &inputs[1], &inputs[2])
            .unwrap(),
        16,
        12,
    );
    let denoised = render.read_pixels(PixelKind::Denoised).unwrap().data;
    assert_eq!(
        denoised.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    assert_ne!(denoised, render.read_pixels(PixelKind::Hdr).unwrap().data);
    let presented = engine.display().present(&render).unwrap().unwrap();
    assert_eq!(presented.samples, 4);
    // Converge filters before returning and reports the denoising stage.
    let stages = Arc::new(Mutex::new(Vec::new()));
    let recorded = stages.clone();
    let mut converge = ConvergeOptions::new(4);
    converge.on_progress = Some(Box::new(move |p| recorded.lock().unwrap().push(p.stage)));
    render.converge(converge).unwrap();
    assert_eq!(
        stages.lock().unwrap().last(),
        Some(&ConvergeStage::Denoising)
    );
    let again = render.read_pixels(PixelKind::Denoised).unwrap().data;
    assert_eq!(
        again.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    // Disabling the denoiser falls back to HDR.
    render.set_denoiser(None).unwrap();
    assert_eq!(
        render.read_pixels(PixelKind::Denoised).unwrap(),
        render.read_pixels(PixelKind::Hdr).unwrap()
    );
}

#[test]
fn sample_cap_changes_images_only_for_zsobol() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if software_engine(Backend::Software).is_none() {
        return;
    }
    let descriptor = expected_descriptor(&lit_scene(), [16, 12], 3, None);
    for (pattern, independent) in [
        (SamplingPattern::Sobol, true),
        (SamplingPattern::Random, true),
        (SamplingPattern::ZSobol, false),
    ] {
        let settings = RenderSettings {
            sampling_pattern: pattern,
            ..Default::default()
        };
        let small = oracle(0, &descriptor, &settings.l0(5, 0), 5);
        for cap in [6, 64, 4096] {
            let large = oracle(0, &descriptor, &settings.l0(cap, 0), 5);
            if independent {
                assert_bytes(&large, &small, &format!("{pattern:?} cap {cap}"));
            } else if cap == 4096 {
                assert_ne!(large[0], small[0], "zsobol cap had no effect");
            }
        }
    }
}

fn l0_samples(handle: u64) -> std::result::Result<u32, Status> {
    let mut info = context::ContextInfo {
        struct_size: std::mem::size_of::<context::ContextInfo>() as u32,
        width: 0,
        height: 0,
        samples: 0,
        state: 0,
        last_commit: 0,
    };
    let mut error = [0i8; 256];
    let code =
        unsafe { context::mt_context_info(handle, &mut info, error.as_mut_ptr(), error.len()) };
    if code == 0 {
        Ok(info.samples)
    } else {
        Err(super::status_from(code))
    }
}
/// Holds the AOT runtime thread until the returned sender is used or dropped.
fn hold_runtime() -> mpsc::SyncSender<()> {
    let (started, entered) = mpsc::sync_channel(1);
    let (resume, resumed) = mpsc::sync_channel::<()>(1);
    crate::runtime::enqueue(move || {
        started.send(()).unwrap();
        let _ = resumed.recv_timeout(Duration::from_secs(60));
    });
    entered.recv().unwrap();
    resume
}
/// Refines until a batch is in flight right after the call.
fn refine_until_in_flight(render: &Render) {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        render.refine().unwrap();
        let busy = render.engine().lock().renders[&render.id()].in_flight();
        if busy && render.samples() > 0 {
            return;
        }
        assert!(Instant::now() < deadline, "no batch in flight");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn full_preparation_with_a_batch_in_flight_keeps_reads_and_releases_the_context() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let display = engine.display();
    display.set_size(64, 48).unwrap();
    let settings = RenderSettings {
        allow_multiple_samples_per_frame: true,
        time_budget_ms: 1000.,
        ..Default::default()
    };
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let render = Render::new(&engine, settings.clone()).unwrap();
    let handle = render.engine().lock().renders[&render.id()].context();
    refine_until_in_flight(&render);

    // A settings change while a batch runs: full preparation, held on the runtime.
    // (A size change would first try the incremental path on this thread, which
    // itself needs the held runtime.)
    let resume = hold_runtime();
    render
        .set_settings(RenderSettings {
            bevel_samples: 5,
            ..settings.clone()
        })
        .unwrap();
    assert_eq!(render.refine().unwrap(), RenderStatus::Preparing);
    assert!(!render.engine().lock().renders[&render.id()].in_flight());
    let previous = l0_samples(handle).unwrap();
    assert!(previous > 0);
    // Read during preparation; the oracle needs the runtime, so compare afterwards.
    let during = images(&render);
    // Dropping the render while it prepares destroys its context once the
    // cancelled preparation retires.
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        resume.send(()).unwrap();
    });
    drop(render);
    release.join().unwrap();
    assert_eq!(l0_samples(handle), Err(Status::InvalidHandle));
    assert_bytes(
        &during,
        &oracle(
            0,
            &expected_descriptor(&scene, [64, 48], 3, None),
            &settings.l0(settings.sample_cap(settings.max_samples), 0),
            previous,
        ),
        "previous image while preparing",
    );

    // A rejected full preparation keeps the previous image readable.
    let render = Render::new(&engine, settings.clone()).unwrap();
    refine_until_in_flight(&render);
    render
        .set_settings(RenderSettings {
            size: RenderSize::Fixed {
                width: 5000,
                height: 4,
            },
            ..settings.clone()
        })
        .unwrap();
    assert_eq!(finish(&render), RenderStatus::Error);
    assert!(engine.last_error().is_some());
    let handle = render.engine().lock().renders[&render.id()].context();
    let previous = l0_samples(handle).unwrap();
    assert_bytes(
        &images(&render),
        &oracle(
            0,
            &expected_descriptor(&scene, [64, 48], 3, None),
            &settings.l0(settings.sample_cap(settings.max_samples), 0),
            previous,
        ),
        "previous image after a rejected preparation",
    );
    drop(render);
    assert_eq!(l0_samples(handle), Err(Status::InvalidHandle));
}

#[test]
fn callbacks_may_call_back_into_the_api() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let (done, finished) = mpsc::channel();
    std::thread::spawn(move || {
        let render = Arc::new(
            Render::new(
                &engine,
                RenderSettings {
                    max_samples: 4,
                    size: RenderSize::Fixed {
                        width: 16,
                        height: 12,
                    },
                    ..Default::default()
                },
            )
            .unwrap(),
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (reader, recorded) = (render.clone(), seen.clone());
        let samples = render.on_sample(move |event| {
            recorded.lock().unwrap().push(event.samples);
            // Waits for the next in-flight batch, whose event is queued meanwhile.
            assert!(!reader.read_pixels(PixelKind::Hdr).unwrap().data.is_empty());
        });
        let updates = Arc::new(Mutex::new(0));
        let (updater, counted) = (engine.clone(), updates.clone());
        let progress = engine.on(move |event| {
            if matches!(event, EngineEvent::Progress { .. }) {
                assert!(!updater.update().unwrap());
                *counted.lock().unwrap() += 1;
            }
        });
        engine.set_scene(&lit_scene()).unwrap();
        engine.update().unwrap();
        let status = finish(&render);
        let seen = seen.lock().unwrap().clone();
        let updates = *updates.lock().unwrap();
        drop((samples, progress));
        done.send((status, seen, updates)).unwrap();
    });
    let (status, seen, updates) = finished
        .recv_timeout(Duration::from_secs(120))
        .expect("a callback that calls the API deadlocked");
    assert_eq!(status, RenderStatus::Finished);
    assert_eq!(seen, vec![1, 2, 3, 4]);
    assert_eq!(updates, 2);
}

#[test]
fn raising_max_samples_continues_except_for_zsobol() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let preparations = Arc::new(Mutex::new(0));
    let counted = preparations.clone();
    let _progress = engine.on(move |event| {
        if *event
            == (EngineEvent::Progress {
                stage: ProgressStage::Preparation,
                progress: 0.,
            })
        {
            *counted.lock().unwrap() += 1;
        }
    });
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let descriptor = expected_descriptor(&scene, [16, 12], 3, None);
    for pattern in [
        SamplingPattern::Sobol,
        SamplingPattern::Random,
        SamplingPattern::ZSobol,
    ] {
        let settings = RenderSettings {
            sampling_pattern: pattern,
            max_samples: 3,
            size: RenderSize::Fixed {
                width: 16,
                height: 12,
            },
            ..Default::default()
        };
        let render = Render::new(&engine, settings.clone()).unwrap();
        assert_eq!(finish(&render), RenderStatus::Finished);
        let before = *preparations.lock().unwrap();
        let raised = RenderSettings {
            max_samples: 6,
            ..settings.clone()
        };
        render.set_settings(raised.clone()).unwrap();
        let status = render.refine().unwrap();
        if pattern == SamplingPattern::ZSobol {
            assert_eq!(status, RenderStatus::Preparing);
            assert_eq!(render.samples(), 0);
        } else {
            assert_eq!(status, RenderStatus::Converging);
            assert!(render.samples() >= 3, "{pattern:?} restarted");
        }
        assert_eq!(finish(&render), RenderStatus::Finished);
        let prepared = *preparations.lock().unwrap() - before;
        assert_eq!(prepared, usize::from(pattern == SamplingPattern::ZSobol));
        assert_bytes(
            &images(&render),
            &oracle(0, &descriptor, &raised.l0(6, 0), 6),
            &format!("{pattern:?} after raising max_samples"),
        );
        // Converge without offset or camera reuses the prepared scene unless ZSobol.
        let before = *preparations.lock().unwrap();
        render.converge(ConvergeOptions::new(5)).unwrap();
        let prepared = *preparations.lock().unwrap() - before;
        assert_eq!(prepared, usize::from(pattern == SamplingPattern::ZSobol));
        assert_bytes(
            &images(&render),
            &oracle(0, &descriptor, &raised.l0(5, 0), 5),
            &format!("{pattern:?} converge"),
        );
    }
}

#[test]
fn denoise_schedules_choose_the_browser_sample_targets() {
    use super::render::sample_target;
    let converged = Some(DenoiseSchedule::Converged);
    let progressive = Some(DenoiseSchedule::Progressive);
    let every = Some(DenoiseSchedule::EverySample);
    assert_eq!(sample_target(None, 3, 64, 0, None), 64);
    assert_eq!(sample_target(converged, 3, 64, 2, None), 64);
    assert_eq!(sample_target(every, 3, 64, 3, None), 4);
    assert_eq!(sample_target(every, 64, 64, 64, None), 64);
    // Progressive: 1, then max(4, 2 × denoised), capped at max_samples.
    assert_eq!(sample_target(progressive, 0, 64, 0, None), 1);
    let recent = Some(Duration::from_secs(1));
    assert_eq!(sample_target(progressive, 1, 64, 1, recent), 4);
    assert_eq!(sample_target(progressive, 4, 64, 4, recent), 8);
    assert_eq!(sample_target(progressive, 40, 64, 40, recent), 64);
    assert_eq!(sample_target(progressive, 2, 3, 1, recent), 3);
    // Ten seconds without a result: the next sample.
    let stale = Some(Duration::from_secs(10));
    assert_eq!(sample_target(progressive, 9, 64, 8, stale), 10);
}

/// Needs `MUTRACER_OIDN_LIBRARY`; CPU OIDN makes direct filtering a byte oracle.
#[test]
fn progressive_denoising_pauses_sampling_and_keeps_the_last_result() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(library) = std::env::var_os("MUTRACER_OIDN_LIBRARY") else {
        return;
    };
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    for (schedule, expected) in [
        (DenoiseSchedule::Progressive, vec![1, 4, 8, 10]),
        (DenoiseSchedule::EverySample, vec![1, 2, 3]),
    ] {
        let settings = RenderSettings {
            max_samples: *expected.last().unwrap(),
            allow_multiple_samples_per_frame: true,
            time_budget_ms: 1000.,
            size: RenderSize::Fixed {
                width: 16,
                height: 12,
            },
            ..Default::default()
        };
        let render = Render::new(&engine, settings.clone()).unwrap();
        render
            .set_denoiser(Some(DenoiserOptions {
                backend: 1,
                library: Some(library.clone().into()),
                schedule,
            }))
            .unwrap();
        let mut denoised_at = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let before = render.samples();
            let filtering = render.denoising();
            let status = render.refine().unwrap();
            assert_ne!(status, RenderStatus::Error, "{:?}", engine.last_error());
            if filtering && render.denoising() {
                // Sampling pauses while the filter runs.
                assert_eq!(
                    render.samples(),
                    before,
                    "{schedule:?} traced while denoising"
                );
            }
            if let Some(report) = render.denoise_report() {
                assert!(report.error.is_none(), "{report:?}");
                if denoised_at.last() != Some(&report.samples) {
                    denoised_at.push(report.samples);
                    // Every result equals direct filtering of the same inputs.
                    let inputs = oracle(
                        0,
                        &expected_descriptor(&scene, [16, 12], 3, None),
                        &settings.l0(settings.sample_cap(settings.max_samples), 0),
                        report.samples,
                    )
                    .map(|image| flip_rows(&image, 16, 12));
                    let mut filter =
                        crate::denoise::Denoiser::from_library(library.as_ref(), 1).unwrap();
                    let expected = flip_rows(
                        &filter
                            .run([16, 12], &inputs[0], &inputs[1], &inputs[2])
                            .unwrap(),
                        16,
                        12,
                    );
                    let actual = render.read_pixels(PixelKind::Denoised).unwrap().data;
                    assert_eq!(
                        actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                        expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                        "{schedule:?} at {}",
                        report.samples
                    );
                    assert_eq!(report.backend, "OIDN CPU");
                }
            }
            if status == RenderStatus::Finished && !render.denoising() {
                break;
            }
            assert!(Instant::now() < deadline, "{schedule:?} did not finish");
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(denoised_at, expected, "{schedule:?} denoise points");
        // The presented image is the last denoised one.
        let presented = engine.display().present(&render).unwrap().unwrap();
        assert_eq!(presented.samples, settings.max_samples);
        // Disabling and re-enabling keeps the device and filters again.
        render.set_denoiser(None).unwrap();
        assert!(render.denoise_report().is_none());
    }
}

/// Pausing filters the current samples once without tracing; resuming continues
/// the progressive points from there. Denoised images are uploaded once each and
/// stay presented through later captures.
#[test]
fn denoise_current_filters_paused_samples_and_progressive_resumes() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(library) = std::env::var_os("MUTRACER_OIDN_LIBRARY") else {
        return;
    };
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    // One sample per batch, so the pause lands between progressive points.
    let settings = RenderSettings {
        max_samples: 12,
        allow_multiple_samples_per_frame: false,
        size: RenderSize::Fixed {
            width: 16,
            height: 12,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    assert!(!render.denoise_current().unwrap(), "no denoiser");
    render
        .set_denoiser(Some(DenoiserOptions {
            backend: 1,
            library: Some(library.clone().into()),
            schedule: DenoiseSchedule::Progressive,
        }))
        .unwrap();
    let mut filter = crate::denoise::Denoiser::from_library(library.as_ref(), 1).unwrap();
    let mut check = |samples: u32| {
        let inputs = oracle(
            0,
            &expected_descriptor(&scene, [16, 12], 3, None),
            &settings.l0(settings.sample_cap(settings.max_samples), 0),
            samples,
        )
        .map(|image| flip_rows(&image, 16, 12));
        let expected = flip_rows(
            &filter
                .run([16, 12], &inputs[0], &inputs[1], &inputs[2])
                .unwrap(),
            16,
            12,
        );
        let actual = render.read_pixels(PixelKind::Denoised).unwrap().data;
        assert_eq!(
            actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            "denoised at {samples}"
        );
    };
    let uploads = || engine.lock().renders[&render.id()].display_uploads();
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut denoised_at = Vec::new();
    let record = |render: &Render, denoised_at: &mut Vec<u32>| {
        if let Some(report) = render.denoise_report() {
            assert!(report.error.is_none(), "{report:?}");
            if denoised_at.last() != Some(&report.samples) {
                denoised_at.push(report.samples);
                return Some(report.samples);
            }
        }
        None
    };
    // Run until the 4-sample result is shown and one more sample is in flight.
    loop {
        assert_ne!(render.refine().unwrap(), RenderStatus::Error);
        let in_flight = engine.lock().renders[&render.id()].in_flight();
        if let Some(samples) = record(&render, &mut denoised_at) {
            if samples == 4 && render.samples() == 4 && in_flight {
                // Reading pixels would wait for the batch in flight.
                break;
            }
            check(samples);
        }
        assert!(Instant::now() < deadline, "did not reach 4 samples");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(denoised_at, [1, 4]);
    // Paused: the batch in flight is collected, then its samples are filtered once.
    while !render.denoise_current().unwrap() {
        assert!(render.samples() <= 5, "traced while paused");
        assert!(Instant::now() < deadline, "paused filter did not finish");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(render.samples(), 5);
    assert_eq!(record(&render, &mut denoised_at), Some(5));
    check(5);
    assert!(uploads().1, "display shows the denoised image");
    for _ in 0..3 {
        assert!(render.denoise_current().unwrap());
        assert!(!render.denoising());
    }
    assert_eq!(render.samples(), 5);
    let shown = engine.display().read_rgba8(&render).unwrap();
    // Resumed: progressive points continue from the paused result. Captures in
    // between keep the denoised image without uploading it again.
    let mut compared = false;
    loop {
        let status = render.refine().unwrap();
        assert_ne!(status, RenderStatus::Error, "{:?}", engine.last_error());
        let presented = engine.lock().renders[&render.id()].presented_samples();
        if !compared && presented > 5 && denoised_at.last() == Some(&5) {
            assert_eq!(engine.display().read_rgba8(&render).unwrap(), shown);
            compared = true;
        }
        if let Some(samples) = record(&render, &mut denoised_at) {
            check(samples);
        }
        if status == RenderStatus::Finished && !render.denoising() {
            break;
        }
        assert!(Instant::now() < deadline, "did not finish");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        compared,
        "no capture between the paused and the next result"
    );
    assert_eq!(denoised_at, [1, 4, 5, 10, 12]);
    assert_eq!(uploads(), (5, true), "one upload per denoised image");
}

/// A shared scene reaches the L0 context without copies, and `update` treats a new
/// Arc as a change without comparing bytes.
#[test]
fn shared_scenes_are_committed_without_copies() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let settings = RenderSettings {
        max_samples: 3,
        size: RenderSize::Fixed {
            width: 16,
            height: 12,
        },
        ..Default::default()
    };
    // Already the render's size and quality bits, so the render needs no override.
    let bytes = expected_descriptor(&lit_scene(), [16, 12], settings.quality(), None);
    let scene = Arc::new(bytes.clone());
    engine.set_scene_shared(scene.clone()).unwrap();
    let render = Render::new(&engine, settings.clone()).unwrap();
    assert!(engine.update().unwrap());
    assert_eq!(finish(&render), RenderStatus::Finished);
    // The caller, the engine's pending and committed scene, and the L0 context.
    assert_eq!(Arc::strong_count(&scene), 4);
    let expected = oracle(0, &bytes, &settings.l0(3, 0), 3);
    assert_bytes(&images(&render), &expected, "shared scene");
    // The same Arc changes nothing; an equal new one is a change.
    engine.set_scene_shared(scene.clone()).unwrap();
    assert!(!engine.update().unwrap());
    assert_eq!(render.samples(), 3);
    let next = Arc::new(bytes.clone());
    engine.set_scene_shared(next.clone()).unwrap();
    assert!(engine.update().unwrap());
    assert_eq!(render.last_commit().unwrap(), Some(CommitKind::Incremental));
    assert_eq!(Arc::strong_count(&scene), 1);
    assert_eq!(Arc::strong_count(&next), 4);
    assert_eq!(finish(&render), RenderStatus::Finished);
    assert_bytes(&images(&render), &expected, "shared scene after an edit");
    // A copied scene with equal bytes is unchanged, as before.
    engine.set_scene(&bytes).unwrap();
    assert!(!engine.update().unwrap());
}
