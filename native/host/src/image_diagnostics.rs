//! Fixed-sample AOVs with an explicit seed for statistical correctness checks.
use super::*;

pub fn run(input: &[u8], output: &Path, backend: u32, samples: u32, seed: u32) -> Result<()> {
    render(input, output, backend, samples, seed, false, false)
}

pub fn audited(input: &[u8], output: &Path, backend: u32, samples: u32, seed: u32) -> Result<()> {
    render(input, output, backend, samples, seed, false, true)
}

pub fn closest_counts(input: &[u8], output: &Path, samples: u32, seed: u32) -> Result<()> {
    render(input, output, 1, samples, seed, true, false)
}

// Diagnostic-only instrumentation of the shared TS-generated production WGSL.
// Sharding avoids a single global atomic serializing every ray. No timestamp
// from this instrumented path is a production performance measurement.
const COUNTER_BYTES: usize = 256 * 16 * 4;
fn add_closest_counters(scene: &mut Scene, assets: &mut Assets) -> Result<()> {
    let shader = String::from_utf8(
        assets
            .get(&AssetId::Packet(33))
            .ok_or("Missing HWRT shader")?
            .clone(),
    )?;
    if shader.matches("fn mtTrace(").count() != 1
        || shader.matches("  var query: ray_query;").count() != 1
    {
        return Err("Production closest shader changed; update diagnostic instrumentation".into());
    }
    let declaration = format!(
        "@group({}) @binding({}) var<storage, read_write> mtQueryCounts: array<atomic<u32>>;\nfn mtTrace(",
        layout::group::SCENE,
        layout::hwrt_binding::DIAGNOSTIC
    );
    let shader = shader.replacen("fn mtTrace(", &declaration, 1)
        .replacen("  var query: ray_query;", r#"
  let mtBucket = ((samplingPixel.x ^ (samplingPixel.y * 131u)) & 255u) * 16u;
  if (shadow) { atomicAdd(&mtQueryCounts[mtBucket + 8u], 1u); }
  else {
    let category = select(0u, 1u, doubleSided) | select(0u, 2u, skipRecord >= 0) | select(0u, 4u, onlyInstance >= 0);
    atomicAdd(&mtQueryCounts[mtBucket + category], 1u);
  }
  var query: ray_query;"#, 1);
    assets.insert(AssetId::Packet(33), shader.into_bytes());
    assets.insert(AssetId::Diagnostic(52), vec![0; COUNTER_BYTES]);
    scene.buffers.push(Buffer {
        id: layout::resource::QUERY_COUNTS,
        size: COUNTER_BYTES as u64,
        usage: 140,
        resource: AssetId::Diagnostic(52),
    });
    scene.bind_groups[layout::group::SCENE]
        .layout
        .push(storage_layout(
            layout::hwrt_binding::DIAGNOSTIC as u32,
            false,
        ));
    scene.bind_groups[layout::group::SCENE]
        .entries
        .push(Binding {
            binding: layout::hwrt_binding::DIAGNOSTIC as u32,
            kind: BindingKind::Buffer,
            id: layout::resource::QUERY_COUNTS,
        });
    Ok(())
}

fn render(
    input: &[u8],
    output: &Path,
    backend: u32,
    samples: u32,
    seed: u32,
    counts: bool,
    audit: bool,
) -> Result<()> {
    if backend > 1 || samples == 0 || samples > 4096 {
        return Err("Expected backend 0|1 and samples 1..4096".into());
    }
    let _entry = ENTRY_LOCK.try_lock().map_err(|_| "Native core is active")?;
    context::check_owner()?;
    let gpu = GpuDevice::with_backend(backend)?;
    if backend == 1 && !gpu.hardware_ray_query {
        return Err("Image diagnostic requires actual HWRT".into());
    }
    let (mut scene, mut assets, _retained) = scene::prepare_retained_with_settings(
        input,
        backend == 1 && hardware::direct_input_enabled(),
        backend,
        &settings::RenderSettings::default(),
    )?;
    if backend == 1 {
        scene.hwrt = Some(hardware::capture_from_resources(
            &mut assets,
            scene
                .native_layout
                .as_ref()
                .ok_or("Missing native layout")?,
        )?);
    }
    if counts {
        add_closest_counters(&mut scene, &mut assets)?;
    }
    #[cfg(feature = "validation")]
    let ordinary_source = if audit {
        let id = scene
            .hwrt
            .as_ref()
            .and_then(|h| h.shader)
            .unwrap_or(scene.shader);
        Some(String::from_utf8(assets[&id].clone())?)
    } else {
        None
    };
    if audit {
        #[cfg(not(feature = "validation"))]
        return Err("Build with --features validation for sample auditing".into());
        #[cfg(feature = "validation")]
        sample_audit::install(&mut scene, &mut assets)?;
    }
    let options = RenderOptions {
        flags: if backend == 1 { 4 } else { 0 },
        seed,
        samples,
        ..Default::default()
    };
    let mut state = GpuScene::new(scene, &options, &assets, gpu)?;
    let actual = u32::from(state.scene.hwrt.is_some());
    if actual != backend {
        return Err("Unexpected image diagnostic backend".into());
    }
    let mut totals = [0u64; 16];
    #[cfg(feature = "validation")]
    let mut audit_samples = Vec::new();
    for start in (0..samples).step_by(if audit { 1 } else { 8 }) {
        state.add_samples(
            (samples - start).min(if audit { 1 } else { 8 }),
            options.bounces,
            seed,
        )?;
        #[cfg(feature = "validation")]
        if audit {
            let check = sample_audit::read(&state, start)?;
            let failed = check.short_pixels > 0 || check.invalid_pixels > 0;
            audit_samples.push(check);
            if failed {
                break;
            }
        }
        if counts {
            let data = hit_diagnostics::read_raw(
                &state.gpu,
                &state.buffers[&layout::resource::QUERY_COUNTS],
            )?;
            for (i, word) in data.chunks_exact(4).enumerate() {
                totals[i % 16] += u32::from_le_bytes(word.try_into().unwrap()) as u64;
            }
            state.gpu.queue.write_buffer(
                &state.buffers[&layout::resource::QUERY_COUNTS],
                0,
                &vec![0; COUNTER_BYTES],
            );
        }
    }
    fs::create_dir_all(output)?;
    #[cfg(feature = "validation")]
    if audit {
        fs::write(
            output.join("sample-audit.json"),
            serde_json::to_vec_pretty(&audit_samples)?,
        )?;
        if audit_samples
            .iter()
            .any(|s| s.short_pixels > 0 || s.invalid_pixels > 0)
        {
            for id in [
                state.scene.color_output,
                state.scene.normal_output.unwrap(),
                state.scene.albedo_output.unwrap(),
                layout::resource::QUERY_COUNTS,
            ] {
                fs::write(
                    output.join(format!("first-failure-buffer{id}.bin")),
                    hit_diagnostics::read_raw(&state.gpu, &state.buffers[&id])?,
                )?;
            }
        }
    }
    for (kind, name) in [(0, "hdr"), (1, "normal"), (2, "albedo")] {
        let bytes = match state.read_pixels(kind) {
            Ok(bytes) => bytes,
            Err(error) => {
                // Public readback rejects non-finite values. Preserve the raw
                // accumulators for diagnosis without making that check lenient.
                if std::env::var_os("MUTRACER_TEST_CAPTURE").is_some() {
                    fs::write(output.join("readback-failure-input.bin"), input)?;
                    for (name, id) in [
                        ("hdr", Some(state.scene.color_output)),
                        ("normal", state.scene.normal_output),
                        ("albedo", state.scene.albedo_output),
                    ] {
                        let Some(id) = id else { continue };
                        fs::write(
                            output.join(format!("readback-failure-{name}.bin")),
                            hit_diagnostics::read_raw(&state.gpu, &state.buffers[&id])?,
                        )?;
                    }
                    fs::write(
                        output.join("readback-failure.json"),
                        serde_json::to_vec_pretty(&serde_json::json!({
                            "kind": name, "error": error.to_string(),
                            "samples": samples, "seed": seed,
                            "width": state.scene.width, "height": state.scene.height,
                            "backend": actual, "adapter": state.gpu.info.name,
                            "api": format!("{:?}", state.gpu.info.backend),
                            "layout": "raw accumulation, bottom row first"
                        }))?,
                    )?;
                }
                return Err(error);
            }
        };
        if !bytes
            .chunks_exact(4)
            .all(|b| f32::from_le_bytes(b.try_into().unwrap()).is_finite())
        {
            return Err(format!("Non-finite {name} diagnostic").into());
        }
        fs::write(output.join(format!("{name}.bin")), bytes)?;
    }
    #[cfg(feature = "validation")]
    if let Some(source) = ordinary_source {
        // The full-size control catches shader/compiler changes that a small
        // fixture cannot. Its AS and immutable resources are identical.
        sample_audit::ordinary_pipeline(&mut state, source);
        state.reset_raw()?;
        let mut ordinary_audit = Vec::new();
        for sample in 0..samples {
            state.add_samples(1, options.bounces, seed)?;
            let check = sample_audit::accumulation_count(&state, sample)?;
            let failed = check["shortPixels"].as_u64().unwrap() > 0
                || check["invalidPixels"].as_u64().unwrap() > 0;
            ordinary_audit.push(check);
            if failed {
                for id in [
                    state.scene.color_output,
                    state.scene.normal_output.unwrap(),
                    state.scene.albedo_output.unwrap(),
                ] {
                    fs::write(
                        output.join(format!("ordinary-first-failure-buffer{id}.bin")),
                        hit_diagnostics::read_raw(&state.gpu, &state.buffers[&id])?,
                    )?;
                }
                break;
            }
        }
        fs::write(
            output.join("ordinary-sample-audit.json"),
            serde_json::to_vec_pretty(&ordinary_audit)?,
        )?;
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
    if counts {
        fs::write(
            output.join("closest-counts.json"),
            serde_json::to_vec_pretty(&json!({
                "samples": samples, "seed": seed, "actualBackend": actual,
                "counts": totals, "closestBins": "bits: 0=doubleSided, 1=skipRecord>=0, 2=onlyInstance>=0; slot8=shadow",
                "closestQueries": totals[..8].iter().sum::<u64>(),
                "unrestrictedQueries": totals[0] + totals[1],
                "nativeLayout": state.scene.native_layout,
            }))?,
        )?;
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
