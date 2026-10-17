//! Tile bounded records from the actual one-sample guide path. The ordinary
//! integrator, sampling, material evaluation and selected traversal are retained.
use super::*;
use std::io::{BufWriter, Write};

pub fn run(input: &[u8], output: &Path, backend: u32) -> Result<()> {
    if ![0, 3].contains(&backend) {
        return Err("Path diagnostic backend must be software=0 or authoritative HWRT=3".into());
    }
    let _entry = ENTRY_LOCK.try_lock().map_err(|_| "Native core is active")?;
    context::check_owner()?;
    let (mut scene, mut assets) = if backend == 3 {
        scene::prepare_hardware(input)?
    } else {
        scene::prepare(input)?
    };
    hit_diagnostics::write_geometry_snapshot(&scene, &assets, output)?;
    let mut capture = hardware::from_raw_with_layout(
        &mut assets,
        0,
        true,
        scene
            .native_layout
            .as_ref()
            .ok_or("Missing native layout")?,
    )?;
    if capture.geometries.iter().any(|g| g.procedural) {
        return Err("Path diagnostics exclude displacement geometries".into());
    }
    capture.shader = Some("native-37".into());
    scene.hwrt = Some(capture);
    scene.shader = "native-36".into();
    let tile_rows = 8u32;
    let slots = 129usize; // header + at most 128 guide-open queries
    let pixel_bytes = slots * 64;
    for (id, binding, size, storage) in [
        (
            50,
            7,
            scene.width as usize * tile_rows as usize * pixel_bytes,
            "storage",
        ),
        (51, 8, 16, "read-only-storage"),
    ] {
        let name = format!("diagnostic-{id}");
        assets.insert(name.clone(), vec![0; size]);
        scene.buffers.push(Buffer {
            id,
            size: size as u64,
            usage: 140,
            file: name,
        });
        scene.bind_groups[0]
            .layout
            .push(json!({"binding":binding,"visibility":4,"buffer":{"type":storage}}));
        scene.bind_groups[0].entries.push(Binding {
            binding,
            kind: "buffer".into(),
            id,
        });
    }
    let gpu = GpuDevice::with_backend(backend)?;
    if backend == 3 && !gpu.hardware_ray_query {
        return Err("Path diagnostic requires actual HWRT".into());
    }
    let state = GpuScene::new(
        Path::new(""),
        scene,
        &RenderOptions {
            flags: if backend == 3 { 4 } else { 0 },
            ..Default::default()
        },
        Some(&assets),
        gpu,
    )?;
    fs::create_dir_all(output)?;
    let mut headers = BufWriter::new(fs::File::create(output.join("headers.bin"))?);
    let mut events = BufWriter::new(fs::File::create(output.join("events.bin"))?);
    let mut total_events = 0u64;
    for y in (0..state.scene.height).step_by(tile_rows as usize) {
        let rows = tile_rows.min(state.scene.height - y);
        let parameters: Vec<u8> = [y, rows, backend, 0]
            .into_iter()
            .flat_map(u32::to_le_bytes)
            .collect();
        state
            .gpu
            .queue
            .write_buffer(&state.buffers[&51], 0, &parameters);
        state.dispatch_timed(0, 1, 6., 12345, None)?;
        let data = hit_diagnostics::read_raw(&state.gpu, &state.buffers[&50])?;
        for pixel in 0..state.scene.width as usize * rows as usize {
            let block = &data[pixel * pixel_bytes..(pixel + 1) * pixel_bytes];
            let count = u32::from_le_bytes(block[..4].try_into().unwrap()) as usize;
            let overflow = u32::from_le_bytes(block[4..8].try_into().unwrap());
            if overflow != 0 || count > 128 {
                return Err("Path diagnostic event capacity exceeded".into());
            }
            headers.write_all(&block[..64])?;
            events.write_all(&block[64..64 + count * 64])?;
            total_events += count as u64;
        }
        if y % 64 == 0 {
            eprintln!("Path diagnostic rows {y}/{}", state.scene.height);
        }
    }
    headers.flush()?;
    events.flush()?;
    for (id, name) in [(10, "hdr"), (11, "normal"), (12, "albedo")] {
        fs::write(
            output.join(format!("{name}.bin")),
            hit_diagnostics::read_raw(&state.gpu, &state.buffers[&id])?,
        )?;
    }
    fs::write(
        output.join("info.json"),
        serde_json::to_vec_pretty(&json!({
            "width":state.scene.width,"height":state.scene.height,"samples":1,"sampleIndex":0,"seed":12345,"actualBackend":backend,
            "adapter":state.gpu.info.name,"eventBytes":64,"headerBytes":64,"events":total_events,
            "headerLayout":"u32 count,overflow,backend,sample; vec4f guideNormal; vec4f guideAlbedo; reserved vec4f",
            "eventLayout":"32-byte first-hit record; vec3f rayOrigin + u32 flags (depth | doubleSided<<8 | refraction<<9); vec3f rayDirection + i32 previousRecord",
            "orientation":"bottom row first","guideRecording":"Every intersectScene with input albedoSampled=false; stops independently for each guide branch, includes alpha back and wavelength resets when enabled."
        }))?,
    )?;
    Ok(())
}
