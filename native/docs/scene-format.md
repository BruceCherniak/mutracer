# Native scene descriptor format (v4)

`mt_context_commit` takes a scene as one byte buffer: the raw scene descriptor.
This page is the reference for its layout, values and validation rules. The
record structs are in [`mutracer-scene.h`](../include/mutracer-scene.h), the word
offsets in [`mutracer-layout.h`](../include/mutracer-layout.h), and material
property IDs in
[`mutracer-material-properties.h`](../include/mutracer-material-properties.h).

## Usage

Fill the record structs and assemble them with the header-only builder in
[`mutracer-scene-builder.h`](../include/mutracer-scene-builder.h).
[`examples/minimal-host.c`](../examples/minimal-host.c) is a complete program
that builds, commits, renders and reads one scene.

```c
#include "mutracer-context.h"
#include "mutracer-scene-builder.h"

mt_scene_builder b;
mt_scene_builder_init(&b);
mt_geometry_v4 geometry = {0};
geometry.vertex_count = 4;
geometry.index_count = 6;
geometry.position_offset = mt_scene_builder_append(&b, positions, sizeof positions);
geometry.index_offset = mt_scene_builder_append(&b, indices, sizeof indices);
mt_material_v4 material = mt_material_v4_default();
/* ... mesh, light, camera ... */
mt_scene_header_v4 header = {0};
header.width = 640;
header.height = 480;
header.geometry_count = 1;
header.geometry_offset = mt_scene_builder_append(&b, &geometry, sizeof geometry);
/* ... remaining tables ... */
size_t bytes = mt_scene_builder_finish(&b, &header);
mt_context_commit(context, mt_scene_builder_bytes(&b), bytes, error, sizeof error);
mt_scene_builder_free(&b);
```

- Append arrays first, store the returned word offsets in the records that
  reference them, then append each record table as one contiguous array.
- `mt_scene_builder_append` returns 0 after an allocation failure, and
  `mt_scene_builder_finish` then returns 0. Check the byte count before committing.
- Start materials, textures and cameras from `mt_material_v4_default()`,
  `mt_texture_v4_default()` and `mt_camera_v4_default()`. A zeroed record is
  not a neutral default: opacity 0 is transparent and texture index 0 is a real
  texture.
- `mt_scene_look_at` writes a camera-to-world (or light-to-world) matrix whose
  -Z axis points from `eye` to `target`, with +Y up. It cannot look straight up
  or down.
- Commit copies the descriptor, so the builder can be freed right after it.
- A rejected descriptor returns `MT_ERROR_INVALID_ARGUMENT` with a message
  naming the problem, and the previous scene stays committed.

Without the builder, write records into a `uint32_t` buffer with `memcpy` and
fill the header last. The structs have no padding and compile-time checks keep
them in agreement with `mutracer-layout.h`.

## Layout

The descriptor is a sequence of little-endian 32-bit words. `uint32_t` fields
are integers and `float` fields are IEEE binary32 bits. Every offset is a word
offset from the start of the descriptor; the header occupies words 0..31.

- Table offsets in the header must lie inside the descriptor, at word 32 or
  later, even when the table is empty. The builder handles empty light and
  texture tables.
- Optional arrays use offset 0 to mean "absent".
- Reserved fields and padding words must be 0.
- All floats must be finite.
- Matrices are 16 floats, column-major, invertible and affine.

### Header (`mt_scene_header_v4`, 32 words)

| Words | Field | Meaning |
| --- | --- | --- |
| 0 | `version` | `MT_VERSION_SCENE` (4). Other versions are rejected. |
| 1 | `total_words` | Descriptor length in words. |
| 2–3 | `width`, `height` | Output size in pixels. |
| 4–8 | `*_count` | Geometry, mesh, material, light and texture counts. |
| 9–14 | `*_offset` | Geometry, mesh, material, light, texture tables and the single camera record. |
| 16–19 | `background_color` | Linear RGBA shown where no background map is visible. |
| 20 | `environment_texture_plus_one` | Texture index + 1 lighting the scene; 0 for none. |
| 21 | `background_texture_plus_one` | Texture index + 1 shown as the visible background; 0 for none. |
| 22 | `quality_flags` | `MT_QUALITY_BEVEL`, `MT_QUALITY_DISPERSION` (three wavelengths), `MT_QUALITY_HIDE_BACKGROUND`. Other bits are rejected. |
| 23 | `batch_offset` | 0, or `mesh_count` batch records for instancing. |

Environment and background maps must be linear RGBA32F equirectangular
textures; their flip and UV transform fields are ignored. Lighting and the
visible background are independent. A hidden background cannot also select a
background map.

### Geometry (`mt_geometry_v4`, 12 words)

