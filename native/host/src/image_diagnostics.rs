//! Fixed-sample AOVs with an explicit seed for statistical correctness checks.
use super::*;

pub fn run(input: &[u8], output: &Path, backend: u32, samples: u32, seed: u32) -> Result<()> {
    if backend > 1 || samples == 0 || samples > 4096 {
        return Err("Expected backend 0|1 and samples 1..4096".into());
    }
    let _entry = ENTRY_LOCK.try_lock().map_err(|_| "Native core is active")?;
    context::check_owner()?;
    let gpu = GpuDevice::with_backend(backend)?;
    if backend == 1 && !gpu.hardware_ray_query {
        return Err("Image diagnostic requires actual HWRT".into());
    }
    let (mut scene, mut assets, _retained) =
        scene::prepare_retained(input, backend == 1 && hardware::direct_input_enabled())?;
    if backend == 1 {
        scene.hwrt = Some(hardware::capture_from_prepared(
            &mut assets,
            scene
                .native_layout
                .as_ref()
                .ok_or("Missing native layout")?,
        )?);
    }
    let options = RenderOptions {
        flags: if backend == 1 { 4 } else { 0 },
        seed,
        samples,
        ..Default::default()
    };
    let mut state = GpuScene::new(Path::new(""), scene, &options, Some(&assets), gpu)?;
    let actual = u32::from(state.scene.hwrt.is_some());
    if actual != backend {
        return Err("Unexpected image diagnostic backend".into());
    }
    for start in (0..samples).step_by(8) {
        state.add_samples((samples - start).min(8), options.bounces, seed)?;
    }
    fs::create_dir_all(output)?;
    for (kind, name) in [(0, "hdr"), (1, "normal"), (2, "albedo")] {
        let bytes = state.read_pixels(kind)?;
        if !bytes
            .chunks_exact(4)
            .all(|b| f32::from_le_bytes(b.try_into().unwrap()).is_finite())
        {
            return Err(format!("Non-finite {name} diagnostic").into());
        }
        fs::write(output.join(format!("{name}.bin")), bytes)?;
    }
    fs::write(
        output.join("info.json"),
        serde_json::to_vec_pretty(&json!({
            "width": state.scene.width, "height": state.scene.height, "samples": samples,
            "seed": seed, "actualBackend": actual, "adapter": state.gpu.info.name,
        }))?,
    )?;
    Ok(())
}
