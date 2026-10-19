//! CPU-only preparation driver for profiling the production AOT/native boundary.
use super::*;

pub fn run(input: &[u8], output: &Path, backend: u32, iterations: u32) -> Result<()> {
    if backend > 1 || !(1..=10000).contains(&iterations) {
        return Err("Expected backend 0|1 and iterations 1..10000".into());
    }
    let _entry = ENTRY_LOCK.try_lock().map_err(|_| "Native core is active")?;
    context::check_owner()?;
    let mut results = Vec::new();
    for iteration in 0..iterations {
        let start = Instant::now();
        let (scene, mut assets, retained) = scene::prepare_retained_with_settings(
            input,
            backend == 1,
            backend,
            &settings::RenderSettings::default(),
        )?;
        let prepared = start.elapsed().as_secs_f64() * 1000.;
        let capture_start = Instant::now();
        if backend == 1 {
            std::hint::black_box(hardware::capture_from_resources(
                &mut assets,
                scene
                    .native_layout
                    .as_ref()
                    .ok_or("Missing native layout")?,
            )?);
        }
        let capture = capture_start.elapsed().as_secs_f64() * 1000.;
        let bytes = assets.values().map(Vec::len).sum::<usize>();
        drop(retained);
        results.push(json!({"iteration":iteration,"cpuPrepareMs":prepared,
            "hardwareCaptureMs":capture,"totalIncludingRetirementMs":start.elapsed().as_secs_f64()*1000.,
            "assetBytes":bytes}));
    }
    fs::create_dir_all(output)?;
    fs::write(
        output.join("preparation.json"),
        serde_json::to_vec_pretty(&json!({
            "backend":backend,"iterations":iterations,"gpuWork":false,"results":results
        }))?,
    )?;
    Ok(())
}
