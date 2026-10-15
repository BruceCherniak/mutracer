#include "mutracer-probe.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

_Static_assert(sizeof(mt_probe_options) == 52, "C descriptor layout changed");

static int render(const char *scene, const char *root, const char *name,
                  const mt_probe_options *options, uint64_t *hash) {
  char path[4096], error[4096];
  int n = snprintf(path, sizeof(path), "%s/%s", root, name);
  if (n < 0 || (size_t)n >= sizeof(path)) return 1;
  if (mt_probe_render_with_options(scene, path, options, error, sizeof(error))) {
    fprintf(stderr, "%s\n", error); return 1;
  }
  n = snprintf(path, sizeof(path), "%s/%s/render.rgba32f", root, name);
  if (n < 0 || (size_t)n >= sizeof(path)) return 1;
  FILE *file = fopen(path, "rb");
  if (!file) return 1;
  *hash = UINT64_C(14695981039346656037);
  int byte;
  while ((byte = fgetc(file)) != EOF) *hash = (*hash ^ (uint8_t)byte) * UINT64_C(1099511628211);
  const int failed = ferror(file); fclose(file);
  return failed;
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  mt_probe_options options = { .struct_size = sizeof(options), .samples = 256,
    .seed = 12345, .bounces = 6, .base_color = {.5f, .5f, .5f}, .roughness = .5f };
  char error[256];
  options.flags = 8;
  if (mt_probe_render_with_options(argv[1], argv[2], &options, error, sizeof(error)) != 1 ||
      !strstr(error, "Unknown render options flags")) return 3;
  options.flags = 1; options.camera_offset[0] = NAN;
  if (mt_probe_render_with_options(argv[1], argv[2], &options, error, sizeof(error)) != 1 ||
      !strstr(error, "Non-finite camera")) return 3;
  options.flags = 2; options.camera_offset[0] = 0; options.material_index = 9999;
  if (mt_probe_render_with_options(argv[1], argv[2], &options, error, sizeof(error)) != 1 ||
      !strstr(error, "Material index")) return 3;
  options.flags = 0; options.material_index = 1;
  uint64_t baseline, zero, camera, material, roughness, restored;
  if (render(argv[1], argv[2], "baseline", &options, &baseline)) return 1;
  options.flags = 1;
  if (render(argv[1], argv[2], "camera-zero", &options, &zero) || zero != baseline) return 4;
  options.camera_offset[0] = .7f; options.camera_offset[1] = .15f;
  if (render(argv[1], argv[2], "camera-moved", &options, &camera) || camera == baseline) return 4;
  options.flags = 2;
  options.base_color[0] = .8f; options.base_color[1] = .08f; options.base_color[2] = .04f;
  options.roughness = .95f;
  if (render(argv[1], argv[2], "material-rough", &options, &roughness) || roughness == baseline) return 4;
  options.base_color[0] = .05f; options.base_color[1] = .8f; options.base_color[2] = .15f;
  options.roughness = .9f;
  if (render(argv[1], argv[2], "material-green", &options, &material) || material == baseline) return 4;
  options.flags = 0;
  if (render(argv[1], argv[2], "restored", &options, &restored) || restored != baseline) return 4;
  printf("{\"baseline\":\"%016llx\",\"zeroCameraMatches\":true,\"cameraChanged\":true,"
         "\"materialChanged\":true,\"roughnessChanged\":true,\"restoredMatches\":true,\"invalidInputsRejected\":3}\n",
         (unsigned long long)baseline);
  return 0;
}
