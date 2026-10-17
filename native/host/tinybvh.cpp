// Reuse the browser adapter and official pinned TinyBVH header. No builder port.
// See native/THIRD_PARTY_NOTICES.md and native/LICENSES/TinyBVH-MIT.txt.
#define MUTRACER_TINYBVH_NATIVE
#include "../../src/tinybvh/tinybvh_wrapper.cpp"

extern "C" BuildResult* mt_native_tiny_blas(
  const float* positions, uint32_t vertexCount, const float* normals,
  const uint32_t* indices, uint32_t indexCount, float scale, const float* ranges
) noexcept {
  // Spatial splits stay disabled, matching the browser default. SIMD and
  // threading change execution, not the requested object-split algorithm.
  try { return tinybvh_build(positions, vertexCount, 3, normals, 3, indices, indexCount, scale, ranges, BVH2_LAYOUT, 0); }
  catch (...) { return nullptr; }
}

extern "C" BuildResult* mt_native_tiny_aabbs(const float* boxes, uint32_t count) noexcept {
  try {
    auto result = std::make_unique<BuildResult>();
    if (!count) return result.release();
    std::vector<tinybvh::bvhvec4> bounds(count*2);
    std::vector<uint32_t> indices(count*3), ids(count);
    for (uint32_t i=0;i<count;++i) {
      bounds[i*2]=tinybvh::bvhvec4(boxes[i*6],boxes[i*6+1],boxes[i*6+2],0);
      bounds[i*2+1]=tinybvh::bvhvec4(boxes[i*6+3],boxes[i*6+4],boxes[i*6+5],0);
      indices[i*3]=indices[i*3+1]=indices[i*3+2]=i; ids[i]=i;
    }
    tinybvh::BVH bvh; bvh.BuildAABB(bounds.data(),count);
    serializeBvh(bvh,indices,ids,nullptr,BVH2_LAYOUT,true,*result);
    return result.release();
  } catch (...) { return nullptr; }
}

// Share upstream's one process-wide pool between independent BLASes and its
// subtree jobs. Each BLAS owns a separate spawn/barrier group, including when a
// waiting worker steals another BLAS; no second all-core pool is introduced.
extern "C" void mt_native_tiny_parallel_for(uint32_t count,
  void (*fn)(uint32_t, void*), void* payload, uint32_t captureIds) noexcept {
  struct Work {void (*fn)(uint32_t, void*); void* payload; bool capture;};
  Work work{fn, payload, captureIds != 0};
  auto run = [](uint32_t i, void* data) {
    auto& work = *static_cast<Work*>(data);
    tinybvh::JobSystem::JobGroup group;
    auto* previousGroup = tinybvh::tinybvh_tl_group;
    const bool previousCapture = nativeCaptureTriangleIds;
    tinybvh::tinybvh_tl_group = &group;
    nativeCaptureTriangleIds = work.capture;
    work.fn(i, work.payload);
    tinybvh::tinybvh_builtin_barrier(nullptr);
    nativeCaptureTriangleIds = previousCapture;
    tinybvh::tinybvh_tl_group = previousGroup;
  };
  if (count == 1) run(0, &work);
  else tinybvh::tinybvh_builtin_parallel_for(count, run, &work, nullptr);
}
