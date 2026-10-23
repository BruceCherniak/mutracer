#ifndef MUTRACER_SCENE_API_H
#define MUTRACER_SCENE_API_H
#include "mutracer-engine.h"
#ifdef __cplusplus
extern "C" {
#endif
#if defined(__cplusplus) && __cplusplus >= 201103L
#define MT_SCENE_API_LAYOUT(type,size) static_assert(sizeof(type)==(size), #type " layout")
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
#define MT_SCENE_API_LAYOUT(type,size) _Static_assert(sizeof(type)==(size), #type " layout")
#else
#define MT_SCENE_API_LAYOUT(type,size)
#endif
/* Scene construction above the binary descriptor API. All arrays/strings are
 * copied during the call. A scene and its objects may be used from any thread,
 * one thread at a time; overlapping calls can return MT_ERROR_BUSY. Errors,
 * struct_size validation and error buffers follow mutracer-engine.h.
 * Handles are scene-scoped and never reused. Deleting a resource invalidates
 * its handle; a remaining reference makes encoding fail INVALID_HANDLE.
 * After a caught panic, further scene calls return MT_ERROR_CONTEXT_FAILED;
 * destroy and recreate the scene.
 * Destroying a scene invalidates its objects. Engines retain submitted snapshots
 * independently, so a scene can be destroyed after set_scene_object returns.
 * Initialize every descriptor with its matching *_default(). Reserved fields 0.
 * Matrices are column-major, lights/cameras look along -Z, angles are degrees.
 */
typedef uint64_t mt_scene;
typedef uint64_t mt_geometry_id;
typedef uint64_t mt_material_id;
typedef uint64_t mt_texture_id;
typedef uint64_t mt_mesh_id;
typedef uint64_t mt_light_id;

typedef struct mt_geometry_desc {
  uint32_t struct_size, vertex_count, index_count, reserved;
  const float *positions; const uint32_t *indices;
  const float *normals, *uv, *uv1, *colors, *tangents;
  const uint32_t *material_indices;
} mt_geometry_desc; /* Default empty. Required XYZ positions and triangle indices.
 * Optional arrays: normal/color XYZ, UV/UV1 XY, tangent XYZW, material index per
 * vertex into the mesh's material table. NULL omits an optional attribute. */
MT_SCENE_API_LAYOUT(mt_geometry_desc, 16 + 8 * sizeof(void *));
typedef struct mt_scene_material_desc {
  uint32_t struct_size, double_sided;
  float color[3], roughness, metalness, opacity, transmission, ior;
  float emission[3], emission_strength;
  uint32_t thin_walled, alpha_mode;
  float alpha_cutoff, normal_scale;
  uint32_t unlit, reserved;
} mt_scene_material_desc; /* Default gray .8, roughness .3, IOR 1.5, opacity 1,
 * white emission with strength 0, alpha auto, cutoff .5, normal scale 1;
 * metalness/transmission 0, solid, single-sided, lit. Other OpenPBR values use
 * native defaults. Use property setters for layers and map setters for textures. */
MT_SCENE_API_LAYOUT(mt_scene_material_desc, 80);
typedef struct mt_scene_texture_desc {
  uint32_t struct_size, storage, width, height, uv_channel, flip_y, wrap_s, wrap_t;
  float scale[2], offset[2];
  const void *pixels; size_t pixel_bytes;
} mt_scene_texture_desc; /* Default empty RGBA8 sRGB, UV0, no flip, repeat,
 * scale (1,1), offset (0,0). RGBA32F is linear. Row-major RGBA, exact byte count. */
MT_SCENE_API_LAYOUT(mt_scene_texture_desc, 48 + 2 * sizeof(void *));
typedef struct mt_scene_mesh_desc {
  uint32_t struct_size, reserved;
  mt_geometry_id geometry; mt_material_id material;
  float world_matrix[16];
  const mt_material_id *materials; size_t material_count;
} mt_scene_mesh_desc; /* Default identity, no material table; assign geometry
 * and material. Geometry/material resources must belong to this scene. */
MT_SCENE_API_LAYOUT(mt_scene_mesh_desc, 88 + 2 * sizeof(void *));
typedef struct mt_scene_instances_desc {
  uint32_t struct_size, count;
  const float *transforms, *colors;
} mt_scene_instances_desc; /* Default zero instances. count local float[16]
 * matrices; optional RGB multipliers (NULL = white). */
MT_SCENE_API_LAYOUT(mt_scene_instances_desc, 8 + 2 * sizeof(void *));
typedef struct mt_scene_light_desc {
  uint32_t struct_size, type;
  float color[3], intensity, size_or_radius, height_or_inner_angle, spread_or_outer_angle;
  uint32_t reserved;
  float world_matrix[16];
  mt_texture_id texture;
  const void *ies; size_t ies_bytes;
} mt_scene_light_desc; /* Default unit white rectangular light, intensity 1,
 * width/height/spread 1, identity, no texture or IES. Four MT_LIGHT_TYPE_* kinds;
 * texture 0 = none (rect only), IES is LM-63 text (spot only). */
MT_SCENE_API_LAYOUT(mt_scene_light_desc, 112 + 2 * sizeof(void *));
typedef struct mt_scene_environment_desc {
  uint32_t struct_size, reserved;
  mt_texture_id environment, background;
  float color[4];
} mt_scene_environment_desc; /* Default no maps, opaque black background.
 * Map handles 0 = none; environment/background require RGBA32F textures. */
MT_SCENE_API_LAYOUT(mt_scene_environment_desc, 40);
int32_t mt_geometry_desc_default(mt_geometry_desc *out);
int32_t mt_scene_material_desc_default(mt_scene_material_desc *out);
int32_t mt_scene_texture_desc_default(mt_scene_texture_desc *out);
int32_t mt_scene_mesh_desc_default(mt_scene_mesh_desc *out);
int32_t mt_scene_instances_desc_default(mt_scene_instances_desc *out);
int32_t mt_scene_light_desc_default(mt_scene_light_desc *out);
int32_t mt_scene_environment_desc_default(mt_scene_environment_desc *out);
int32_t mt_scene_create(mt_scene *out, char *error, size_t capacity);
int32_t mt_scene_destroy(mt_scene scene, char *error, size_t capacity);
int32_t mt_scene_add_geometry(mt_scene scene, const mt_geometry_desc *desc, mt_geometry_id *out, char *error, size_t capacity);
int32_t mt_scene_set_geometry(mt_scene scene, mt_geometry_id id, const mt_geometry_desc *desc, char *error, size_t capacity);
int32_t mt_scene_add_material(mt_scene scene, const mt_scene_material_desc *desc, mt_material_id *out, char *error, size_t capacity);
int32_t mt_scene_add_texture(mt_scene scene, const mt_scene_texture_desc *desc, mt_texture_id *out, char *error, size_t capacity);
int32_t mt_scene_set_texture(mt_scene scene, mt_texture_id id, const mt_scene_texture_desc *desc, char *error, size_t capacity);
int32_t mt_scene_add_mesh(mt_scene scene, const mt_scene_mesh_desc *desc, mt_mesh_id *out, char *error, size_t capacity);
int32_t mt_scene_set_mesh(mt_scene scene, mt_mesh_id id, const mt_scene_mesh_desc *desc, char *error, size_t capacity);
int32_t mt_scene_add_instances(mt_scene scene, const mt_scene_mesh_desc *mesh, const mt_scene_instances_desc *instances, mt_mesh_id *out, char *error, size_t capacity);
/* NULL instances restores an ordinary mesh. */
int32_t mt_scene_set_instances(mt_scene scene, mt_mesh_id id, const mt_scene_instances_desc *instances, char *error, size_t capacity);
int32_t mt_scene_set_mesh_transform(mt_scene scene, mt_mesh_id id, const float world_matrix[16], char *error, size_t capacity);
int32_t mt_scene_add_light(mt_scene scene, const mt_scene_light_desc *desc, mt_light_id *out, char *error, size_t capacity);
int32_t mt_scene_set_light(mt_scene scene, mt_light_id id, const mt_scene_light_desc *desc, char *error, size_t capacity);
int32_t mt_scene_remove_geometry(mt_scene scene, mt_geometry_id id, char *error, size_t capacity);
int32_t mt_scene_remove_material(mt_scene scene, mt_material_id id, char *error, size_t capacity);
int32_t mt_scene_remove_texture(mt_scene scene, mt_texture_id id, char *error, size_t capacity);
int32_t mt_scene_remove_mesh(mt_scene scene, mt_mesh_id id, char *error, size_t capacity);
int32_t mt_scene_remove_light(mt_scene scene, mt_light_id id, char *error, size_t capacity);
/* Frozen MT_MAT_* property IDs. Unused y/z must be 0; float/color/vec2 types
 * are checked. uint accepts bool/enum only. Texture references use set_texture. */
int32_t mt_material_set_float(mt_scene scene, mt_material_id id, uint32_t property, float x, float y, float z, char *error, size_t capacity);
int32_t mt_material_set_uint(mt_scene scene, mt_material_id id, uint32_t property, uint32_t value, char *error, size_t capacity);
int32_t mt_material_set_texture(mt_scene scene, mt_material_id id, uint32_t property, mt_texture_id texture, char *error, size_t capacity);
int32_t mt_scene_set_environment(mt_scene scene, const mt_scene_environment_desc *desc, char *error, size_t capacity);
/* NULL camera uses the standard 45-degree perspective default. Engine camera
 * overrides this fallback. Output dimensions and quality remain per-render. */
int32_t mt_scene_set_default_camera(mt_scene scene, const mt_camera_v4 *camera, char *error, size_t capacity);
int32_t mt_engine_set_scene_object(mt_engine engine, mt_scene scene, char *error, size_t capacity);
/* Copies a v4 snapshot (dimensions 1x1, quality 0) for advanced consumers and
 * byte comparison. NULL output, capacity 0 queries bytes. written is required. */
int32_t mt_scene_encode(mt_scene scene, void *output, size_t output_bytes, size_t *written, char *error, size_t capacity);
int32_t mt_scene_pending_commit_kind(mt_scene scene, uint32_t *kind, char *error, size_t capacity);
/* Imports create a new scene. Byte import resolves external URIs under
 * base_directory; NULL requires embedded resources. Missing gltf feature returns
 * UNAVAILABLE. Limits/extension behavior: native/README.md glTF import. */
int32_t mt_scene_import_gltf(const char *path, mt_scene *out, char *error, size_t capacity);
int32_t mt_scene_import_gltf_bytes(const void *bytes, size_t byte_count, const char *base_directory, mt_scene *out, char *error, size_t capacity);
/* Duplicate names use zero-based occurrence in traversal order. Object kind:
 * geometry 1, material 2, mesh 4, node 6 (returns a mesh handle). */
int32_t mt_scene_find(mt_scene scene, uint32_t kind, const char *name, size_t occurrence, uint64_t *out, char *error, size_t capacity);
#undef MT_SCENE_API_LAYOUT
#ifdef __cplusplus
}
#endif
#endif
