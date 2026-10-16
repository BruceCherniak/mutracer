//! Real-device check of the stable-topology geometry API, used by --geometry-smoke.
use crate::{
    renderer::{self, Camera, Renderer},
    scene::{Environment, Model},
};
use anyhow::{Result, ensure};
use std::path::Path;

pub fn run(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut partial = 0;
    let mut fallback = 0;
    for mode in [0, 1] {
        let mut model = Model::load(path)?;
        let camera = Camera::fit(model.center, model.radius);
        let mut environment = Environment::default();
        let size = [160, 104];
        let mut renderer = Renderer::with_backend(mode)?;
        let mut reference = Renderer::with_backend(mode)?;
        renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
        renderer.finish(8)?;
        for gi in 0..model.geometries.len().min(3) {
            let positions = model.geometries[gi].positions.clone();
            let normals = model.geometries[gi].normals.clone();
            for step in 0..8 {
                let geometry = &mut model.geometries[gi];
                geometry.positions.clone_from(&positions);
                for vertex in geometry.positions.chunks_exact_mut(3) {
                    vertex[1] += model.radius * 0.015 * step as f32 * (vertex[0] + vertex[2]).sin();
                }
                // Omitted normals request the original TS smooth-normal generator;
                // supplied normals/tangents are passed exactly as caller attributes.
                geometry.normals = if step % 2 == 0 {
                    vec![]
                } else {
                    normals.clone()
                };
                let bytes = geometry.update_bytes(gi);
                let before = renderer.pixels()?;
                let mut invalid = bytes.clone();
                invalid[16..20].copy_from_slice(&f32::NAN.to_le_bytes());
                ensure!(
                    renderer.geometry(&invalid).is_err() && renderer.pixels()? == before,
                    "Invalid geometry mutated scene"
                );
                if renderer.geometry(&bytes)? {
                    partial += 1;
                } else {
                    ensure!(
                        renderer.pixels()? == before,
                        "Rejected geometry changed scene"
                    );
                    renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
                    fallback += 1;
                }
                ensure!(renderer.samples()? == 0, "Geometry did not reset samples");
                let actual = renderer.finish(8)?;
                reference.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
                ensure!(
                    actual == reference.finish(8)?
                        && renderer.image(1)? == reference.image(1)?
                        && renderer.image(2)? == reference.image(2)?,
                    "Geometry full/partial mismatch {mode}/{gi}/{step}"
                );
                environment.intensity = 0.5 + step as f32 * 0.15;
                if !renderer.environment(&environment.update_bytes())? {
                    renderer.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
                }
                let actual = renderer.finish(8)?;
                reference.commit(&model.descriptor(&camera.bytes(), size, &environment))?;
                ensure!(
                    actual == reference.finish(8)?
                        && renderer.image(1)? == reference.image(1)?
                        && renderer.image(2)? == reference.image(2)?,
                    "Environment after geometry mismatch"
                );
                if renderer.backend()?.0 != 0 {
                    let counts = renderer.counts()?;
                    ensure!(
                        counts[4] > 0 && counts[9] == 0,
                        "HWRT shadow validation did not run or mismatched"
                    );
                }
            }
        }
        renderer::save(
            &out.join(format!("mode-{mode}.png")),
            &renderer.pixels()?,
            size,
            0.,
        )?;
    }
    ensure!(partial > 0, "No partial geometry updates executed");
    println!(
        "PASS {partial} partial geometry edits, {fallback} full fallbacks; software/auto HDR/normal/albedo exact; generated/explicit normals and retained environments"
    );
    Ok(())
}
