//! glTF/GLB import with local resources, meshopt, quantized attributes and WebP.
mod animation;
mod decode;
mod model;
use super::*;
pub use animation::{Animation, Clip};
#[doc(hidden)]
pub use model::Model;
use std::{collections::BTreeMap, path::Path};
/// Duplicate names map to all matching objects, in document traversal order.
#[derive(Default)]
pub struct Names {
    pub nodes: BTreeMap<String, Vec<MeshId>>,
    pub meshes: BTreeMap<String, Vec<MeshId>>,
    pub geometries: BTreeMap<String, Vec<GeometryId>>,
    pub materials: BTreeMap<String, Vec<MaterialId>>,
}
pub struct ImportedScene {
    pub scene: Scene,
    pub names: Names,
    pub warnings: Vec<String>,
}
impl Scene {
    /// Imports a local glTF/GLB and its local or embedded resources. The default
    /// scene (otherwise the first scene) and initial paused animation pose are used.
    pub fn import_gltf(path: impl AsRef<Path>) -> anyhow::Result<ImportedScene> {
        import(Model::load(path.as_ref())?)
    }
    /// Imports bytes; base_directory resolves external URIs. Without it, all
    /// resources must be embedded. Same limits and extension support as path import.
    pub fn import_gltf_bytes(
        bytes: &[u8],
        base_directory: Option<&Path>,
    ) -> anyhow::Result<ImportedScene> {
        let base = base_directory.map(|p| p.join("memory.gltf"));
        import(Model::load_bytes(bytes, base.as_deref())?)
    }
}
fn import(model: Model) -> anyhow::Result<ImportedScene> {
    let env = encoder::Environment {
        enabled: false,
        width: 0,
        height: 0,
        pixels: Arc::from([]),
        background: false,
        background_color: [0.; 3],
        background_alpha: 1.,
    };
    let scene = Scene::from_indexed(
        &encoder::SceneData {
            properties: &[],
            geometries: &model.geometries,
            materials: &model.materials,
            textures: &model.textures,
            meshes: &model.meshes,
            lights: vec![],
            ies: vec![],
        },
        &env,
    )?;
    let mut names = Names::default();
    let materials: Vec<_> = scene.materials.iter().map(|(k, _)| MaterialId(k)).collect();
    let geometries: Vec<_> = scene
        .geometries
        .iter()
        .map(|(k, _)| GeometryId(k))
        .collect();
    for (m, id) in model.materials.iter().zip(materials) {
        names.materials.entry(m.name.clone()).or_default().push(id);
    }
    for (i, (m, (k, _))) in model.meshes.iter().zip(scene.meshes.iter()).enumerate() {
        let id = MeshId(k);
        names
            .meshes
            .entry(model.mesh_names[i].clone())
            .or_default()
            .push(id);
        let node = model.node_names[i].clone();
        names.nodes.entry(node).or_default().push(id);
        let list = names.geometries.entry(m.name.clone()).or_default();
        let g = geometries[m.geometry];
        if !list.contains(&g) {
            list.push(g);
        }
    }
    Ok(ImportedScene {
        scene,
        names,
        warnings: model.warnings,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_and_bytes_have_identical_descriptors_and_names() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../viewer/assets/sample.glb");
        let a = Scene::import_gltf(&path).unwrap();
        let b = Scene::import_gltf_bytes(&std::fs::read(&path).unwrap(), None).unwrap();
        assert_eq!(
            *a.scene.descriptor().unwrap(),
            *b.scene.descriptor().unwrap()
        );
        assert_eq!(
            a.names.materials.keys().collect::<Vec<_>>(),
            b.names.materials.keys().collect::<Vec<_>>()
        );
        assert!(!a.names.meshes.is_empty());
    }
}
