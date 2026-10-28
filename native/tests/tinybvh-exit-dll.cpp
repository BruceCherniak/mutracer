// Dedicated DLL consumer for testing process detach with the MSVC CRT.
#include "../host/tinybvh.cpp"
#pragma comment(linker, "/export:mt_native_tiny_aabbs")
#pragma comment(linker, "/export:mt_native_tiny_blas")
#pragma comment(linker, "/export:tinybvh_result_destroy")
extern "C" __declspec(dllexport) void mt_test_shutdown_pool() {
  tinybvh::tinybvh_shutdown_builtin_pool();
}
