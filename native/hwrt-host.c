#include "mutracer-probe.h"
#include <stdio.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  mt_probe_options options = { .struct_size = sizeof(options), .flags = 4,
    .samples = 256, .seed = 12345, .bounces = 6 };
  char error[4096];
  if (mt_probe_render_with_options(argv[1], argv[2], &options, error, sizeof(error))) {
    fprintf(stderr, "%s\n", error); return 1;
  }
  return 0;
}
