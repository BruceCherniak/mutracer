//! Relocated-package CPU gate; rendering is an explicit real-GPU validation mode.
use crate::{
    renderer::{Camera, Renderer},
    scene::{Environment, Model},
};
use anyhow::{Result, ensure};
use std::path::Path;

pub fn run(model_path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let model = Model::load(model_path)?;
    let size = [32, 24];
    let count = (size[0] * size[1]) as usize;
    let mut hdr = Vec::with_capacity(count * 4);
    for i in 0..count {
        let value = if i % 3 == 0 { 2.0 } else { 0.1 };
        hdr.extend_from_slice(&[value, value * 0.5, value * 0.25, (i % 7) as f32 / 7.0]);
    }
    let normal: Vec<f32> = [0.0, 0.0, 1.0, 1.0].repeat(count);
    let albedo: Vec<f32> = [0.5, 0.5, 0.5, 1.0].repeat(count);
    let mut denoiser = mutracer_native_probe::denoise::Denoiser::with_backend(1)?;
    let denoised = denoiser.run(size, &hdr, &normal, &albedo)?;
    ensure!(
        denoised.iter().all(|v| v.is_finite()),
        "Non-finite bundled OIDN output"
    );
    ensure!(denoised != hdr, "Bundled OIDN did not filter the input");
    ensure!(
        denoised
            .chunks_exact(4)
            .zip(hdr.chunks_exact(4))
            .all(|(a, b)| a[3] == b[3]),
        "OIDN changed alpha"
    );

    let gpu = std::env::var("MUTRACER_NATIVE_GPU_VALIDATION").is_ok_and(|value| value == "1");
    if gpu {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))?;
        ensure!(
            matches!(
                adapter.get_info().device_type,
                wgpu::DeviceType::IntegratedGpu
                    | wgpu::DeviceType::DiscreteGpu
                    | wgpu::DeviceType::VirtualGpu
            ),
            "Packaged GPU validation requires a real GPU"
        );
        let mut renderer = Renderer::with_backend(0)?;
        let camera = Camera::fit(model.center, model.radius);
        renderer.commit(&model.descriptor(&camera.bytes(size), size, &Environment::default()))?;
        let pixels = renderer.finish(4)?;
        ensure!(
            pixels.iter().all(|v| v.is_finite()),
            "Non-finite packaged render"
        );
        ensure!(
            pixels
                .chunks_exact(4)
                .any(|p| p[..3].iter().any(|v| *v > 0.0)),
            "Empty packaged render"
        );
        for kind in 0..3 {
            ensure!(
                renderer.image(kind)?.iter().all(|v| v.is_finite()),
                "Non-finite packaged AOV"
            );
        }
        ensure!(
            renderer.backend()?.0 == 0,
            "Package smoke must exercise software BVH"
        );
        renderer.reset()?;
        ensure!(
            renderer.finish(4)? == pixels,
            "Packaged accumulation reset differs"
        );
        crate::renderer::save(&out.join("render.png"), &pixels, size, 0.0)?;
    }
    let summary = serde_json::json!({"passed":true,"gpu":gpu,"gpuValidation":if gpu {"passed"} else {"not-run (CPU-only)"},"oidn":denoiser.backend,"model":model_path});
    std::fs::write(
        out.join("summary.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    println!("{summary}");
    Ok(())
}
