// Compile with ThreadSanitizer to cover upstream's worker-pool TLS teardown.
#include <cstdint>
#include <exception>
#include <thread>
#include <vector>

extern "C" void* mt_native_tiny_aabbs(const float*, uint32_t);
extern "C" void tinybvh_result_destroy(void*);

int main() {
  for (int round = 0; round < 3; ++round) {
    std::thread caller([] {
      std::vector<float> boxes(65536 * 6);
      for (int i = 0; i < 65536; ++i) {
        const float x = i % 256, y = i / 256;
        const float bounds[6] = {x, y, 0, x + .9f, y + .9f, 1};
        for (int j = 0; j < 6; ++j) boxes[i * 6 + j] = bounds[j];
      }
      auto result = mt_native_tiny_aabbs(boxes.data(), 65536);
      if (!result) std::terminate();
      tinybvh_result_destroy(result);
      // Thread exit must join the worker pool without races or a hang.
    });
    caller.join();
  }
}
