/* Minimal native render: build a scene, commit it, render and read HDR pixels.
 * Usage: minimal-host [samples]. Build with -I native/include and link the library. */
#include "mutracer-context.h"
#include "mutracer-scene-builder.h"
#include <stdio.h>
#include <stdlib.h>

#define CHECK(call) do { mt_status s = (call); if (s != MT_OK) { \
  fprintf(stderr, "%s: mt_status %d: %s\n", #call, (int)s, error); return 1; } } while (0)

int main(int argc, char **argv) {
  char error[1024] = "";
  uint32_t samples = argc > 1 ? (uint32_t)atoi(argv[1]) : 16;
  /* A red quad facing a rectangular light, seen from above and in front. */
  const float positions[] = {-1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0, 1};
  const uint32_t indices[] = {0, 1, 2, 2, 1, 3};
  mt_scene_builder b; mt_scene_builder_init(&b);
  mt_geometry_v4 geometry = {0};
  geometry.vertex_count = 4; geometry.index_count = 6;
  geometry.position_offset = mt_scene_builder_append(&b, positions, sizeof positions);
  geometry.index_offset = mt_scene_builder_append(&b, indices, sizeof indices);
  mt_mesh_v4 mesh = {0}; mt_scene_identity(mesh.world_matrix);
  mt_material_v4 material = mt_material_v4_default();
  material.base_color[1] = material.base_color[2] = 0.1f;
  mt_light_v4 light = {0};
  light.type = MT_LIGHT_TYPE_RECT; light.color[0] = light.color[1] = light.color[2] = 1;
  light.intensity = 10; light.size_or_radius = light.height_or_inner_angle = 1; light.spread_or_outer_angle = 1;
  const float light_at[3] = {0, 2, 0}, light_target[3] = {0, 0, 0.001f};
  mt_scene_look_at(light.world_matrix, light_at, light_target); /* Emits along -Z. */
  mt_camera_v4 camera = mt_camera_v4_default();
  const float eye[3] = {0, 2, 3}, target[3] = {0, 0, 0};
  mt_scene_look_at(camera.world_matrix, eye, target);
  mt_scene_header_v4 header = {0};
  header.width = 64; header.height = 48;
  header.geometry_count = header.mesh_count = header.material_count = header.light_count = 1;
  header.geometry_offset = mt_scene_builder_append(&b, &geometry, sizeof geometry);
  header.mesh_offset = mt_scene_builder_append(&b, &mesh, sizeof mesh);
  header.material_offset = mt_scene_builder_append(&b, &material, sizeof material);
  header.light_offset = mt_scene_builder_append(&b, &light, sizeof light);
  header.camera_offset = mt_scene_builder_append(&b, &camera, sizeof camera);
  size_t bytes = mt_scene_builder_finish(&b, &header);
  if (!bytes) { fprintf(stderr, "Out of memory\n"); return 1; }

  mt_context context = 0;
  CHECK(mt_context_create(&context, error, sizeof error));
  CHECK(mt_context_commit(context, mt_scene_builder_bytes(&b), bytes, error, sizeof error));
  mt_scene_builder_free(&b); /* Commit copied the descriptor. */
  CHECK(mt_context_render(context, samples, error, sizeof error));
  size_t written = 0;
  float *pixels = malloc((size_t)header.width * header.height * 16);
  if (!pixels) return 1;
  CHECK(mt_context_read_pixels(context, MT_IMAGE_HDR, pixels, (size_t)header.width * header.height * 16,
    &written, error, sizeof error));
  double red = 0, green = 0;
  for (size_t i = 0; i < written / 4; i += 4) { red += pixels[i]; green += pixels[i + 1]; }
  printf("mean red %.4f, green %.4f over %u samples\n", red * 16 / written, green * 16 / written, samples);
  free(pixels);
  CHECK(mt_context_destroy(context, error, sizeof error));
  return red > green && red > 0 ? 0 : 1;
}
