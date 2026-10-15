#include "mutracer-probe.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int output_hash(const char *directory, uint64_t *hash) {
  char path[4096];
  const int n = snprintf(path, sizeof(path), "%s/render.rgba32f", directory);
  if (n < 0 || (size_t)n >= sizeof(path)) return 1;
  FILE *file = fopen(path, "rb");
  if (!file) return 1;
  *hash = UINT64_C(14695981039346656037);
  int byte;
  while ((byte = fgetc(file)) != EOF) {
    *hash = (*hash ^ (uint8_t)byte) * UINT64_C(1099511628211);
  }
  const int failed = ferror(file);
  fclose(file);
  return failed;
}

int main(int argc, char **argv) {
  if (argc < 3 || argc > 5) {
    fputs("Usage: render-host SCENE OUTPUT [SAMPLES] [repeat]\n", stderr);
    return 2;
  }
  char error[4096] = {0};
  /* Validate a recoverable input error before rendering in the same process. */
  if (mt_probe_render(NULL, argv[2], 1, error, sizeof(error)) != 1 ||
      strstr(error, "Null input path") == NULL) return 3;
  const uint32_t samples = argc >= 4 ? (uint32_t)strtoul(argv[3], NULL, 10) : 0;
  const int repeats = argc == 5 && strcmp(argv[4], "repeat") == 0 ? 2 : 1;
  uint64_t previous_hash = 0;
  for (int i = 0; i < repeats; ++i) {
    if (mt_probe_render(argv[1], argv[2], samples, error, sizeof(error))) {
      fprintf(stderr, "%s\n", error);
      return 1;
    }
    uint64_t hash;
    if (output_hash(argv[2], &hash)) return 4;
    if (i > 0 && hash != previous_hash) {
      fputs("Repeated render HDR differs\n", stderr);
      return 5;
    }
    previous_hash = hash;
  }
  fprintf(stderr, "C host: %d render(s), matching HDR hash %016llx\n", repeats,
          (unsigned long long)previous_hash);
  return 0;
}
