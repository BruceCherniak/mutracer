// Reuse the browser adapter and official pinned TinyBVH header. No builder port.
// See native/THIRD_PARTY_NOTICES.md and native/LICENSES/TinyBVH-MIT.txt.
#include "../../src/tinybvh/tinybvh_wrapper.cpp"

extern "C" BuildResult* mt_native_tiny_blas(
  const float* positions, uint32_t vertexCount, const float* normals,
  const uint32_t* indices, uint32_t indexCount, float scale, const float* ranges
) noexcept {
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
