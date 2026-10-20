//! Tile bounded records from the actual one-sample guide path. The ordinary
//! integrator, sampling, material evaluation and selected traversal are retained.
use super::*;
use std::io::{BufWriter, Write};

pub fn run(input: &[u8], output: &Path, backend: u32) -> Result<()> {
    if ![0, 1].contains(&backend) {
        return Err("Path diagnostic backend must be software=0 or authoritative HWRT=1".into());
    }
    let _entry = ENTRY_LOCK.try_lock().map_err(|_| "Native core is active")?;
    context::check_owner()?;
    let (mut scene, mut assets) = if backend == 1 {
        scene::prepare_hardware(input)?
    } else {
        scene::prepare_diagnostic(input, false)?
    };
    hit_diagnostics::write_geometry_snapshot(&scene, &assets, output)?;
    let mut capture = hardware::capture_from_resources(
        &mut assets,
        scene
            .native_layout
            .as_ref()
            .ok_or("Missing native layout")?,
    )?;
    if capture.geometries.iter().any(|g| g.procedural) {
        return Err("Path diagnostics exclude displacement geometries".into());
    }
    #[cfg(feature = "validation")]
    let ordinary_source = String::from_utf8(
        assets[&if backend == 1 {
            capture.shader.ok_or("Missing ordinary HWRT shader")?
        } else {
            scene.shader
        }]
            .clone(),
    )?;
    capture.shader = Some(AssetId::Packet(37));
    scene.hwrt = Some(capture);
    scene.shader = AssetId::Packet(36);
    let tile_rows = 8u32;
    let slots = 129usize; // header + at most 128 guide-open queries
    let pixel_bytes = slots * 64;
    for (id, binding, size, storage) in [
        (
            layout::resource::PATH_EVENTS,
            layout::hwrt_binding::DIAGNOSTIC as u32,
            scene.width as usize * tile_rows as usize * pixel_bytes,
            "storage",
        ),
        (
            layout::resource::PATH_PARAMETERS,
            layout::hwrt_binding::PATH_PARAMETERS as u32,
            16,
            "read-only-storage",
        ),
    ] {
        let name = AssetId::Diagnostic(id);
        assets.insert(name.clone(), vec![0; size]);
        scene.buffers.push(Buffer {
            id,
            size: size as u64,
            usage: 140,
            resource: name,
        });
        scene.bind_groups[layout::group::SCENE]
            .layout
            .push(storage_layout(binding, storage == "read-only-storage"));
        scene.bind_groups[layout::group::SCENE]
            .entries
            .push(Binding {
                binding,
                kind: BindingKind::Buffer,
                id,
            });
    }
    let gpu = GpuDevice::with_backend(backend)?;
    if backend == 1 && !gpu.hardware_ray_query {
        return Err("Path diagnostic requires actual HWRT".into());
    }
    #[allow(unused_mut)]
    let mut state = GpuScene::new(
        scene,
        &RenderOptions {
            flags: if backend == 1 { 4 } else { 0 },
            ..Default::default()
        },
        &assets,
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
        state.gpu.queue.write_buffer(
            &state.buffers[&layout::resource::PATH_PARAMETERS],
            0,
            &parameters,
        );
        state.dispatch_timed(0, 1, 6., 12345, None)?;
        let data =
            hit_diagnostics::read_raw(&state.gpu, &state.buffers[&layout::resource::PATH_EVENTS])?;
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
            native_log!("Path diagnostic rows {y}/{}", state.scene.height);
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
    #[cfg(feature = "validation")]
    {
        // Compare on the same AS. Rebuilding between the instrumented and
        // ordinary pass can legitimately choose another coplanar triangle.
        sample_audit::ordinary_pipeline(&mut state, ordinary_source);
        state.reset_raw()?;
        state.add_samples(1, 6., 12345)?;
        let mut fidelity = serde_json::Map::new();
        for (kind, name) in [(0, "hdr"), (1, "normal"), (2, "albedo")] {
            let bytes = state.read_pixels(kind)?;
            fidelity.insert(
                name.into(),
                json!(bytes == fs::read(output.join(format!("{name}.bin")))?),
            );
            fs::write(output.join(format!("ordinary-{name}.bin")), bytes)?;
        }
        fs::write(
            output.join("same-as-fidelity.json"),
            serde_json::to_vec_pretty(&fidelity)?,
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
