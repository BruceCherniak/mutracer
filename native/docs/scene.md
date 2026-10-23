# Scenes

Build scenes with Rust `scene_api::Scene` or the C `mt_scene` handle in
[mutracer-scene-api.h](../include/mutracer-scene-api.h), then submit them to an
engine with `set_scene_object` / `mt_engine_set_scene_object` and commit with
`update` / `mt_engine_update`. The [quick start](../README.md#quick-start) shows
a complete program. To load a model, use [glTF import](gltf.md).

## Build a scene

- Add geometry, materials, textures, meshes and lights, then set the
  environment and an optional default camera. Each add returns a handle owned by
  that scene. Deleted or foreign handles return `InvalidHandle` /
  `MT_ERROR_INVALID_HANDLE`, and encoding fails while a mesh still refers to a
  deleted resource.
- Meshes hold world matrices; there is no parent hierarchy. Several meshes can
  share one geometry.
- Instancing: set Rust `Mesh::instances`, or call `mt_scene_add_instances` /
  `mt_scene_set_instances` (NULL restores an ordinary mesh). Each instance has a
  local matrix, applied inside the mesh's world matrix, and an optional RGB
  multiplier.
- Materials are OpenPBR. The C descriptor and Rust `OpenPbrMaterial::values`
  hold the common fields. Set other properties with
  `mt_scene_material_set_float`, `_set_uint` and `_set_texture` (Rust
  `set_float`, `set_uint`, `set_texture`) and the
  [material property IDs](../include/mutracer-material-properties.h). Defaults
  match the browser `OpenPBRMaterial`.
- Textures are RGBA8 sRGB or linear RGBA32F. Environment and background maps
  must be RGBA32F equirectangular images.
- Initialize every C descriptor with its `*_default()` function.

Defaults to know:

- The environment is black and materials emit no light. Add a light, an
  environment map or emission to see anything.
- Without a camera, renders use a 45° perspective camera at the origin looking
  along -Z. An engine camera (`set_camera`) overrides the scene's default
  camera.
- Output size and quality belong to each render, not to the scene.

Matrices are column-major Float32. Lights and cameras look along their local
-Z axis; angles are in degrees.

## Edit a scene

Edit the scene, then call `set_scene_object` and `update` again. Several edits
can share one update.

- Rust: `geometry_mut`, `material_mut`, `texture_mut`, `mesh_mut`, `light_mut`,
  `set_environment` and `set_default_camera`.
- C: `mt_scene_set_geometry`, `_set_texture`, `_set_mesh`,
  `_set_mesh_transform`, `_set_instances`, `_set_light`, `_set_environment`,
  `_set_default_camera`, the material property setters, and the matching
  `mt_scene_remove_*` calls.

The engine compares the new snapshot with the committed scene and reuses
prepared resources when it can. Every commit restarts accumulation, and both
paths render the same image.

These edits commit incrementally:

- Camera changes; mesh and instance matrices; existing instance colors.
- Vertex positions, normals and tangents when the topology and the presence of
  normal and tangent arrays stay the same.
- Material base color, roughness, metalness, transmission and IOR, unless the
  edit needs a new shader variant.
- Texture sampling parameters and pixels, including environment and background
  map pixels and sizes, while the texture atlas still fits.
- Adding, removing and changing lights; background color.

These edits need full preparation:

- Other material properties, including emission color and strength, coat,
  opacity, thin walls and other OpenPBR layers, and adding, removing or changing
  a material's texture references.
- Changes to a texture used as a displacement map.
- Changed triangle indices, vertex or index counts, or UVs.
- Adding, removing or reordering mesh references; changed instance counts or
  presence of instance colors.
- Changed texture counts; adding or removing environment or background maps.
- Edits that need a new shader variant or a larger texture atlas.

Full preparation runs on a library thread while the previous image stays
visible; see [engine updates](engine.md#updates).

`Scene::pending_commit_kind()` / `mt_scene_pending_commit_kind` predicts the
next commit: Full before the first snapshot, otherwise Incremental or Full. It
cannot see shader-variant and atlas requirements, so a predicted Incremental can
still run as Full. `mt_render_info` reports the actual `last_commit`.

Costs: comparison scans the scene, so edit cost grows with scene size. Keep one
Scene and edit it in place to reuse its encoding storage; unchanged shared
vertex and image arrays are not rewritten.

## Ownership and threads

- Rust geometry, image and instance arrays are `Arc`s that scenes can share;
  edit one with `Arc::make_mut`. C copies arrays and strings during each call.
- Engines keep submitted snapshots, so the source scene can be edited or
  destroyed after `set_scene_object` returns. Encoding a snapshot can allocate a
  new descriptor while an older snapshot is still in use.
- A C scene can be used from any thread, one thread at a time; overlapping calls
  can return `MT_ERROR_BUSY`. After a caught panic, scene calls return
  `MT_ERROR_CONTEXT_FAILED`; destroy and recreate the scene.

## Export a descriptor

`Scene::descriptor()` / `mt_scene_encode` exports the current snapshot as a
[version-4 descriptor](scene-format.md) with 1×1 dimensions and quality flags 0.
Engines replace these with each render's settings; the context API uses them as
given.

## Supported inputs

- Indexed triangles with optional normals, tangents, two UV sets, vertex colors
  and per-vertex material indices. Missing normals and tangents are generated.
- Shared geometry, per-mesh material tables and instance batches.
- Perspective and orthographic cameras with depth of field.
- Rectangular, spherical, directional and spot lights; emissive meshes;
  textures on rectangular lights; IES profiles on spot lights.
- Environment and background maps.
- Every OpenPBR property, including displacement.

Large coordinates are limited by Float32 inputs and GPU matrices. Displacement
color and normal output can differ between the
[ray tracing backends](../README.md#ray-tracing-backends). Size and count limits
are in the [scene format reference](scene-format.md#limits).
