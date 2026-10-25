/* C host counters with stable MSVC support (C11 atomics are experimental there). */
#ifndef MT_HOST_ATOMIC_H
#define MT_HOST_ATOMIC_H
#if defined(_WIN32)
#include <windows.h>
typedef volatile LONG mt_host_atomic;
static void mt_host_atomic_increment(mt_host_atomic *value) { InterlockedIncrement(value); }
static unsigned mt_host_atomic_load(mt_host_atomic *value) { return (unsigned)InterlockedCompareExchange(value,0,0); }
static void mt_host_atomic_store(mt_host_atomic *value,unsigned next) { InterlockedExchange(value,(LONG)next); }
#else
#include <stdatomic.h>
typedef atomic_uint mt_host_atomic;
static void mt_host_atomic_increment(mt_host_atomic *value) { atomic_fetch_add(value,1); }
static unsigned mt_host_atomic_load(mt_host_atomic *value) { return atomic_load(value); }
static void mt_host_atomic_store(mt_host_atomic *value,unsigned next) { atomic_store(value,next); }
#endif
#endif