`vertex_count` and `index_count`, then offsets to: positions (float XYZ),
indices (`uint32_t`, three per triangle), normals (float XYZ), two UV sets
(float XY), vertex colors (float RGB), tangents (float XYZW) and per-vertex
material indices (`uint32_t` into the mesh's material table). Positions and
indices are required. Missing normals and tangents are generated.

All three vertices of a triangle must select the same material. Duplicate
shared vertices where neighboring triangles use different materials.

### Mesh (`mt_mesh_v4`, 20 words)

`geometry_index`, `material_index`, `material_table_offset`,
`material_table_count` and a local-to-world `world_matrix`. With a table count
of 0 the mesh uses `material_index`; otherwise the table holds `uint32_t`
material indices selected by the geometry's per-vertex material indices.
Several meshes may share one geometry.

### Batch (`mt_batch_v4`, 4 words, one per mesh)

When `batch_offset` is nonzero, each mesh has a batch record:

- `count = MT_BATCH_ORDINARY_MESH`: an ordinary mesh; both offsets must be 0.
- `count = 0`: an empty batch that renders nothing; both offsets must be 0.
- Otherwise `count` instances, with `count` column-major local matrices at
  `transforms_offset` and optional `count` RGB multipliers at `colors_offset`.
  The mesh world matrix is applied outside each local matrix.

The expanded instance count across all meshes is at most 65,536.

### Material (`mt_material_v4`, 24 words)

| Field | Default |
| --- | --- |
| `base_color` (linear RGB) | 0.8, 0.8, 0.8 |
| `roughness`, `metalness`, `transmission` | 0.3, 0, 0 |
| `ior` | 1.5 |
| `emission_color` (linear RGB), `emission_luminance` | 1, 1, 1 and 0 |
| `coat_weight`, `coat_roughness` | 0, 0 |
| `opacity` | 1 |
| `thin_walled` | 0 |
| `base_texture`, `normal_texture`, `metallic_roughness_texture`, `emissive_texture` | `MT_NO_TEXTURE` |

The defaults are those of `mt_material_v4_default()` and match the browser
`OpenPBRMaterial`.

`extension_count` and `extension_offset` select an array of
`mt_material_extension_v4` entries `{id, value[3]}` that set any other OpenPBR
property: thin film, participating media, anisotropy, coat, fuzz, alpha modes,
displacement and further texture slots. Each ID appears at most once. Float,
color and vec2 properties use `value.f`; bool, enum and texture properties use
`value.u` (`mt_extension_float` and `mt_extension_uint` build entries). Unused
components must be 0. Extensions override the basic fields, and omitted
properties keep their defaults. The property header lists each ID's type and
enum values; use OpenPBR's documented ranges.

Displacement:

- Only the first material of a mesh supplies displacement inputs.
- Active displacement needs a square power-of-two texture, a positive step size,
  and UVs when the projection is `none`. Triplanar, spherical and cylindrical
  projections work without UVs, and negative amplitudes are allowed.
- The absolute projection scale, and each position or UV component multiplied by
  it, must not exceed 1,000,000.

### Texture (`mt_texture_v4`, 12 words)

`width`, `height`, `storage` (`MT_TEXTURE_STORAGE_RGBA8_SRGB`: one packed RGBA8
sRGB word per pixel, or `MT_TEXTURE_STORAGE_RGBA32F`: four linear floats per
pixel), `pixel_offset` (row-major pixels), `flip_y`, `uv_channel` (0 or 1),
`uv_scale` and `uv_offset`. Supply each texture separately; the library packs
them into an atlas and may scale large sources to fit.

### Light (`mt_light_v4`, 28 words)

| Type | `size_or_radius` | `height_or_inner_angle` | `spread_or_outer_angle` |
| --- | --- | --- | --- |
| `MT_LIGHT_TYPE_RECT` | width > 0 | height > 0 | spread |
| `MT_LIGHT_TYPE_SPHERE` | radius | — | — |
| `MT_LIGHT_TYPE_DIRECTIONAL` | — | — | — |
| `MT_LIGHT_TYPE_SPOT` | source radius | inner angle | outer angle |

- Every light has a linear RGB `color`, an `intensity` and a light-to-world
  matrix. Rectangular, spot and directional lights emit along their local -Z
  axis; local +X is the IES reference direction.
- Spot angles are in degrees, with 0 ≤ inner ≤ outer < 90 and outer > 0.
- Only rectangular lights accept `texture_plus_one` (texture index + 1, 0 for
  none).
- Only spot lights accept an IES profile: `ies_offset` is a word offset and
  `ies_bytes` a byte length of UTF-8 LM-63 Type C text with `TILT=NONE`, at most
  16 KiB, without a terminating NUL. Use offset 0 with length 0 for none.
  Lights that reuse the same offset and length share one profile, and an
  invalid profile is rejected.

### Camera (`mt_camera_v4`, 32 words)

`projection` (`MT_CAMERA_PROJECTION_PERSPECTIVE` or `_ORTHOGRAPHIC`), vertical
`fov` in degrees, `near_clip`, `far_clip`, orthographic `left`, `right`,
`bottom`, `top`, `zoom`, then lens fields `f_stop` (0 disables depth of field),
`focus_distance`, `sensor_height` and `meters_per_unit`, and a camera-to-world
`world_matrix`. The camera looks down its local -Z axis. The aspect ratio
follows `width` and `height`. `mt_context_update_camera` accepts this record
on its own.

## Limits

- At least one geometry, mesh and material; at most 4,096 geometries, 65,536
  meshes and materials, 64 analytic lights and 256 textures.
- At most 512 MiB of input, 4,194,304 output pixels and 16,777,216 texture
  pixels in total.
- At most 4,000,000 vertices and 12,000,000 indices per geometry. Preparation
  has a conservative 1 GiB budget estimated from vertex and index counts,
  including material-related expansion.
- The texture atlas is limited to 64 MiB, 4,096 pixels per side and 256 layers;
  larger sources are scaled down.
