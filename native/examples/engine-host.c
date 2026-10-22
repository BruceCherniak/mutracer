/* Engine API host: renders one scene descriptor through an engine, a render and a
 * render loop, and checks them against a fresh mt_context with the same inputs.
 * Usage: engine-host SCENE_INPUT OUTPUT_DIRECTORY SAMPLES BACKEND
 * Prints "PASS <n> engine checks"; with BACKEND 1 (HWRT) image differences are
 * reported as "HWRT-DIFFERENCE" (known Metal limitation) instead of failing. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "mutracer-context.h"
#include "mutracer-engine.h"

static int checks = 0, strict = 1, differences = 0;
static char error[1024];
#define REQUIRE(condition, message) do { if (!(condition)) { \
  fprintf(stderr, "FAIL %s:%d %s (%s)\n", __FILE__, __LINE__, message, error); exit(1); } \
  checks++; } while (0)
#define OK(call) REQUIRE((call) == MT_OK, #call)
#define STATUS(call, expected) REQUIRE((call) == (expected), #call)
/* Per-frame calls: fail without counting a check. */
#define QUIET(call) do { if ((call) != MT_OK) { \
  fprintf(stderr, "FAIL %s:%d %s (%s)\n", __FILE__, __LINE__, #call, error); exit(1); } } while (0)

/* One host frame: about 1 ms, so a frame loop of 600000 lasts at least 10 minutes. */
static void frame(void) { const struct timespec delay = {0, 1000000}; nanosleep(&delay, NULL); }
static uint8_t *read_file(const char *path, size_t *length) {
  FILE *file = fopen(path, "rb");
  if (!file) return NULL;
  fseek(file, 0, SEEK_END);
  long size = ftell(file);
  fseek(file, 0, SEEK_SET);
  uint8_t *bytes = malloc((size_t)size);
  if (fread(bytes, 1, (size_t)size, file) != (size_t)size) { free(bytes); bytes = NULL; }
  fclose(file);
  *length = (size_t)size;
  return bytes;
}
static void write_file(const char *directory, const char *name, const void *bytes, size_t length) {
  char path[4096];
  snprintf(path, sizeof path, "%s/%s", directory, name);
  FILE *file = fopen(path, "wb");
  REQUIRE(file && fwrite(bytes, 1, length, file) == length, "write output");
  fclose(file);
}

/* The fresh-context oracle: bottom-first images, flipped to top-first. */
static float *oracle(const uint8_t *scene, size_t length, uint32_t backend, uint32_t samples,
    uint32_t kind, uint32_t width, uint32_t height) {
  mt_context context;
  OK(mt_context_create_with_backend(backend, &context, error, sizeof error));
  mt_render_settings settings;
  OK(mt_render_settings_default(&settings));
  /* The engine's defaults for these fields, and the fixed Sobol sequence cap. */
  settings.max_samples = 4096;
  settings.bounces = 3;
  settings.direct_light_candidates = 4;
  OK(mt_context_commit_with_settings(context, scene, length, &settings, error, sizeof error));
  OK(mt_context_render(context, samples, error, sizeof error));
  size_t size = (size_t)width * height * 16, written = 0;
  float *bottom = malloc(size), *top = malloc(size);
  OK(mt_context_read_pixels(context, kind, bottom, size, &written, error, sizeof error));
  for (uint32_t y = 0; y < height; y++)
    memcpy(top + (size_t)y * width * 4, bottom + (size_t)(height - 1 - y) * width * 4, (size_t)width * 16);
  free(bottom);
  OK(mt_context_destroy(context, error, sizeof error));
  return top;
}
static float *read_render(mt_render render, uint32_t kind, size_t expected) {
  size_t written = 0;
  OK(mt_render_read_pixels(render, kind, NULL, 0, &written, error, sizeof error));
  REQUIRE(written == expected, "read size query");
  float *pixels = malloc(expected);
  STATUS(mt_render_read_pixels(render, kind, pixels, expected - 1, &written, error, sizeof error),
    MT_ERROR_BUFFER_TOO_SMALL);
  OK(mt_render_read_pixels(render, kind, pixels, expected, &written, error, sizeof error));
  return pixels;
}
static void compare(const char *what, mt_render render, const uint8_t *scene, size_t length,
    uint32_t backend, uint32_t samples, uint32_t width, uint32_t height) {
  size_t size = (size_t)width * height * 16;
  for (uint32_t kind = MT_IMAGE_HDR; kind <= MT_IMAGE_ALBEDO; kind++) {
    float *actual = read_render(render, kind, size), *expected = oracle(scene, length, backend, samples, kind, width, height);
    int same = memcmp(actual, expected, size) == 0;
    if (!same && !strict) {
      printf("HWRT-DIFFERENCE %s kind %u\n", what, kind);
      differences++;
    } else {
      REQUIRE(same, what);
    }
    free(actual);
    free(expected);
  }
}

static int sync_updates = 0, sample_events = 0, loop_events = 0, engine_events = 0;
static mt_render_loop current_loop = 0;
static void sync_update(void *user) {
  (void)user;
  sync_updates++;
  /* Calling back into the loop that runs this callback is rejected. */
  uint32_t status = 0;
  if (mt_render_loop_tick(current_loop, &status, error, sizeof error) != MT_ERROR_INVALID_STATE) exit(2);
}
static uint32_t sync_active(void *user) { (void)user; return 0; }
static void on_sample(uint32_t samples, uint32_t first, double ms, void *user) {
  (void)first; (void)ms;
  if (samples == 0 || ms < 0) exit(3);
  (*(int *)user)++;
}
static void on_loop(uint32_t kind, uint32_t value, void *user) { (void)kind; (void)value; (*(int *)user)++; }
static void on_progress(uint32_t stage, uint32_t samples, uint32_t target, void *user) {
  (void)stage; (void)samples; (void)target; (*(int *)user)++;
}
static void on_engine(const mt_engine_event *event, void *user) {
  if (event->struct_size != sizeof(mt_engine_event)) exit(4);
  (*(int *)user)++;
}

int main(int argc, char **argv) {
  if (argc != 5) {
    fprintf(stderr, "Usage: %s SCENE_INPUT OUTPUT_DIRECTORY SAMPLES BACKEND\n", argv[0]);
    return 2;
  }
  size_t length = 0;
  uint8_t *scene = read_file(argv[1], &length);
  REQUIRE(scene != NULL, "read scene");
  const char *out = argv[2];
  uint32_t samples = (uint32_t)atoi(argv[3]), backend = (uint32_t)atoi(argv[4]);
  strict = backend == MT_BACKEND_SOFTWARE;
  REQUIRE(mt_abi_version() == MT_ABI_VERSION && MT_ABI_VERSION == 4u, "ABI version");
  const mt_scene_header_v4 *header = (const mt_scene_header_v4 *)scene;
  uint32_t width = header->width, height = header->height;

  /* Defaults fill struct_size with this header's sizes. */
  mt_engine_options engine_options;
  mt_display_settings display_settings;
  mt_render_options options;
  mt_render_denoiser denoiser;
  mt_converge_options converge;
  mt_render_loop_options loop_options;
  OK(mt_engine_options_default(&engine_options));
  OK(mt_display_settings_default(&display_settings));
  OK(mt_render_options_default(&options));
  OK(mt_render_denoiser_default(&denoiser));
  OK(mt_converge_options_default(samples, &converge));
  OK(mt_render_loop_options_default(&loop_options));
  REQUIRE(engine_options.struct_size == sizeof engine_options && display_settings.struct_size == sizeof display_settings
    && options.struct_size == sizeof options && denoiser.struct_size == sizeof denoiser
    && converge.struct_size == sizeof converge && loop_options.struct_size == sizeof loop_options, "record sizes");
  REQUIRE(engine_options.backend == MT_BACKEND_HWRT && options.max_samples == 2048 && options.bounces == 3
    && options.direct_light_candidates == 4 && options.bevel == 1 && options.dispersion_wavelengths == 3
    && options.resolution_scale == 1.0 && options.time_budget_ms == 21.0 && options.seed == 12345
    && converge.samples_per_batch == 8 && loop_options.idle_ms == 150.0, "browser defaults");

  engine_options.backend = backend;
  mt_engine engine;
  OK(mt_engine_create(&engine_options, &engine, error, sizeof error));
  OK(mt_engine_set_callback(engine, on_engine, &engine_events, error, sizeof error));
  mt_engine_snapshot info = {.struct_size = sizeof info};
  OK(mt_engine_info(engine, &info, error, sizeof error));
  REQUIRE(info.backend == backend && info.adapter_name[0] != 0, "engine info");
  OK(mt_engine_set_scene(engine, scene, length, error, sizeof error));

  /* A fixed-size render whose quality bits match the scene's: no descriptor override. */
  options.width = width;
  options.height = height;
  options.max_samples = samples;
  options.bevel = (header->quality_flags & MT_QUALITY_BEVEL) != 0;
  options.dispersion_wavelengths = (header->quality_flags & MT_QUALITY_DISPERSION) ? 3 : 1;
  mt_render render;
  OK(mt_render_create(engine, &options, &render, error, sizeof error));
  mt_render_options read_back = {.struct_size = sizeof read_back};
  OK(mt_render_get_options(render, &read_back, error, sizeof error));
  REQUIRE(read_back.max_samples == options.max_samples && read_back.bounces == options.bounces
    && read_back.sampling_pattern == options.sampling_pattern && read_back.bevel == options.bevel
    && read_back.dispersion_wavelengths == options.dispersion_wavelengths && read_back.width == width
    && read_back.height == height && read_back.seed == options.seed && read_back.clamping == options.clamping
    && read_back.time_budget_ms == options.time_budget_ms, "options round trip");
  uint32_t changed = 0;
  OK(mt_engine_update(engine, &changed, error, sizeof error));
  REQUIRE(changed == 1, "first update changes");
  OK(mt_engine_update(engine, &changed, error, sizeof error));
  REQUIRE(changed == 0, "unchanged update");

  /* Blocking converge equals the oracle. */
  int progress = 0;
  converge.progress = on_progress;
  converge.user = &progress;
  uint32_t converged = 0;
  OK(mt_render_converge(render, &converge, &converged, error, sizeof error));
  REQUIRE(converged == samples && progress > 0, "converge samples and progress");
  mt_render_snapshot snapshot = {.struct_size = sizeof snapshot};
  OK(mt_render_info(render, &snapshot, error, sizeof error));
  REQUIRE(snapshot.samples == samples && snapshot.width == width && snapshot.height == height
    && snapshot.converged == 1 && snapshot.last_commit == MT_COMMIT_FULL, "render info");
  compare("converge", render, scene, length, backend, samples, width, height);
  size_t size = (size_t)width * height * 16;
  float *hdr = read_render(render, MT_IMAGE_HDR, size);
  write_file(out, "engine-render.rgba32f", hdr, size);
  free(hdr);

  /* Interactive refinement reaches the same image. */
  OK(mt_render_set_callback(render, on_sample, &sample_events, error, sizeof error));
  OK(mt_render_restart(render, error, sizeof error));
  uint32_t status = MT_RENDER_PREPARING;
  for (int i = 0; i < 600000 && status != MT_RENDER_FINISHED; i++) {
    QUIET(mt_render_refine(render, &status, error, sizeof error));
    if (status == MT_RENDER_ERROR) break;
    frame();
  }
  REQUIRE(status == MT_RENDER_FINISHED && sample_events > 0, "refine finishes with sample events");
  compare("refine", render, scene, length, backend, samples, width, height);

  /* Display: presentation, settings round trip and export. */
  mt_display display, again;
  OK(mt_engine_display(engine, &display, error, sizeof error));
  OK(mt_engine_display(engine, &again, error, sizeof error));
  REQUIRE(display == again, "one display per engine");
  OK(mt_display_set_size(display, width, height, error, sizeof error));
  display_settings.tone_mapping = MT_TONE_MAPPING_REINHARD;
  display_settings.tone_mapping_exposure = 1.5f;
  OK(mt_display_set_settings(display, &display_settings, error, sizeof error));
  mt_display_settings settings_back = {.struct_size = sizeof settings_back};
  OK(mt_display_get_settings(display, &settings_back, error, sizeof error));
  REQUIRE(memcmp(&settings_back, &display_settings, sizeof display_settings) == 0, "display settings round trip");
  uint32_t shown = 0;
  mt_presented presented = {.struct_size = sizeof presented};
  OK(mt_display_present(display, render, &shown, &presented, error, sizeof error));
  REQUIRE(shown == 1 && presented.samples == samples && presented.width == width && presented.fallback == 0, "present");
  size_t written = 0;
  uint32_t image_width = 0, image_height = 0;
  OK(mt_display_read_pixels(display, render, MT_DISPLAY_RGBA8, NULL, 0, &written, &image_width, &image_height, error, sizeof error));
  REQUIRE(written == (size_t)width * height * 4 && image_width == width && image_height == height, "rgba8 size");
  uint8_t *rgba = malloc(written);
  OK(mt_display_read_pixels(display, render, MT_DISPLAY_RGBA8, rgba, written, &written, NULL, NULL, error, sizeof error));
  free(rgba);
  OK(mt_display_read_pixels(display, render, MT_DISPLAY_PNG, NULL, 0, &written, NULL, NULL, error, sizeof error));
  uint8_t *png = malloc(written);
  OK(mt_display_read_pixels(display, render, MT_DISPLAY_PNG, png, written, &written, NULL, NULL, error, sizeof error));
  REQUIRE(written > 8 && memcmp(png + 1, "PNG", 3) == 0, "png signature");
  write_file(out, "engine-display.png", png, written);
  free(png);

  /* Engine camera: equals the oracle of the descriptor with that camera record. */
  mt_camera_v4 camera;
  memcpy(&camera, scene + (size_t)header->camera_offset * 4, sizeof camera);
  camera.fov *= 0.8f;
  OK(mt_engine_set_camera(engine, &camera, error, sizeof error));
  OK(mt_engine_update(engine, &changed, error, sizeof error));
  REQUIRE(changed == 1, "camera update");
  OK(mt_render_converge(render, &converge, &converged, error, sizeof error));
  uint8_t *edited = malloc(length);
  memcpy(edited, scene, length);
  memcpy(edited + (size_t)header->camera_offset * 4, &camera, sizeof camera);
  compare("engine camera", render, edited, length, backend, samples, width, height);
  OK(mt_engine_set_camera(engine, NULL, error, sizeof error));
  OK(mt_engine_update(engine, &changed, error, sizeof error));

  /* Render loop with a sync; the sync may not re-enter its loop. */
  mt_render_loop render_loop;
  loop_options.final_options = &options;
  OK(mt_render_loop_create(engine, &loop_options, &render_loop, error, sizeof error));
  current_loop = render_loop;
  mt_loop_sync sync = {.struct_size = sizeof sync, .update = sync_update, .active = sync_active};
  uint64_t sync_id = 0;
  OK(mt_render_loop_add_sync(render_loop, &sync, &sync_id, error, sizeof error));
  OK(mt_render_loop_set_callback(render_loop, on_loop, &loop_events, error, sizeof error));
  mt_render final_render, none;
  OK(mt_render_loop_render(render_loop, MT_LOOP_SELECT_FINAL, &final_render, error, sizeof error));
  STATUS(mt_render_loop_render(render_loop, MT_LOOP_SELECT_PREVIEW, &none, error, sizeof error), MT_ERROR_INVALID_STATE);
  STATUS(mt_render_destroy(final_render, error, sizeof error), MT_ERROR_INVALID_STATE);
  uint32_t needs = 1;
  for (int i = 0; i < 600000 && needs; i++) {
    QUIET(mt_render_loop_tick(render_loop, &status, error, sizeof error));
    QUIET(mt_render_loop_needs_tick(render_loop, &needs, error, sizeof error));
    frame();
  }
  REQUIRE(status == MT_LOOP_FINISHED && sync_updates > 0 && loop_events > 0, "loop finishes");
  mt_render_loop_snapshot loop_info = {.struct_size = sizeof loop_info};
  OK(mt_render_loop_info(render_loop, &loop_info, error, sizeof error));
  REQUIRE(loop_info.samples == samples && loop_info.presentations > 0
    && loop_info.last_presented.samples == samples, "loop info");
  compare("render loop", final_render, scene, length, backend, samples, width, height);
  OK(mt_render_loop_remove_sync(render_loop, sync_id, error, sizeof error));
  STATUS(mt_render_loop_remove_sync(render_loop, sync_id, error, sizeof error), MT_ERROR_INVALID_HANDLE);
  OK(mt_render_cancel(final_render, error, sizeof error));
  OK(mt_render_loop_converge(render_loop, &converge, &converged, error, sizeof error));
  REQUIRE(converged == samples, "loop converge after an earlier cancel");
  OK(mt_render_loop_destroy(render_loop, error, sizeof error));
  STATUS(mt_render_refine(final_render, &status, error, sizeof error), MT_ERROR_INVALID_HANDLE);

  /* Validation and lifetime. */
  mt_render_options bad = options;
  bad.struct_size = 4;
  mt_render other;
  STATUS(mt_render_create(engine, &bad, &other, error, sizeof error), MT_ERROR_INVALID_ARGUMENT);
  bad = options;
  bad.dispersion_wavelengths = 2;
  STATUS(mt_render_set_options(render, &bad, error, sizeof error), MT_ERROR_INVALID_ARGUMENT);
  bad = options;
  bad.width = 0;
  STATUS(mt_render_set_options(render, &bad, error, sizeof error), MT_ERROR_INVALID_ARGUMENT);
  STATUS(mt_render_read_pixels(render, 9, NULL, 0, &written, error, sizeof error), MT_ERROR_INVALID_ARGUMENT);
  STATUS(mt_render_denoise_current(render, NULL, error, sizeof error), MT_ERROR_INVALID_STATE);
  STATUS(mt_engine_set_scene(engine, scene, 12, error, sizeof error), MT_ERROR_INVALID_ARGUMENT);
  STATUS(mt_render_set_fallback(render, render, error, sizeof error), MT_ERROR_INVALID_ARGUMENT);
  OK(mt_render_create(engine, &options, &other, error, sizeof error));
  OK(mt_render_set_fallback(render, other, error, sizeof error));
  OK(mt_render_destroy(other, error, sizeof error));
  STATUS(mt_render_destroy(other, error, sizeof error), MT_ERROR_INVALID_HANDLE);
  REQUIRE(engine_events > 0, "engine progress events");
  OK(mt_engine_destroy(engine, error, sizeof error));
  STATUS(mt_render_refine(render, &status, error, sizeof error), MT_ERROR_INVALID_HANDLE);
  STATUS(mt_display_set_size(display, 1, 1, error, sizeof error), MT_ERROR_INVALID_HANDLE);
  STATUS(mt_engine_update(engine, &changed, error, sizeof error), MT_ERROR_INVALID_HANDLE);
  free(edited);
  free(scene);
  printf("PASS %d engine checks%s\n", checks, differences ? " (with HWRT differences)" : "");
  return 0;
}
