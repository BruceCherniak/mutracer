#ifndef MUTRACER_SCENE_BUILDER_H
#define MUTRACER_SCENE_BUILDER_H
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "mutracer-scene.h"
/* Header-only helper that assembles a v4 scene descriptor in a growable,
 * word-aligned buffer. It adds no library symbols. See
 * native/docs/scene-format.md and native/examples/minimal-host.c.
 *
 *   mt_scene_builder b; mt_scene_builder_init(&b);
 *   mesh.geometry_index = 0; ...
 *   header.mesh_offset = mt_scene_builder_append(&b, meshes, sizeof meshes);
 *   size_t bytes = mt_scene_builder_finish(&b, &header);
 *   mt_context_commit(context, mt_scene_builder_bytes(&b), bytes, ...);
 *   mt_scene_builder_free(&b);
 *
 * Append order is free: append arrays first, store the returned offsets in the
 * records that reference them, then append the record tables. The header
 * occupies the first MT_HEADER_WORDS words and is written by finish. Any
 * allocation or size failure makes later appends return 0 and finish return 0.
 */
typedef struct mt_scene_builder {
  uint32_t *words;
  size_t used, capacity; /* In words. */
  int failed;
} mt_scene_builder;

static inline void mt_scene_builder_init(mt_scene_builder *builder) {
  builder->words = NULL;
  builder->used = MT_HEADER_WORDS;
  builder->capacity = 0;
  builder->failed = 0;
}
static inline void mt_scene_builder_free(mt_scene_builder *builder) {
  free(builder->words);
  mt_scene_builder_init(builder);
}
/* Copies bytes (or zeros when data is NULL), padded with zeros to whole words.
 * Returns the word offset of the copy, or 0 on failure. */
static inline uint32_t mt_scene_builder_append(mt_scene_builder *builder, const void *data, size_t bytes) {
  size_t count = bytes / MT_WORD_BYTES + (bytes % MT_WORD_BYTES != 0);
  if (builder->failed || count > UINT32_MAX - builder->used) {
    builder->failed = 1;
    return 0;
  }
  if (builder->used + count > builder->capacity) {
    size_t capacity = builder->capacity ? builder->capacity : 1024;
    while (capacity < builder->used + count) capacity *= 2;
    uint32_t *words = (uint32_t *)realloc(builder->words, capacity * MT_WORD_BYTES);
    if (!words) {
      builder->failed = 1;
      return 0;
    }
    memset(words + builder->capacity, 0, (capacity - builder->capacity) * MT_WORD_BYTES);
    builder->words = words;
    builder->capacity = capacity;
  }
  uint32_t offset = (uint32_t)builder->used;
  if (data && bytes) memcpy(builder->words + offset, data, bytes);
  builder->used += count;
  return offset;
}
/* Sets header->version and header->total_words, points empty tables left at
 * offset 0 at MT_HEADER_WORDS (table offsets must stay inside the descriptor
 * even when their count is 0), copies the header to word 0 and returns the
 * descriptor length in bytes, or 0 on failure. */
static inline size_t mt_scene_builder_finish(mt_scene_builder *builder, mt_scene_header_v4 *header) {
  if (!builder->words && !builder->failed) mt_scene_builder_append(builder, NULL, 0);
  if (builder->failed || !builder->words) return 0;
  if (!header->light_count && !header->light_offset) header->light_offset = MT_HEADER_WORDS;
  if (!header->texture_count && !header->texture_offset) header->texture_offset = MT_HEADER_WORDS;
  header->version = MT_VERSION_SCENE;
  header->total_words = (uint32_t)builder->used;
  memcpy(builder->words, header, sizeof *header);
  return builder->used * MT_WORD_BYTES;
}
static inline const uint8_t *mt_scene_builder_bytes(const mt_scene_builder *builder) {
  return (const uint8_t *)builder->words;
}

/* Records with the library defaults; zero-initialized records are not valid
 * because texture slot 0 and opacity 0 are meaningful values. */
static inline void mt_scene_identity(float matrix[16]) {
  memset(matrix, 0, 16 * sizeof(float));
  matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1.0f;
}
/* Camera-to-world matrix at eye looking at target, with +Y up. */
static inline void mt_scene_look_at(float matrix[16], const float eye[3], const float target[3]) {
  float z[3] = {eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]};
  float n = sqrtf(z[0] * z[0] + z[1] * z[1] + z[2] * z[2]);
  z[0] /= n; z[1] /= n; z[2] /= n;
  float x[3] = {z[2], 0.0f, -z[0]}; /* up x z */
  n = sqrtf(x[0] * x[0] + x[2] * x[2]);
  x[0] /= n; x[2] /= n;
  float y[3] = {z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]};
  mt_scene_identity(matrix);
  for (int k = 0; k < 3; k++) {
    matrix[k] = x[k]; matrix[4 + k] = y[k]; matrix[8 + k] = z[k]; matrix[12 + k] = eye[k];
  }
}
static inline mt_material_v4 mt_material_v4_default(void) {
  mt_material_v4 material;
  memset(&material, 0, sizeof material);
  material.base_color[0] = material.base_color[1] = material.base_color[2] = 0.8f;
  material.roughness = 0.3f;
  material.ior = 1.5f;
  material.emission_color[0] = material.emission_color[1] = material.emission_color[2] = 1.0f;
  material.opacity = 1.0f;
  material.base_texture = material.normal_texture = MT_NO_TEXTURE;
  material.metallic_roughness_texture = material.emissive_texture = MT_NO_TEXTURE;
  return material;
}
static inline mt_texture_v4 mt_texture_v4_default(void) {
  mt_texture_v4 texture;
  memset(&texture, 0, sizeof texture);
  texture.uv_scale[0] = texture.uv_scale[1] = 1.0f;
  return texture;
}
/* Perspective, 45 degree vertical field of view, no depth of field. */
static inline mt_camera_v4 mt_camera_v4_default(void) {
  mt_camera_v4 camera;
  memset(&camera, 0, sizeof camera);
  camera.projection = MT_CAMERA_PROJECTION_PERSPECTIVE;
  camera.fov = 45.0f;
  camera.near_clip = 0.1f;
  camera.far_clip = 1000.0f;
  camera.left = camera.bottom = -1.0f;
  camera.right = camera.top = 1.0f;
  camera.zoom = 1.0f;
  camera.focus_distance = 10.0f;
  camera.sensor_height = 24.0f;
  camera.meters_per_unit = 1.0f;
  mt_scene_identity(camera.world_matrix);
  return camera;
}
static inline mt_material_extension_v4 mt_extension_float(uint32_t id, float x, float y, float z) {
  mt_material_extension_v4 entry;
  memset(&entry, 0, sizeof entry);
  entry.id = id;
  entry.value.f[0] = x; entry.value.f[1] = y; entry.value.f[2] = z;
  return entry;
}
/* Bool, enum and texture properties. */
static inline mt_material_extension_v4 mt_extension_uint(uint32_t id, uint32_t value) {
  mt_material_extension_v4 entry;
  memset(&entry, 0, sizeof entry);
  entry.id = id;
  entry.value.u[0] = value;
  return entry;
}
#endif
