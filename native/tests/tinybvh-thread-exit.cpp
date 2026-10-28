// Compile with ThreadSanitizer to cover worker-pool lifetime and host-thread exit.
#include <cstdint>
#include <exception>
#include <thread>
#include <vector>

extern "C" void* mt_native_tiny_aabbs(const float*, uint32_t);
extern "C" void* mt_native_tiny_blas(
  const float*, uint32_t, const float*, const uint32_t*, uint32_t, float, const float*);
extern "C" void tinybvh_result_destroy(void*);
#if defined(_WIN32)
extern "C" void mt_test_shutdown_pool();
#else
namespace tinybvh { void tinybvh_shutdown_builtin_pool(); }
#endif

int main() {
  for (int round = 0; round < 3; ++round) {
    std::thread caller([] {
      std::vector<float> boxes(65536 * 6);
      std::vector<float> positions(65536 * 9);
      std::vector<uint32_t> indices(65536 * 3);
      for (int i = 0; i < 65536; ++i) {
        const float x = i % 256, y = i / 256;
        const float bounds[6] = {x, y, 0, x + .9f, y + .9f, 1};
        for (int j = 0; j < 6; ++j) boxes[i * 6 + j] = bounds[j];
        for (int corner = 0; corner < 3; ++corner) {
          const int vertex = i * 3 + corner;
          positions[vertex * 3] = x + (corner == 1 ? .9f : 0);
          positions[vertex * 3 + 1] = y + (corner == 2 ? .9f : 0);
          positions[vertex * 3 + 2] = (i % 7) * .125f;
          indices[vertex] = vertex;
        }
      }
      auto result = mt_native_tiny_aabbs(boxes.data(), 65536);
      if (!result) std::terminate();
      tinybvh_result_destroy(result);
      // Cover the NEON/Bonsai worker path as well as the AABB reference builder.
      result = mt_native_tiny_blas(positions.data(), 65536 * 3, nullptr,
        indices.data(), 65536 * 3, 0, nullptr);
      if (!result) std::terminate();
      tinybvh_result_destroy(result);
      // The process-wide pool survives this host thread in TinyBVH 1.9.
    });
    caller.join();
    // Explicit shutdown must join workers safely, and the next build must
    // recreate the pool. Leave the last pool for upstream's process-exit hook.
    if (round < 2) {
#if defined(_WIN32)
      mt_test_shutdown_pool();
#else
      tinybvh::tinybvh_shutdown_builtin_pool();
#endif
    }
  }
}
