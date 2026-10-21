//! `--edit-bench DIRECTORY`: commit latency of interactive edits on one model.
use crate::renderer::{Camera, Renderer};
use crate::scene::{Environment, KeyLight, Model};
use anyhow::Result;
use std::{path::Path, time::Instant};

const ITERATIONS: usize = 12;
const SIZE: [u32; 2] = [1280, 720];

struct Scene {
    model: Model,
    camera: Camera,
    environment: Environment,
    light: KeyLight,
}
impl Scene {
    fn descriptor(&self) -> Vec<u8> {
        self.model
            .descriptor_with_light(&self.camera.bytes(), SIZE, &self.environment, &self.light)
    }
    /// Applies edit `kind` for iteration `i`; alternating values keep every commit a change.
    fn edit(&mut self, kind: &str, i: usize) {
        let flip = if i % 2 == 0 { 1.0 } else { -1.0 };
        match kind {
            "material" => self.model.materials[0].roughness = if i % 2 == 0 { 0.3 } else { 0.6 },
            "transform" => {
                let mesh = &mut self.model.meshes[0];
                mesh.transform.w_axis.x += 0.001 * flip;
            }
            "camera" => self.camera.orbit([0.002 * flip, 0.0]),
            "light" => self.light.intensity = if i % 2 == 0 { 2.0 } else { 3.0 },
            "environment" => self.environment.intensity = if i % 2 == 0 { 0.8 } else { 1.2 },
            _ => unreachable!(),
        }
    }
}

pub fn run(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    mutracer_native_probe::logging::stderr();
    let model = Model::load(path)?;
    let camera = Camera::fit(model.center, model.radius);
    let mut scene = Scene {
        model,
        camera,
        environment: Environment::default(),
        light: KeyLight {
            enabled: true,
            ..KeyLight::default()
        },
    };
    let mut rows = Vec::new();
    for mode in [0, 1] {
        let mut renderer = Renderer::with_backend(mode)?;
        let started = Instant::now();
        let bytes = scene.descriptor();
        let build = started.elapsed().as_secs_f64() * 1e3;
        renderer.commit(&bytes)?;
        let initial = started.elapsed().as_secs_f64() * 1e3 - build;
        rows.push(
            serde_json::json!({"mode": mode, "kind": "initial", "descriptorBytes": bytes.len(),
            "buildMs": build, "commitMs": initial}),
        );
        for kind in ["material", "transform", "camera", "light", "environment"] {
            for i in 0..ITERATIONS {
                scene.edit(kind, i);
                let started = Instant::now();
                let bytes = scene.descriptor();
                let build = started.elapsed().as_secs_f64() * 1e3;
                renderer.commit(&bytes)?;
                let commit = started.elapsed().as_secs_f64() * 1e3 - build;
                rows.push(
                    serde_json::json!({"mode": mode, "kind": kind, "iteration": i, "buildMs": build,
                    "commitMs": commit, "incremental": renderer.last_commit_incremental()?}),
                );
            }
        }
    }
    let text = rows
        .iter()
        .map(|row| row.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(out.join("edit-bench.jsonl"), text + "\n")?;
    println!("{}", out.join("edit-bench.jsonl").display());
    Ok(())
}
