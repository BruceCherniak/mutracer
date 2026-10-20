//! Measures the production adapter on captured, identical RGBA32F AOVs.
use anyhow::{Result, ensure};
use mutracer_native_probe::denoise::Denoiser;
use std::{path::Path, time::Instant};

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 8,
        "Usage: denoise-benchmark OIDN_LIBRARY INPUT_DIR WIDTH HEIGHT BACKEND ITERATIONS OUTPUT_DIR"
    );
    let size = [args[3].parse::<u32>()?, args[4].parse::<u32>()?];
    let iterations: usize = args[6].parse()?;
    ensure!(
        iterations >= 3,
        "At least three measured iterations required"
    );
    let input = Path::new(&args[2]);
    let images: Vec<Vec<f32>> = ["hdr", "normal", "albedo"]
        .iter()
        .map(|name| -> Result<_> {
            let bytes = std::fs::read(input.join(format!("{name}.rgba32f")))?;
            ensure!(
                bytes.len() == size[0] as usize * size[1] as usize * 16,
                "Wrong {name} byte count"
            );
            Ok(bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect())
        })
        .collect::<Result<_>>()?;
    let started = Instant::now();
    let mut denoiser = Denoiser::from_library(Path::new(&args[1]), args[5].parse()?)?;
    denoiser.set_validation_input_scale(1.)?;
    let create_ms = started.elapsed().as_secs_f64() * 1000.;
    let mut warm_ms = vec![];
    let mut first_ms = 0.;
    let mut output = vec![];
    // First execution plus two warmups are excluded from steady-state timing.
    for iteration in 0..iterations + 3 {
        let started = Instant::now();
        output = denoiser.run(size, &images[0], &images[1], &images[2])?;
        let ms = started.elapsed().as_secs_f64() * 1000.;
        if iteration == 0 {
            first_ms = ms;
        }
        if iteration >= 3 {
            warm_ms.push(ms);
        }
    }
    ensure!(output != images[0], "Filter did not change input");
    ensure!(
        output
            .chunks_exact(4)
            .zip(images[0].chunks_exact(4))
            .all(|(a, b)| a[3] == b[3]),
        "Changed alpha"
    );
    let out = Path::new(&args[7]);
    std::fs::create_dir_all(out)?;
    std::fs::write(
        out.join("output.rgba32f"),
        output
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    )?;
    let report = serde_json::json!({"backend":denoiser.backend,"size":size,"createMs":create_ms,"firstMs":first_ms,"warmMs":warm_ms,"inputScale":1,"timing":"production adapter: validation, host copies, synchronous filter, result copies; excludes renderer readback"});
    std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&report)?)?;
    println!("{report}");
    Ok(())
}
