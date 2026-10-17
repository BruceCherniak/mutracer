//! Fixed-sample AOVs with an explicit seed for statistical correctness checks.
use super::*;

pub fn run(input: &[u8], output: &Path, backend: u32, samples: u32, seed: u32) -> Result<()> {
    render(input, output, backend, samples, seed, false)
}

pub fn closest_counts(input: &[u8], output: &Path, samples: u32, seed: u32) -> Result<()> {
    render(input, output, 1, samples, seed, true)
}

// Diagnostic-only instrumentation of the shared TS-generated production WGSL.
// Sharding avoids a single global atomic serializing every ray. No timestamp
// from this instrumented path is a production performance measurement.
const COUNTER_BYTES: usize = 256 * 16 * 4;
fn add_closest_counters(scene: &mut Scene, assets: &mut HashMap<String, Vec<u8>>) -> Result<()> {
    let shader = String::from_utf8(
        assets
            .get("native-33")
            .ok_or("Missing HWRT shader")?
            .clone(),
    )?;
    if shader.matches("fn mtTrace(").count() != 1
        || shader.matches("  var query: ray_query;").count() != 1
    {
        return Err("Production closest shader changed; update diagnostic instrumentation".into());
    }
    let shader = shader.replacen("fn mtTrace(",
        "@group(0) @binding(7) var<storage, read_write> mtQueryCounts: array<atomic<u32>>;\nfn mtTrace(", 1)
        .replacen("  var query: ray_query;", r#"
  let mtBucket = ((samplingPixel.x ^ (samplingPixel.y * 131u)) & 255u) * 16u;
  if (shadow) { atomicAdd(&mtQueryCounts[mtBucket + 8u], 1u); }
  else {
    let category = select(0u, 1u, doubleSided) | select(0u, 2u, skipRecord >= 0) | select(0u, 4u, onlyInstance >= 0);
    atomicAdd(&mtQueryCounts[mtBucket + category], 1u);
  }
  var query: ray_query;"#, 1);
    assets.insert("native-33".into(), shader.into_bytes());
    assets.insert("diagnostic-52".into(), vec![0; COUNTER_BYTES]);
    scene.buffers.push(Buffer {
        id: 52,
        size: COUNTER_BYTES as u64,
        usage: 140,
        file: "diagnostic-52".into(),
    });
    scene.bind_groups[0]
        .layout
        .push(json!({"binding":7,"visibility":4,"buffer":{"type":"storage"}}));
    scene.bind_groups[0].entries.push(Binding {
        binding: 7,
        kind: "buffer".into(),
        id: 52,
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
    if counts {
        add_closest_counters(&mut scene, &mut assets)?;
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
    let mut totals = [0u64; 16];
    for start in (0..samples).step_by(8) {
        state.add_samples((samples - start).min(8), options.bounces, seed)?;
        if counts {
            let data = hit_diagnostics::read_raw(&state.gpu, &state.buffers[&52])?;
            for (i, word) in data.chunks_exact(4).enumerate() {
                totals[i % 16] += u32::from_le_bytes(word.try_into().unwrap()) as u64;
            }
            state
                .gpu
                .queue
                .write_buffer(&state.buffers[&52], 0, &vec![0; COUNTER_BYTES]);
        }
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
