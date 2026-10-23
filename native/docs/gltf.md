# Import glTF scenes

Use `Scene::import_gltf(path)` or `Scene::import_gltf_bytes(bytes, base_directory)`
with the `gltf` Cargo feature (enabled by default). Both return `ImportedScene`:
`scene`, `names` and `warnings`. Names contain node, mesh, geometry and material
handles; duplicate names have multiple handles in traversal order. Names are
case-sensitive. The imported scene uses the default scene, or the first scene
when no default is marked, and the first animation clip's initial pose.

```rust
let imported = mutracer_native_probe::scene_api::Scene::import_gltf("model.glb")?;
engine.set_scene_object(&imported.scene)?;
engine.update()?;
```

C's `mt_scene_import_gltf` and `mt_scene_import_gltf_bytes` create a scene handle.
`mt_scene_find` resolves a name and zero-based occurrence to a handle. A build
without `gltf` returns `MT_ERROR_UNAVAILABLE` from these import calls.

Import failures, including missing files, invalid glTF/GLB, unsupported required
extensions and exceeded limits, return Rust `api::Status::InvalidArgument` or C
`MT_ERROR_INVALID_ARGUMENT`. Messages include the complete cause chain; C error
buffers must be large enough to receive it without truncation.

## Resource options

Path import resolves local resources beside the model. Byte import resolves
external URIs under `base_directory`; omit it only when every resource is
embedded. Base64 data URIs are supported; network URLs are rejected. Keep model
resources available until the import returns. Imported meshes have world
matrices, so changing one mesh does not move other meshes from the same node.
The object API returns a scene at the initial animation pose; the viewer also
provides playback controls.

## Supported inputs

Supported geometry includes triangles, strips and fans, node transforms, shared
geometry, RGB vertex colors, two UV sets, mesh instancing, skins with up to four
joint influences, and morph targets. Missing normals and tangents are generated.
Meshopt compression, quantized attributes and WebP textures are supported.
Animation supports node translation/rotation/scale, skeletal motion and morph
weights with STEP, LINEAR and CUBICSPLINE interpolation. Model cameras, lights,
and camera/light/material animation are ignored.

Materials support core metallic/roughness PBR, scalar transmission/IOR, unlit
materials and emissive strength. Texture sampling supports repeat, clamp-to-edge
and mirrored-repeat on each axis, plus offset/scale UV transforms. Texture
rotation and imported normal-map UV transforms are unsupported. Imported vertex
alpha, occlusion textures and transmission textures are ignored; transmission
maps can be assigned after import. Unsupported optional extensions produce Rust
warnings (shown in the viewer); C imports ignore them. Unsupported required
extensions return an error. Sparse quantized attributes are unsupported. Draco
and Basis/KTX2 assets require conversion before import.

## Limits

Model files are limited to 128 MiB, combined model buffers to 512 MiB and source
material images to 64M pixels each. Imported textures shrink to at most 512
pixels on their longest side; models with many images use a lower limit to fit
the shared 12M-pixel material budget. The node hierarchy is limited to 512 levels.
Additional [native scene and texture limits](scene-format.md#limits) apply.
