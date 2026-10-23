//! glTF/GLB import with local resources, meshopt, quantized attributes and WebP.
mod animation;
mod decode;
mod model;
use super::*;
pub use animation::{Animation, Clip};
use anyhow::Context;
#[doc(hidden)]
pub use model::Model;
use std::{collections::BTreeMap, path::Path};

// One classification boundary for Rust import and the C wrappers.
fn import_error(error: anyhow::Error) -> api::Error {
    api::error(Status::InvalidArgument, format!("{error:#}"))
}
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
    /// Import failures return InvalidArgument with the complete cause chain.
    pub fn import_gltf(path: impl AsRef<Path>) -> api::Result<ImportedScene> {
        Model::load(path.as_ref())
            .and_then(import)
            .context("Importing glTF scene")
            .map_err(import_error)
    }
    /// Imports bytes; base_directory resolves external URIs. Without it, all
    /// resources must be embedded. Same limits, errors and extension support as path import.
    pub fn import_gltf_bytes(
        bytes: &[u8],
        base_directory: Option<&Path>,
    ) -> api::Result<ImportedScene> {
        let base = base_directory.map(|p| p.join("memory.gltf"));
        Model::load_bytes(bytes, base.as_deref())
            .and_then(import)
            .context("Importing glTF scene")
            .map_err(import_error)
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

#[cfg(test)]
mod error_tests {
    use super::*;
    use crate::scene_api::abi::{mt_scene_import_gltf, mt_scene_import_gltf_bytes};
    use std::ffi::{CStr, CString};

    #[test]
    fn rust_and_c_import_errors_preserve_status_and_causes() {
        let root =
            std::env::temp_dir().join(format!("mutracer-import-errors-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let missing = root.join("missing.glb");
        let rust = Scene::import_gltf(&missing).err().unwrap();
        assert_eq!(rust.status, Status::InvalidArgument);
        assert!(rust.message.contains("Importing glTF scene: "));
        assert!(rust.message.contains("os error"), "{}", rust.message);
        let path = CString::new(missing.to_str().unwrap()).unwrap();
        let mut error = [0i8; 4096];
        let mut scene = 0;
        assert_eq!(
            unsafe {
                mt_scene_import_gltf(path.as_ptr(), &mut scene, error.as_mut_ptr(), error.len())
            },
            Status::InvalidArgument as i32
        );
        assert_eq!(
            unsafe { CStr::from_ptr(error.as_ptr()) }.to_str().unwrap(),
            rust.message
        );
        for (name, bytes, cause) in [
            ("broken.glb", b"glTF\x02\0\0\0".as_slice(), "Loading GLTF/GLB and its buffers/images: "),
            ("required.gltf", br#"{"asset":{"version":"2.0"},"extensionsRequired":["KHR_draco_mesh_compression"]}"#.as_slice(), "Required glTF extension is unsupported"),
            ("limit.gltf", br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":536870913}]}"#.as_slice(), "Model buffers exceed 512 MiB"),
        ] {
            let file = root.join(name);
            std::fs::write(&file, bytes).unwrap();
            let from_bytes = Scene::import_gltf_bytes(bytes, None).err().unwrap();
            let from_path = Scene::import_gltf(&file).err().unwrap();
            let cause_chain = Model::load_bytes(bytes, None).err().unwrap();
            assert_eq!(from_bytes.message, format!("Importing glTF scene: {cause_chain:#}"));
            assert_eq!(from_bytes.status, Status::InvalidArgument);
            assert_eq!(from_path.status, Status::InvalidArgument);
            assert!(from_bytes.message.contains(cause), "{}", from_bytes.message);
            assert!(from_bytes.message.starts_with("Importing glTF scene: Loading GLTF/GLB and its buffers/images: "), "{}", from_bytes.message);
            assert_eq!(unsafe { mt_scene_import_gltf_bytes(bytes.as_ptr().cast(), bytes.len(), std::ptr::null(), &mut scene, error.as_mut_ptr(), error.len()) }, Status::InvalidArgument as i32);
            assert_eq!(unsafe { CStr::from_ptr(error.as_ptr()) }.to_str().unwrap(), from_bytes.message);
            let path = CString::new(file.to_str().unwrap()).unwrap();
            assert_eq!(unsafe { mt_scene_import_gltf(path.as_ptr(), &mut scene, error.as_mut_ptr(), error.len()) }, Status::InvalidArgument as i32);
            assert_eq!(unsafe { CStr::from_ptr(error.as_ptr()) }.to_str().unwrap(), from_path.message);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
