//! Real-device check of incremental geometry commits, used by --geometry-smoke.
use crate::{
    renderer::{self, Camera, Renderer},
    scene::{Environment, KeyLight, Model},
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
        let mut descriptor = None;
        let mut renderer = Renderer::with_backend(mode)?;
        let mut reference = Renderer::with_backend(mode)?;
        renderer.commit(model.update_descriptor(
            &mut descriptor,
            &camera.bytes(size),
            size,
            &environment,
            &KeyLight::default(),
        ))?;
        renderer.finish(8)?;
        for gi in 0..model.geometries.len().min(3) {
            let positions = model.geometries[gi].positions.clone();
            let normals = model.geometries[gi].normals.clone();
            for step in 0..8 {
                let geometry = &mut std::sync::Arc::make_mut(&mut model.geometries)[gi];
                geometry.positions.clone_from(&positions);
                for vertex in std::sync::Arc::make_mut(&mut geometry.positions).chunks_exact_mut(3)
                {
                    vertex[1] += model.radius * 0.015 * step as f32 * (vertex[0] + vertex[2]).sin();
                }
                // Omitted normals request the original TS smooth-normal generator;
                // supplied normals/tangents are passed exactly as caller attributes.
                // Adding or removing normals prepares the mesh fully (steps 0 and 4).
                geometry.normals = if step < 4 {
                    vec![].into()
                } else {
                    normals.clone()
                };
                let before = renderer.pixels()?;
                let mut invalid = model.clone();
                std::sync::Arc::make_mut(
                    &mut std::sync::Arc::make_mut(&mut invalid.geometries)[gi].positions,
                )[0] = f32::NAN;
                ensure!(
                    renderer
                        .commit(invalid.update_descriptor(
                            &mut descriptor,
                            &camera.bytes(size),
                            size,
                            &environment,
                            &KeyLight::default()
                        ))
                        .is_err()
                        && renderer.pixels()? == before,
                    "Invalid geometry mutated scene"
                );
                renderer.commit(model.update_descriptor(
                    &mut descriptor,
                    &camera.bytes(size),
                    size,
                    &environment,
                    &KeyLight::default(),
                ))?;
                if renderer.last_commit_incremental()? {
                    partial += 1;
                } else {
                    fallback += 1;
                }
                ensure!(renderer.samples()? == 0, "Geometry did not reset samples");
                let actual = renderer.finish(8)?;
                reference.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
                ensure!(
                    actual == reference.finish(8)?
                        && renderer.image(1)? == reference.image(1)?
                        && renderer.image(2)? == reference.image(2)?,
                    "Geometry full/partial mismatch {mode}/{gi}/{step}"
                );
                environment.intensity = 0.5 + step as f32 * 0.15;
                renderer.commit(model.update_descriptor(
                    &mut descriptor,
                    &camera.bytes(size),
                    size,
                    &environment,
                    &KeyLight::default(),
                ))?;
                let actual = renderer.finish(8)?;
                reference.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
                ensure!(
                    actual == reference.finish(8)?
                        && renderer.image(1)? == reference.image(1)?
                        && renderer.image(2)? == reference.image(2)?,
                    "Environment after geometry mismatch"
                );
                ensure!(renderer.backend()?.0 == mode, "Unexpected backend fallback");
            }
        }
        renderer::save(
            &out.join(format!("mode-{mode}.png")),
            &renderer.pixels()?,
            size,
            0.,
        )?;
    }
    ensure!(partial > 0, "No incremental geometry commits executed");
    println!(
        "PASS {partial} incremental geometry commits, {fallback} full commits; software/auto HDR/normal/albedo exact; generated/explicit normals and retained environments"
    );
    Ok(())
}
