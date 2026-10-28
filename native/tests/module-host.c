#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern void mt_module_init(void);
extern void mt_module_reset(void);
extern void mt_module_collect(void);
extern void mt_module_run(const uint8_t *, size_t, const uint8_t **, size_t *);
extern void mt_module_sink(void (*)(void *, const uint8_t *, size_t), void *);

static void panic_message(void *context, const uint8_t *message, size_t size) {
  (void)context;
  fwrite(message, 1, size, stderr);
  fputc('\n', stderr);
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  FILE *input = fopen(argv[1], "rb");
  if (!input || fseek(input, 0, SEEK_END)) return 3;
  long length = ftell(input);
  if (length < 0 || fseek(input, 0, SEEK_SET)) return 3;
  uint8_t *bytes = malloc(length ? (size_t)length : 1);
  if (!bytes || fread(bytes, 1, (size_t)length, input) != (size_t)length) return 3;
  fclose(input);
  mt_module_sink(panic_message, NULL);
  mt_module_init();
  uint8_t *saved = NULL; size_t saved_size = 0;
  for (int i = 0; i < 2; i++) {
    const uint8_t *result = NULL; size_t size = 0;
    mt_module_run(bytes, (size_t)length, &result, &size);
    if (!result) return 4;
    if (!i) {
      saved = malloc(size ? size : 1); if (!saved) return 4;
      memcpy(saved, result, size); saved_size = size;
    } else if (size != saved_size || memcmp(saved, result, size)) return 5;
    mt_module_reset();
  }
  mt_module_collect();
  FILE *output = fopen(argv[2], "wb");
  if (!output || fwrite(saved, 1, saved_size, output) != saved_size) return 6;
  fclose(output); free(saved); free(bytes);
  return 0;
}
