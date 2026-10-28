/* One-millisecond polling yield for the C validation hosts. */
#ifndef MT_HOST_TIME_H
#define MT_HOST_TIME_H
#if defined(_WIN32)
#include <windows.h>
static void mt_host_pause(void) { Sleep(1); }
#else
#include <time.h>
static void mt_host_pause(void) { const struct timespec delay={0,1000000};nanosleep(&delay,NULL); }
#endif
#endif
