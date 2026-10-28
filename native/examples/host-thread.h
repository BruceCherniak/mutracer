/* Minimal joined-thread helper for the C consumers; no pthread dependency on MSVC. */
#ifndef MT_HOST_THREAD_H
#define MT_HOST_THREAD_H
#if defined(_WIN32)
#include <windows.h>
#include <process.h>
#include <stdint.h>
typedef struct mt_host_thread {
  HANDLE handle;
  void *(*call)(void *);
  void *argument;
  void *result;
} mt_host_thread;
static unsigned __stdcall mt_host_thread_entry(void *opaque) {
  mt_host_thread *thread = opaque;
  thread->result = thread->call(thread->argument);
  return 0;
}
static int mt_host_thread_start(mt_host_thread *thread, void *(*call)(void *), void *argument) {
  thread->call = call; thread->argument = argument; thread->result = NULL;
  thread->handle = (HANDLE)_beginthreadex(NULL, 0, mt_host_thread_entry, thread, 0, NULL);
  return thread->handle ? 0 : -1;
}
static int mt_host_thread_join(mt_host_thread *thread, void **result) {
  if (WaitForSingleObject(thread->handle, INFINITE) != WAIT_OBJECT_0) return -1;
  if (result) *result = thread->result;
  return CloseHandle(thread->handle) ? 0 : -1;
}
#else
#include <pthread.h>
typedef pthread_t mt_host_thread;
static int mt_host_thread_start(mt_host_thread *thread, void *(*call)(void *), void *argument) {
  return pthread_create(thread, NULL, call, argument);
}
static int mt_host_thread_join(mt_host_thread *thread, void **result) {
  return pthread_join(*thread, result);
}
#endif
#endif
