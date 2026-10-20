#ifndef MUTRACER_LOG_H
#define MUTRACER_LOG_H
#include <stddef.h>
#include <stdint.h>
#include "mutracer-status.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Default: silent. Messages are borrowed UTF-8 bytes, without a trailing NUL.
 * Callbacks run serially on the emitting thread, including library workers.
 * Keep them short; do not unwind or reenter MuTracer. Replacement/unregistration waits
 * for the previous callback to return; its code and user payload must remain
 * valid until then. NULL unregisters. Returns MT_OK, or MT_ERROR_INVALID_STATE
 * if called by a callback.
 */
typedef void (*mt_log_callback)(void *user, const uint8_t *message, size_t length);
int32_t mt_set_log_callback(mt_log_callback callback, void *user);
#ifdef __cplusplus
}
#endif
#endif
