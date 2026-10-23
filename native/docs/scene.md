# Scenes

Build scenes with Rust `scene_api::Scene` or the C `mt_scene` handle in
[mutracer-scene-api.h](../include/mutracer-scene-api.h), submit them with
`set_scene_object` / `mt_engine_set_scene_object`, and commit with `update` /
`mt_engine_update`. The header and Rust types document each descriptor field,
default and handle rule. To load a model, use [glTF import](gltf.md).

## Build a scene

Add geometry, materials, textures and lights, then meshes that reference them.
Meshes hold world matrices without a parent hierarchy; instancing gives one mesh
many local matrices (`Mesh::instances` / `mt_scene_add_instances`). Materials are
OpenPBR: the descriptor holds the common fields, and the property setters
(`set_float`, `set_uint`, `set_texture` / `mt_scene_material_set_*`) reach every
other property through the
[material property IDs](../include/mutracer-material-properties.h).

Defaults to know:

- The environment is black and materials emit no light. Add a light, an
  environment map or emission to see anything.
- Without a camera, renders use a 45° perspective camera at the origin looking
  along -Z. An engine camera (`set_camera`) overrides the scene's default camera.
- Output size and quality belong to each render, not to the scene.

Engines keep submitted snapshots, so a scene can be edited or destroyed after
`set_scene_object` returns. Rust geometry, image and instance arrays are `Arc`s
that scenes can share (`Arc::make_mut` edits one); C copies every input.

## Edit a scene

Edit the scene through its `*_mut` accessors (Rust) or `mt_scene_set_*` and
`mt_scene_remove_*` calls (C), then call `set_scene_object` and `update` again.
Several edits can share one update. The engine compares the new snapshot with
the committed scene and reuses prepared resources when it can. Every commit
restarts accumulation, and both paths render the same image.

These edits commit incrementally:

- Camera changes; mesh and instance matrices; existing instance colors.
- Vertex positions, normals and tangents when the topology and the presence of
  normal and tangent arrays stay the same.
- Material base color, roughness, metalness, transmission and IOR, unless the
  edit needs a new shader variant.
- Texture sampling parameters and pixels, including environment and background
  map pixels and sizes, while the texture atlas still fits.
- Adding, removing and changing lights; background color.

These edits need full preparation, which runs on a library thread while the
previous image stays visible ([engine updates](engine.md#updates)):

- Other material properties, including emission color and strength, coat,
  opacity, thin walls and other OpenPBR layers, and adding, removing or changing
  a material's texture references.
- Changes to a texture used as a displacement map.
- Changed triangle indices, vertex or index counts, or UVs.
- Adding, removing or reordering mesh references; changed instance counts or
  presence of instance colors.
- Changed texture counts; adding or removing environment or background maps.
- Edits that need a new shader variant or a larger texture atlas.

`pending_commit_kind` / `mt_scene_pending_commit_kind` predicts the next commit
but cannot see shader-variant and atlas requirements; `mt_render_info` reports
the actual one. Comparison scans the scene, so edit cost grows with scene size.
Keep one Scene and edit it in place to reuse its encoding storage.

## Supported inputs

- Indexed triangles with optional normals, tangents, two UV sets, vertex colors
  and per-vertex material indices. Missing normals and tangents are generated.
- Shared geometry, per-mesh material tables and instance batches.
- Perspective and orthographic cameras with depth of field.
- Rectangular, spherical, directional and spot lights; emissive meshes;
  textures on rectangular lights; IES profiles on spot lights.
- RGBA8 sRGB and linear RGBA32F textures; RGBA32F environment and background
  maps.
- Every OpenPBR property, including displacement.

Large coordinates are limited by Float32 inputs and GPU matrices. Displacement
color and normal output can differ between the
[ray tracing backends](../README.md#ray-tracing-backends). Size and count limits
are in the [scene format reference](scene-format.md#limits).
