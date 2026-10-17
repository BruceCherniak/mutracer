//! Explicit first-hit execution; no diagnostic buffers or atomics in render PSOs.
use super::*;

pub(super) fn read_raw(gpu: &GpuDevice, source: &wgpu::Buffer) -> Result<Vec<u8>> {
    let output = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("First-hit diagnostic readback"),
        size: source.size(),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(source, 0, &output, 0, source.size());
    gpu.queue.submit([encoder.finish()]);
    let (tx, rx) = mpsc::channel();
    output.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    gpu.device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(60)),
    })?;
    rx.recv_timeout(Duration::from_secs(5))??;
    let bytes = output.slice(..).get_mapped_range()?.to_vec();
    output.unmap();
    Ok(bytes)
}

// Geometry is an explicit diagnostic payload, independent of shader text.
// NumPy evaluates barycentric world points in float64, with no GPU rounding.
pub(super) fn write_geometry_snapshot(
    scene: &Scene,
    assets: &HashMap<String, Vec<u8>>,
    output: &Path,
) -> Result<()> {
    fs::create_dir_all(output)?;
    fs::write(
        output.join("layout.json"),
        serde_json::to_vec_pretty(
            scene
                .native_layout
                .as_ref()
                .ok_or("Missing diagnostic layout")?,
        )?,
    )?;
    for id in [1, 2, 3, 35, 40] {
        let key = format!("native-{id}");
        fs::write(
            output.join(format!("{key}.bin")),
            assets.get(&key).ok_or("Missing diagnostic geometry")?,
        )?;
    }
    Ok(())
}

pub fn run(input: &[u8], output: &Path) -> Result<()> {
    run_side(input, &output.join("software"), false)?;
    run_side(input, &output.join("hardware"), true)?;
    for (side, file) in [
        ("software", "software.hit.bin"),
        ("hardware", "hardware.hit.bin"),
    ] {
        fs::copy(output.join(side).join(file), output.join(file))?;
    }
    fs::copy(output.join("hardware/info.json"), output.join("info.json"))?;
    fs::copy(output.join("hardware/rays.bin"), output.join("rays.bin"))?;
    Ok(())
}
fn run_side(input: &[u8], output: &Path, hardware: bool) -> Result<()> {
    let _entry = ENTRY_LOCK.try_lock().map_err(|_| "Native core is active")?;
    context::check_owner()?;
    let (mut scene, mut assets) = if hardware {
        scene::prepare_hardware(input)?
    } else {
        scene::prepare(input)?
    };
    write_geometry_snapshot(&scene, &assets, output)?;
    let layout = scene
        .native_layout
        .as_ref()
        .ok_or("Missing native layout")?;
    let mut capture = hardware::from_raw_with_layout(&mut assets, 0, true, layout)?;
    if std::env::var_os("MUTRACER_NATIVE_HIT_INPUTS").is_some_and(|v| v == "1") {
        fs::create_dir_all(output)?;
        fs::write(
            output.join("layout.json"),
            serde_json::to_vec_pretty(layout)?,
        )?;
        fs::write(
            output.join("capture.json"),
            serde_json::to_vec_pretty(&capture)?,
        )?;
        for (name, bytes) in &assets {
            if [
                "native-1",
                "native-2",
                "native-3",
                "native-4",
                "native-hwrt-map",
            ]
            .contains(&name.as_str())
                || name.starts_with("native-hwrt-positions-")
            {
                fs::write(output.join(format!("{name}.bin")), bytes)?;
            }
        }
    }
    if let Ok(instance) = std::env::var("MUTRACER_NATIVE_HIT_INSTANCE") {
        let primitive = std::env::var("MUTRACER_NATIVE_HIT_PRIMITIVE")
            .ok()
            .map(|v| v.parse())
            .transpose()?;
        hardware::isolate_diagnostic(
            &mut capture,
            &mut assets,
            instance.parse()?,
            if hardware { primitive } else { None },
        )?;
    }
    if capture.geometries.iter().any(|g| g.procedural) {
        return Err("First-hit diagnostics exclude displacement geometries".into());
    }
    capture.shader = Some("native-34".into());
    scene.hwrt = Some(capture);
    scene.entry_point = "diagnoseHits".into();
    scene.shader = "native-39".into();
    let gpu = GpuDevice::with_backend(3)?;
    if !gpu.hardware_ray_query {
        return Err("Diagnostic requires actual HWRT".into());
    }
    let state = GpuScene::new(
        Path::new(""),
        scene,
        &RenderOptions {
            flags: if hardware { 4 } else { 0 },
            ..Default::default()
        },
        Some(&assets),
        gpu,
    )?;
    state.dispatch_timed(0, 1, 6., 12345, None)?;
    let sw = read_raw(&state.gpu, &state.buffers[&10])?;
    let sw_bary = read_raw(&state.gpu, &state.buffers[&11])?;
    let hw = read_raw(&state.gpu, &state.buffers[&12])?;
    let auxiliary = read_raw(&state.gpu, &state.buffers[&13])?;
    let pixels = state.scene.width as usize * state.scene.height as usize;
    let mut software = Vec::with_capacity(pixels * 32);
    let mut hardware = Vec::with_capacity(pixels * 32);
    let mut rays = Vec::with_capacity(pixels * 32);
    for i in 0..pixels {
        software.extend_from_slice(&sw[i * 16..i * 16 + 16]);
        software.extend_from_slice(&sw_bary[i * 16..i * 16 + 16]);
        hardware.extend_from_slice(&hw[i * 16..i * 16 + 16]);
        hardware.extend_from_slice(&auxiliary[i * 48..i * 48 + 16]);
        rays.extend_from_slice(&auxiliary[i * 48 + 16..i * 48 + 48]);
    }
    fs::create_dir_all(output)?;
    fs::write(output.join("software.hit.bin"), software)?;
    fs::write(output.join("hardware.hit.bin"), hardware)?;
    fs::write(output.join("rays.bin"), rays)?;
    fs::write(
        output.join("info.json"),
        serde_json::to_vec_pretty(&json!({
            "width":state.scene.width,"height":state.scene.height,"samples":1,"sampleIndex":0,"seed":12345,
            "actualBackend":3,"adapter":state.gpu.info.name,"recordBytes":32,
            "recordLayout":"u32 hit, i32 instance, i32 record, f32 t, f32 barycentric[3], f32 reserved",
            "orientation":"bottom row first","raysSecondVector":"direction.z, local normal dot direction, wanted confirmed, candidate count; direction.x in hit reserved; direction.y in origin.w","primaryAlpha":"first geometric hit, prior to integrator coverage"
        }))?,
    )?;
    Ok(())
}
