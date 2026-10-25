/* MuTracer's own UCRT/Win32 bridge for scriptc 0.4.4 binary imports.
 * This implements the imported ABI, without linking a second MinGW CRT.
 * The runtime's dirent name starts at byte 8; confirmed against its COFF code.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <io.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <emmintrin.h>
#pragma comment(lib, "legacy_stdio_definitions.lib")

int mt_vsnprintf(char *buffer, size_t size, const char *format, va_list args) {
  return vsnprintf(buffer, size, format, args);
}
int mt_snprintf(char *buffer, size_t size, const char *format, ...) {
  va_list args; va_start(args, format);
  int result = vsnprintf(buffer, size, format, args); va_end(args); return result;
}
int mt_fprintf(FILE *stream, const char *format, ...) {
  va_list args; va_start(args, format);
  int result = vfprintf(stream, format, args); va_end(args); return result;
}
int mt_printf(const char *format, ...) {
  va_list args; va_start(args, format);
  int result = vprintf(format, args); va_end(args); return result;
}
double mt_strtod(const char *text, char **end) { return strtod(text, end); }
int mt_fstat(int file, struct _stat64i32 *output) { return _fstat64i32(file, output); }
uint64_t *mt_stdio_printf_options(void) { static uint64_t options; return &options; }
static wchar_t *wide_path(const char *path) {
  if (!path) { errno = EINVAL; return NULL; }
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  if (!count) { errno = EINVAL; return NULL; }
  wchar_t *wide = malloc((size_t)count * sizeof(wchar_t));
  if (!wide) { errno = ENOMEM; return NULL; }
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, count);
  return wide;
}
int mt_stat(const char *path, struct _stat64i32 *output) {
  wchar_t *wide = wide_path(path);
  if (!wide) return -1;
  int result = _wstat64i32(wide, output); free(wide); return result;
}
int mt_trunc(const char *path, int64_t length) {
  if (length < 0) { errno = EINVAL; return -1; }
  wchar_t *wide = wide_path(path);
  if (!wide) return -1;
  int file = _wopen(wide, _O_WRONLY | _O_BINARY); free(wide);
  if (file < 0) return -1;
  errno_t result = _chsize_s(file, length);
  int saved = result ? (int)result : errno;
  _close(file); errno = saved; return result ? -1 : 0;
}

struct mt_dirent {
  int32_t inode;
  uint16_t record_length, name_length;
  char name[260];
};
struct mt_directory {
  HANDLE handle;
  WIN32_FIND_DATAW current;
  int first;
  struct mt_dirent entry;
};
static void directory_error(DWORD error) {
  errno = error == ERROR_ACCESS_DENIED ? EACCES : error == ERROR_NOT_ENOUGH_MEMORY ? ENOMEM : ENOENT;
}
void *mt_odir(const char *path) {
  if (!path || !*path) { errno = ENOENT; return NULL; }
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  if (!count) { errno = EINVAL; return NULL; }
  wchar_t *pattern = malloc(((size_t)count + 2) * sizeof(wchar_t));
  struct mt_directory *dir = calloc(1, sizeof(*dir));
  if (!pattern || !dir) { free(pattern); free(dir); errno = ENOMEM; return NULL; }
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, pattern, count);
  DWORD attributes = GetFileAttributesW(pattern);
  if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY)) {
    free(pattern); free(dir); errno = attributes == INVALID_FILE_ATTRIBUTES ? ENOENT : ENOTDIR; return NULL;
  }
  size_t end = (size_t)count - 1;
  if (end && pattern[end-1] != L'\\' && pattern[end-1] != L'/') pattern[end++] = L'\\';
  pattern[end++] = L'*'; pattern[end] = 0;
  dir->handle = FindFirstFileW(pattern, &dir->current); free(pattern);
  if (dir->handle == INVALID_HANDLE_VALUE) { directory_error(GetLastError()); free(dir); return NULL; }
  dir->first = 1; return dir;
}
void *mt_rdir(void *opaque) {
  struct mt_directory *dir = opaque;
  if (!dir) { errno = EBADF; return NULL; }
  if (!dir->first && !FindNextFileW(dir->handle, &dir->current)) {
    DWORD error = GetLastError();
    if (error != ERROR_NO_MORE_FILES) directory_error(error);
    return NULL;
  }
  dir->first = 0;
  int count = WideCharToMultiByte(CP_UTF8, 0, dir->current.cFileName, -1,
    dir->entry.name, (int)sizeof(dir->entry.name), NULL, NULL);
  if (!count) { errno = ENAMETOOLONG; return NULL; }
  dir->entry.inode = 0;
  dir->entry.record_length = (uint16_t)sizeof(dir->entry);
  dir->entry.name_length = (uint16_t)(count - 1);
  return &dir->entry;
}
int mt_cdir(void *opaque) {
  struct mt_directory *dir = opaque;
  if (!dir) { errno = EBADF; return -1; }
  BOOL result = FindClose(dir->handle); free(dir);
  if (!result) { errno = EBADF; return -1; } return 0;
}

/* LLVM's Windows-GNU unsigned-128 division passes two pointers and returns the
 * quotient in XMM0. Use ordinary 64-bit arithmetic to avoid compiler builtins.
 */
__m128i mt_udiv(const uint64_t *numerator, const uint64_t *denominator) {
  uint64_t high = numerator[1], low = numerator[0];
  uint64_t dh = denominator[1], dl = denominator[0];
  uint64_t rh = 0, rl = 0, qh = 0, ql = 0;
  if (!dh && !dl) abort();
  for (int bit = 127; bit >= 0; --bit) {
    uint64_t carry = rh >> 63;
    rh = (rh << 1) | (rl >> 63);
    rl = (rl << 1) | ((bit >= 64 ? high >> (bit - 64) : low >> bit) & 1);
    if (carry || rh > dh || (rh == dh && rl >= dl)) {
      uint64_t borrow = rl < dl;
      rl -= dl; rh = rh - dh - borrow;
      if (bit >= 64) qh |= (uint64_t)1 << (bit - 64); else ql |= (uint64_t)1 << bit;
    }
  }
  return _mm_set_epi64x((int64_t)qh, (int64_t)ql);
}
