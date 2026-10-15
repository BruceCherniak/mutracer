#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern void mutracer_oidn_init(void);
extern void mutracer_oidn_reset(void);
extern void mutracer_oidn_collect(void);
extern void mutracer_oidn_set_panic_sink(void (*)(void *, const uint8_t *, size_t), void *);
extern void mutracer_oidn_model_url(const uint8_t *, size_t, const uint8_t *, size_t, uint8_t,
                                  const uint8_t **, size_t *);
extern void mutracer_oidn_auxiliary_urls(const uint8_t *, size_t, uint8_t, const uint8_t **, size_t *);
extern void mutracer_oidn_defaults(const uint8_t **, size_t *);

static void panic(void *ctx, const uint8_t *message, size_t size) {
  (void)ctx;
  fwrite(message, 1, size, stderr);
  exit(70);
}

int main(int argc, char **argv) {
  if (argc != 2 && argc != 5) return 2;
  mutracer_oidn_set_panic_sink(panic, NULL);
  mutracer_oidn_init();
  uint8_t *first = NULL;
  size_t first_size = 0;
  for (int i = 0; i < 100; ++i) {
    const uint8_t *result = NULL;
    size_t size = 0;
    if (strcmp(argv[1], "defaults") == 0 && argc == 2) {
      mutracer_oidn_defaults(&result, &size);
    } else if (strcmp(argv[1], "model") == 0 && argc == 5) {
      mutracer_oidn_model_url((const uint8_t *)argv[2], strlen(argv[2]),
        (const uint8_t *)argv[3], strlen(argv[3]), (uint8_t)atoi(argv[4]), &result, &size);
    } else if (strcmp(argv[1], "auxiliary") == 0 && argc == 5) {
      mutracer_oidn_auxiliary_urls((const uint8_t *)argv[3], strlen(argv[3]),
        (uint8_t)atoi(argv[4]), &result, &size);
    } else return 2;
    // Returned data belongs to the result arena. Copy before reset or another call.
    if (i == 0) {
      first = malloc(size ? size : 1);
      if (!first) return 3;
      memcpy(first, result, size);
      first_size = size;
    } else if (size != first_size || memcmp(first, result, size)) return 4;
    mutracer_oidn_reset();
    mutracer_oidn_collect();
  }
  const int ok = fwrite(first, 1, first_size, stdout) == first_size;
  free(first);
  return ok ? 0 : 5;
}
