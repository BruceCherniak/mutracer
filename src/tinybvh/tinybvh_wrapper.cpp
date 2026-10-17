#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <vector>

#define NO_CUSTOM_GEOMETRY
#define NO_DOUBLE_PRECISION_SUPPORT
#define NO_VOXEL_SUPPORT
#ifndef MUTRACER_TINYBVH_NATIVE
// The browser keeps its scalar, single-threaded Wasm module. Native builds use
// upstream SIMD and subtree workers without changing the browser build flags.
#define NO_THREADED_BUILDS
#define TINYBVH_NO_SIMD
#endif
#define TINYBVH_IMPLEMENTATION
#include "tiny_bvh.h"

namespace {

#ifdef MUTRACER_TINYBVH_NATIVE
// Set only on the owner/worker executing serialization, with scoped restoration.
static thread_local bool nativeCaptureTriangleIds = true;
#endif

struct BuildResult {
  uint32_t* data = nullptr;
  uint32_t byteLength = 0;
  uint32_t maxDepth = 0;
  uint32_t layout = 0;
#ifdef MUTRACER_TINYBVH_NATIVE
  std::vector<uint32_t> triangleIds;
#endif
};

constexpr uint32_t BVH2_LAYOUT = 0;
constexpr uint32_t BVH4_LAYOUT = 1;
constexpr uint32_t BVH_GPU_LAYOUT = 2;
constexpr uint32_t CWBVH_LAYOUT = 3;
constexpr uint32_t BVH4_LEAF_BIT = 0x80000000u;
constexpr uint32_t BVH4_LEAF_COUNT_SHIFT = 23;
constexpr uint32_t BVH4_LEAF_OFFSET_MASK = 0x007fffffu;

uint32_t floatBits(float value) {
  uint32_t result;
  std::memcpy(&result, &value, sizeof(result));
  return result;
}

uint32_t packHeight(float minHeight, float maxHeight) {
  const int minValue = std::clamp(static_cast<int>(std::floor(minHeight * 255.0f)), 0, 255);
  const int maxValue = std::abs(maxHeight - minHeight) < 1e-6f
    ? minValue
    : std::clamp(static_cast<int>(std::ceil(maxHeight * 255.0f)), 0, 255);
  return static_cast<uint32_t>((minValue << 8) | maxValue);
}

bool finiteVertex(const float* positions, uint32_t stride, uint32_t index) {
  const float* vertex = positions + index * stride;
  return std::isfinite(vertex[0]) && std::isfinite(vertex[1]) && std::isfinite(vertex[2]);
}

tinybvh::bvhvec3 vertexAt(const float* values, uint32_t stride, uint32_t index) {
  const float* value = values + index * stride;
  return tinybvh::bvhvec3(value[0], value[1], value[2]);
}

void normalize(tinybvh::bvhvec3& value) {
  const float length = std::sqrt(value.x * value.x + value.y * value.y + value.z * value.z);
  if (length > 0.0f) {
    value.x /= length;
    value.y /= length;
    value.z /= length;
  }
}

void growBounds(tinybvh::bvhvec3& minimum, tinybvh::bvhvec3& maximum, const tinybvh::bvhvec3& value) {
  minimum.x = std::min(minimum.x, value.x);
  minimum.y = std::min(minimum.y, value.y);
  minimum.z = std::min(minimum.z, value.z);
  maximum.x = std::max(maximum.x, value.x);
  maximum.y = std::max(maximum.y, value.y);
  maximum.z = std::max(maximum.z, value.z);
}

void flattenNode(
  const tinybvh::BVH& bvh,
  uint32_t nodeIndex,
  uint32_t depth,
  const std::vector<uint32_t>& indices,
  const std::vector<uint32_t>& triangleMap,
  const float* displacement,
  std::vector<uint32_t>& output,
  uint32_t& maxDepth,
  std::vector<uint32_t>* triangleIds = nullptr
) {
  const tinybvh::BVH::BVHNode& node = bvh.bvhNode[nodeIndex];
  maxDepth = std::max(maxDepth, depth);
  const size_t start = output.size();
  output.resize(start + 8, 0);
  output[start] = floatBits(node.aabbMin.x);
  output[start + 1] = floatBits(node.aabbMin.y);
  output[start + 2] = floatBits(node.aabbMin.z);
  output[start + 4] = floatBits(node.aabbMax.x);
  output[start + 5] = floatBits(node.aabbMax.y);
  output[start + 6] = floatBits(node.aabbMax.z);

  if (node.isLeaf()) {
    output[start + 3] = static_cast<uint32_t>(-static_cast<int32_t>(node.triCount));
    for (uint32_t i = 0; i < node.triCount; ++i) {
      const uint32_t compactTriangle = bvh.primIdx[node.leftFirst + i];
      const uint32_t triangle = triangleMap[compactTriangle];
      if (triangleIds) {triangleIds->push_back(static_cast<uint32_t>(output.size()/4)); triangleIds->push_back(triangle);}
      output.push_back(indices[triangle * 3]);
      output.push_back(indices[triangle * 3 + 1]);
      output.push_back(indices[triangle * 3 + 2]);
      output.push_back(displacement ? packHeight(displacement[triangle * 2], displacement[triangle * 2 + 1]) : 0);
    }
    return;
  }

  flattenNode(bvh, node.leftFirst, depth + 1, indices, triangleMap, displacement, output, maxDepth, triangleIds);
  output[start + 3] = static_cast<uint32_t>(output.size() / 4);
  flattenNode(bvh, node.leftFirst + 1, depth + 1, indices, triangleMap, displacement, output, maxDepth, triangleIds);
}

void collectWideNodes(
  const tinybvh::MBVH<4>& bvh,
  uint32_t nodeIndex,
  std::vector<uint32_t>& addresses,
  std::vector<uint32_t>& nodes
) {
  const auto& node = bvh.mbvhNode[nodeIndex];
  if (node.isLeaf() || addresses[nodeIndex] != std::numeric_limits<uint32_t>::max()) return;
  addresses[nodeIndex] = static_cast<uint32_t>(nodes.size() * 4);
  nodes.push_back(nodeIndex);
  for (uint32_t i = 0; i < node.childCount; ++i) {
    collectWideNodes(bvh, node.child[i], addresses, nodes);
  }
}

template <int Width>
uint32_t wideStackRequirement(const tinybvh::MBVH<Width>& bvh, uint32_t nodeIndex) {
  const auto& node = bvh.mbvhNode[nodeIndex];
  if (node.isLeaf()) return 1;
  uint32_t childRequirement = 1;
  for (uint32_t i = 0; i < node.childCount; ++i) {
    childRequirement = std::max(childRequirement, wideStackRequirement(bvh, node.child[i]));
  }
  return std::max(node.childCount, node.childCount - 1 + childRequirement);
}

void appendPrimitive(
  uint32_t compactTriangle,
  const std::vector<uint32_t>& indices,
  const std::vector<uint32_t>& triangleMap,
  const float* displacement,
  std::vector<uint32_t>& output
) {
  const uint32_t triangle = triangleMap[compactTriangle];
  output.push_back(indices[triangle * 3]);
  output.push_back(indices[triangle * 3 + 1]);
  output.push_back(indices[triangle * 3 + 2]);
  output.push_back(
    displacement
      ? packHeight(displacement[triangle * 2], displacement[triangle * 2 + 1])
      : 0
  );
}

uint32_t binaryDepth(const tinybvh::BVH& bvh, uint32_t nodeIndex) {
  const auto& node = bvh.bvhNode[nodeIndex];
  if (node.isLeaf()) return 1;
  return 1 + std::max(
    binaryDepth(bvh, node.leftFirst),
    binaryDepth(bvh, node.leftFirst + 1)
  );
}

enum class CwbvhDecisionKind : uint8_t {
  Leaf,
  Internal,
  Distribute
};

struct CwbvhDecision {
  float cost = std::numeric_limits<float>::infinity();
  CwbvhDecisionKind kind = CwbvhDecisionKind::Distribute;
  uint8_t distributeLeft = 0xff;
  uint8_t distributeRight = 0xff;
};

struct CwbvhSubtreeInfo {
  uint32_t primitiveCount = 0;
  uint32_t firstPrimitive = 0;
  bool contiguous = false;
};

constexpr float CWBVH_PRIMITIVE_COST = 0.3f;

// Equations 4-8 of Ylitie, Karras, and Laine (HPG 2017). This was
// cross-checked against the independently maintained MIT implementations in
// obvhs and Jan van Bergen's GPU-Raytracer.
CwbvhSubtreeInfo calculateCwbvhDecisions(
  const tinybvh::BVH& bvh,
  uint32_t nodeIndex,
  std::vector<CwbvhDecision>& decisions,
  std::vector<CwbvhSubtreeInfo>& subtrees
) {
  const auto& node = bvh.bvhNode[nodeIndex];
  const float area = node.SurfaceArea();
  const size_t decisionBase = static_cast<size_t>(nodeIndex) * 7;
  if (node.isLeaf()) {
    CwbvhSubtreeInfo info{node.triCount, node.leftFirst, true};
    subtrees[nodeIndex] = info;
    const float leafCost = area * node.triCount * CWBVH_PRIMITIVE_COST;
    for (uint32_t i = 0; i < 7; ++i) {
      decisions[decisionBase + i] = {
        leafCost,
        CwbvhDecisionKind::Leaf,
        0xff,
        0xff
      };
    }
    return info;
  }

  const uint32_t leftIndex = node.leftFirst;
  const uint32_t rightIndex = node.leftFirst + 1;
  const CwbvhSubtreeInfo left = calculateCwbvhDecisions(
    bvh, leftIndex, decisions, subtrees
  );
  const CwbvhSubtreeInfo right = calculateCwbvhDecisions(
    bvh, rightIndex, decisions, subtrees
  );
  const uint32_t firstPrimitive = std::min(left.firstPrimitive, right.firstPrimitive);
  const uint32_t lastPrimitive = std::max(
    left.firstPrimitive + left.primitiveCount,
    right.firstPrimitive + right.primitiveCount
  );
  CwbvhSubtreeInfo info{
    left.primitiveCount + right.primitiveCount,
    firstPrimitive,
    left.contiguous && right.contiguous &&
      lastPrimitive - firstPrimitive == left.primitiveCount + right.primitiveCount
  };
  subtrees[nodeIndex] = info;

  const size_t leftBase = static_cast<size_t>(leftIndex) * 7;
  const size_t rightBase = static_cast<size_t>(rightIndex) * 7;
  CwbvhDecision rootDecision;
  float distributeCost = std::numeric_limits<float>::infinity();
  for (uint32_t k = 0; k < 7; ++k) {
    const float cost = decisions[leftBase + k].cost + decisions[rightBase + 6 - k].cost;
    if (cost < distributeCost) {
      distributeCost = cost;
      rootDecision.distributeLeft = static_cast<uint8_t>(k);
      rootDecision.distributeRight = static_cast<uint8_t>(6 - k);
    }
  }
  const float internalCost = distributeCost + area;
  const float leafCost = info.contiguous && info.primitiveCount <= 3
    ? area * info.primitiveCount * CWBVH_PRIMITIVE_COST
    : std::numeric_limits<float>::infinity();
  if (leafCost < internalCost) {
    rootDecision.cost = leafCost;
    rootDecision.kind = CwbvhDecisionKind::Leaf;
  } else {
    rootDecision.cost = internalCost;
    rootDecision.kind = CwbvhDecisionKind::Internal;
  }
  decisions[decisionBase] = rootDecision;

  for (uint32_t i = 1; i < 7; ++i) {
    CwbvhDecision decision = decisions[decisionBase + i - 1];
    for (uint32_t k = 0; k < i; ++k) {
      const float cost = decisions[leftBase + k].cost +
        decisions[rightBase + i - k - 1].cost;
      if (cost < decision.cost) {
        decision.cost = cost;
        decision.kind = CwbvhDecisionKind::Distribute;
        decision.distributeLeft = static_cast<uint8_t>(k);
        decision.distributeRight = static_cast<uint8_t>(i - k - 1);
      }
    }
    decisions[decisionBase + i] = decision;
  }
  return info;
}

bool collectCwbvhChildren(
  const tinybvh::BVH& bvh,
  const std::vector<CwbvhDecision>& decisions,
  uint32_t nodeIndex,
  uint32_t forestSizeIndex,
  uint32_t children[8],
  uint32_t& childCount
) {
  const auto& node = bvh.bvhNode[nodeIndex];
  if (node.isLeaf()) {
    if (childCount >= 8) return false;
    children[childCount++] = nodeIndex;
    return true;
  }
  const auto& decision = decisions[static_cast<size_t>(nodeIndex) * 7 + forestSizeIndex];
  if (decision.distributeLeft >= 7 || decision.distributeRight >= 7) return false;
  const uint32_t childIndices[2] = {node.leftFirst, node.leftFirst + 1};
  const uint32_t distributeIndices[2] = {
    decision.distributeLeft,
    decision.distributeRight
  };
  for (uint32_t side = 0; side < 2; ++side) {
    const uint32_t childIndex = childIndices[side];
    const uint32_t distributeIndex = distributeIndices[side];
    const auto& childDecision = decisions[
      static_cast<size_t>(childIndex) * 7 + distributeIndex
    ];
    if (childDecision.kind == CwbvhDecisionKind::Distribute) {
      if (!collectCwbvhChildren(
        bvh,
        decisions,
        childIndex,
        distributeIndex,
        children,
        childCount
      )) return false;
    } else {
      if (childCount >= 8) return false;
      children[childCount++] = childIndex;
    }
  }
  return true;
}

bool buildOptimalCwbvhNode(
  const tinybvh::BVH& bvh,
  tinybvh::MBVH<8>& wide,
  const std::vector<CwbvhDecision>& decisions,
  const std::vector<CwbvhSubtreeInfo>& subtrees,
  uint32_t nodeIndex
) {
  const auto& source = bvh.bvhNode[nodeIndex];
  auto& node = wide.mbvhNode[nodeIndex];
  node = {};
  node.aabbMin = source.aabbMin;
  node.aabbMax = source.aabbMax;

  const auto& sourceDecision = decisions[static_cast<size_t>(nodeIndex) * 7];
  if (sourceDecision.kind == CwbvhDecisionKind::Leaf) {
    if (nodeIndex != 0 || bvh.usedNodes < 2) return false;
    const auto& subtree = subtrees[nodeIndex];
    if (!subtree.contiguous || !subtree.primitiveCount || subtree.primitiveCount > 3) {
      return false;
    }
    node.child[0] = 1;
    node.childCount = 1;
    auto& leaf = wide.mbvhNode[1];
    leaf = {};
    leaf.aabbMin = source.aabbMin;
    leaf.aabbMax = source.aabbMax;
    leaf.firstTri = subtree.firstPrimitive;
    leaf.triCount = subtree.primitiveCount;
    return true;
  }

  uint32_t children[8] = {};
  uint32_t childCount = 0;
  if (!collectCwbvhChildren(
    bvh,
    decisions,
    nodeIndex,
    0,
    children,
    childCount
  ) || !childCount) return false;
  node.childCount = childCount;
  for (uint32_t i = 0; i < childCount; ++i) node.child[i] = children[i];

  for (uint32_t i = 0; i < childCount; ++i) {
    const uint32_t childIndex = children[i];
    const auto& childSource = bvh.bvhNode[childIndex];
    const auto& childDecision = decisions[static_cast<size_t>(childIndex) * 7];
    auto& child = wide.mbvhNode[childIndex];
    child = {};
    child.aabbMin = childSource.aabbMin;
    child.aabbMax = childSource.aabbMax;
    if (childDecision.kind == CwbvhDecisionKind::Leaf) {
      const auto& subtree = subtrees[childIndex];
      if (!subtree.contiguous || !subtree.primitiveCount || subtree.primitiveCount > 3) {
        return false;
      }
      child.firstTri = subtree.firstPrimitive;
      child.triCount = subtree.primitiveCount;
    }
  }
  for (uint32_t i = 0; i < childCount; ++i) {
    const uint32_t childIndex = children[i];
    const auto& childDecision = decisions[static_cast<size_t>(childIndex) * 7];
    if (
      childDecision.kind == CwbvhDecisionKind::Internal &&
      !buildOptimalCwbvhNode(bvh, wide, decisions, subtrees, childIndex)
    ) return false;
  }
  return true;
}

bool convertToOptimalCwbvh(tinybvh::BVH& bvh, tinybvh::MBVH<8>& wide) {
  // Our DP indexes wide nodes by binary node ID. Upstream 1.9 normally sizes
  // its compact output to the collapsed node count, which is too small for
  // those sparse IDs. Keep the full binary-sized pool and primitive references.
  wide.ConvertFrom(bvh, false);
  wide.usedNodes = bvh.usedNodes;
  std::vector<CwbvhDecision> decisions(static_cast<size_t>(bvh.usedNodes) * 7);
  std::vector<CwbvhSubtreeInfo> subtrees(bvh.usedNodes);
  calculateCwbvhDecisions(bvh, 0, decisions, subtrees);
  return buildOptimalCwbvhNode(bvh, wide, decisions, subtrees, 0);
}

bool flattenGpuBvh(
  const tinybvh::BVH& bvh,
  const std::vector<uint32_t>& indices,
  const std::vector<uint32_t>& triangleMap,
  const float* displacement,
  std::vector<uint32_t>& output,
  uint32_t& stackRequirement
) {
  // TinyBVH 1.9 packs leaves into child pointers in BVH_GPU. Keep MuTracer's
  // existing 64-byte GPU contract, including full-width leaf counts/offsets,
  // by serializing the official binary tree into that layout explicitly.
  std::vector<uint32_t> nodes{0};
  std::vector<uint32_t> addresses(bvh.usedNodes, 0);
  for (size_t i = 0; i < nodes.size(); ++i) {
    const auto& node = bvh.bvhNode[nodes[i]];
    if (node.isLeaf()) continue;
    addresses[node.leftFirst] = static_cast<uint32_t>(nodes.size());
    nodes.push_back(node.leftFirst);
    addresses[node.leftFirst + 1] = static_cast<uint32_t>(nodes.size());
    nodes.push_back(node.leftFirst + 1);
  }
  output.assign(nodes.size() * 16, 0);
  std::vector<uint32_t> primitiveData;
  primitiveData.reserve(triangleMap.size() * 4);
  for (size_t i = 0; i < nodes.size(); ++i) {
    const auto& node = bvh.bvhNode[nodes[i]];
    const auto& left = node.isLeaf() ? node : bvh.bvhNode[node.leftFirst];
    const auto& right = node.isLeaf() ? node : bvh.bvhNode[node.leftFirst + 1];
    const size_t at = i * 16;
    const tinybvh::bvhvec3 bounds[4] = {
      left.aabbMin, left.aabbMax, right.aabbMin, right.aabbMax
    };
    for (uint32_t corner = 0; corner < 4; ++corner) {
      output[at + corner * 4] = floatBits(bounds[corner].x);
      output[at + corner * 4 + 1] = floatBits(bounds[corner].y);
      output[at + corner * 4 + 2] = floatBits(bounds[corner].z);
    }
    if (!node.isLeaf()) {
      output[at + 3] = addresses[node.leftFirst];
      output[at + 7] = addresses[node.leftFirst + 1];
      continue;
    }
    output[at + 11] = node.triCount;
    output[at + 15] = static_cast<uint32_t>(nodes.size() * 4 + primitiveData.size() / 4);
    for (uint32_t triangleOffset = 0; triangleOffset < node.triCount; ++triangleOffset) {
      appendPrimitive(
        bvh.primIdx[node.leftFirst + triangleOffset],
        indices,
        triangleMap,
        displacement,
        primitiveData
      );
    }
  }
  output.insert(output.end(), primitiveData.begin(), primitiveData.end());
  stackRequirement = binaryDepth(bvh, 0);
  return true;
}

bool flattenCwbvh(
  tinybvh::BVH& bvh,
  const std::vector<uint32_t>& indices,
  const std::vector<uint32_t>& triangleMap,
  const float* displacement,
  std::vector<uint32_t>& output,
  uint32_t& stackRequirement
) {
  // Match the paper's optimal wide-BVH construction: start from a binary BVH
  // with one primitive reference per leaf, then jointly optimize internal and
  // leaf collapse decisions for cnode=1, cprim=0.3, and Pmax=3.
  bvh.Compact();
  bvh.SplitLeafs(1);
  tinybvh::MBVH<8> wide;
  if (!convertToOptimalCwbvh(bvh, wide)) return false;
  if (wide.mbvhNode[0].isLeaf()) {
    const auto& root = bvh.bvhNode[0];
    if (!root.triCount || root.triCount > 24) return false;
    output.assign(20, 0);
    output[0] = floatBits(root.aabbMin.x);
    output[1] = floatBits(root.aabbMin.y);
    output[2] = floatBits(root.aabbMin.z);
    const auto encodeExponent = [](float extent) {
      if (!(extent > 0.0f)) return -126;
      return std::clamp(
        static_cast<int>(std::ceil(std::log2(extent / 255.0f))),
        -126,
        127
      );
    };
    const float extentX = root.aabbMax.x - root.aabbMin.x;
    const float extentY = root.aabbMax.y - root.aabbMin.y;
    const float extentZ = root.aabbMax.z - root.aabbMin.z;
    const int exponentX = encodeExponent(extentX);
    const int exponentY = encodeExponent(extentY);
    const int exponentZ = encodeExponent(extentZ);
    output[3] = static_cast<uint8_t>(exponentX) |
      (static_cast<uint32_t>(static_cast<uint8_t>(exponentY)) << 8) |
      (static_cast<uint32_t>(static_cast<uint8_t>(exponentZ)) << 16);
    output[5] = 5;
    const auto upperBound = [](float extent, int exponent) {
      return static_cast<uint32_t>(std::clamp(
        static_cast<int>(std::ceil(extent / std::ldexp(1.0f, exponent))),
        0,
        255
      ));
    };
    const uint32_t upperX = upperBound(extentX, exponentX);
    const uint32_t upperY = upperBound(extentY, exponentY);
    const uint32_t upperZ = upperBound(extentZ, exponentZ);
    std::vector<uint32_t> primitiveData;
    primitiveData.reserve(static_cast<size_t>(root.triCount) * 4);
    const uint32_t childCount = (root.triCount + 2) / 3;
    uint32_t triangleOffset = 0;
    for (uint32_t slot = 0; slot < childCount; ++slot) {
      const uint32_t count = std::min(3u, root.triCount - triangleOffset);
      const uint32_t unaryCount = count == 1 ? 1 : count == 2 ? 3 : 7;
      const uint32_t shift = (slot & 3) * 8;
      output[6 + slot / 4] |=
        ((unaryCount << 5) | triangleOffset) << shift;
      output[14 + slot / 4] |= upperX << shift;
      output[16 + slot / 4] |= upperY << shift;
      output[18 + slot / 4] |= upperZ << shift;
      for (uint32_t i = 0; i < count; ++i) {
        appendPrimitive(
          bvh.primIdx[root.leftFirst + triangleOffset + i],
          indices,
          triangleMap,
          displacement,
          primitiveData
        );
      }
      triangleOffset += count;
    }
    output.insert(output.end(), primitiveData.begin(), primitiveData.end());
    stackRequirement = childCount;
    return true;
  }
  // BVH8_CWBVH::ConvertFrom consumes/reorders the MBVH storage. Measure the
  // traversal requirement while the child links still describe the source
  // tree; recursing through them afterwards can revisit invalid/self links.
  stackRequirement = wideStackRequirement(wide, 0);
  tinybvh::BVH8_CWBVH compressed;
  compressed.ConvertFrom(wide);
  if (!compressed.usedBlocks) return false;
  output.resize(static_cast<size_t>(compressed.usedBlocks) * 4);
  std::memcpy(
    output.data(),
    compressed.bvh8Data,
    static_cast<size_t>(compressed.usedBlocks) * 16
  );
  std::vector<uint32_t> primitiveData;
  primitiveData.reserve(triangleMap.size() * 4);
  const uint32_t nodeCount = compressed.usedBlocks / 5;
  for (uint32_t nodeIndex = 0; nodeIndex < nodeCount; ++nodeIndex) {
    const size_t wordOffset = static_cast<size_t>(nodeIndex) * 20;
    // Upstream 1.9 stores IEEE-biased exponents. MuTracer's existing WGSL/GLSL
    // contract uses signed exponent bytes, including the direct tiny-root path.
    const uint32_t biased = output[wordOffset + 3];
    output[wordOffset + 3] = (biased & 0xff000000u) |
      (((biased & 0xffu) - 127u) & 0xffu) |
      (((((biased >> 8) & 0xffu) - 127u) & 0xffu) << 8) |
      (((((biased >> 16) & 0xffu) - 127u) & 0xffu) << 16);
    const uint32_t originalTriangleBase = output[wordOffset + 5];
    const uint32_t patchedTriangleBase = static_cast<uint32_t>(
      compressed.usedBlocks + primitiveData.size() / 4
    );
    if (patchedTriangleBase > BVH4_LEAF_OFFSET_MASK) return false;
    output[wordOffset + 5] = patchedTriangleBase;
    for (uint32_t slot = 0; slot < 8; ++slot) {
      const uint32_t metaWord = output[wordOffset + 6 + slot / 4];
      const uint32_t meta = (metaWord >> ((slot & 3) * 8)) & 0xff;
      if (!meta) continue;
      const uint32_t localOffset = meta & 0x1f;
      if (localOffset >= 24) continue;
      const uint32_t triangleCount =
        ((meta >> 5) & 1) + ((meta >> 6) & 1) + ((meta >> 7) & 1);
      for (uint32_t triangleOffset = 0; triangleOffset < triangleCount; ++triangleOffset) {
        // Upstream 1.9 defaults to four-block precomputed triangles. The
        // renderer still receives its existing index/height primitive records.
#ifdef CWBVH_COMPRESSED_TRIS
        const uint32_t sourceAddress =
          originalTriangleBase + (localOffset + triangleOffset) * 4 + 3;
#else
        const uint32_t sourceAddress =
          originalTriangleBase + (localOffset + triangleOffset) * 3 + 2;
#endif
        uint32_t compactTriangle;
        std::memcpy(
          &compactTriangle,
          &compressed.bvh8Tris[sourceAddress].w,
          sizeof(compactTriangle)
        );
        appendPrimitive(
          compactTriangle,
          indices,
          triangleMap,
          displacement,
          primitiveData
        );
      }
    }
  }
  output.insert(output.end(), primitiveData.begin(), primitiveData.end());
  return true;
}

uint8_t quantizeBound(float value, float minimum, float extent, bool upper) {
  if (!(extent > 0.0f)) return 0;
  const float scaled = (value - minimum) * (255.0f / extent);
  int quantized = upper
    ? static_cast<int>(std::ceil(scaled)) + 1
    : static_cast<int>(std::floor(scaled)) - 1;
  return static_cast<uint8_t>(std::clamp(quantized, 0, 255));
}

uint32_t packBytes(const uint8_t values[4]) {
  return static_cast<uint32_t>(values[0]) |
    (static_cast<uint32_t>(values[1]) << 8) |
    (static_cast<uint32_t>(values[2]) << 16) |
    (static_cast<uint32_t>(values[3]) << 24);
}

bool flattenWideBvh(
  tinybvh::BVH& bvh,
  const std::vector<uint32_t>& indices,
  const std::vector<uint32_t>& triangleMap,
  const float* displacement,
  std::vector<uint32_t>& output,
  uint32_t& stackRequirement
) {
  tinybvh::MBVH<4> wide;
  wide.ConvertFrom(bvh);

  std::vector<uint32_t> addresses(wide.allocatedNodes, std::numeric_limits<uint32_t>::max());
  std::vector<uint32_t> nodes;
  collectWideNodes(wide, 0, addresses, nodes);
  if (nodes.empty()) return false;

  output.assign(nodes.size() * 16, 0);
  std::vector<uint32_t> primitiveData;
  primitiveData.reserve(triangleMap.size() * 4);

  for (size_t nodeNumber = 0; nodeNumber < nodes.size(); ++nodeNumber) {
    const auto& node = wide.mbvhNode[nodes[nodeNumber]];
    const size_t start = nodeNumber * 16;
    const tinybvh::bvhvec3 padding(
      std::max(1e-6f, std::max(std::abs(node.aabbMin.x), std::abs(node.aabbMax.x)) * 1e-6f),
      std::max(1e-6f, std::max(std::abs(node.aabbMin.y), std::abs(node.aabbMax.y)) * 1e-6f),
      std::max(1e-6f, std::max(std::abs(node.aabbMin.z), std::abs(node.aabbMax.z)) * 1e-6f)
    );
    const tinybvh::bvhvec3 minimum(
      node.aabbMin.x - padding.x,
      node.aabbMin.y - padding.y,
      node.aabbMin.z - padding.z
    );
    const tinybvh::bvhvec3 maximum(
      node.aabbMax.x + padding.x,
      node.aabbMax.y + padding.y,
      node.aabbMax.z + padding.z
    );
    const tinybvh::bvhvec3 extent = maximum - minimum;
    output[start] = floatBits(minimum.x);
    output[start + 1] = floatBits(minimum.y);
    output[start + 2] = floatBits(minimum.z);
    output[start + 3] = floatBits(extent.x);
    output[start + 4] = floatBits(extent.y);
    output[start + 5] = floatBits(extent.z);

    uint8_t quantized[6][4] = {};
    for (uint32_t childSlot = 0; childSlot < node.childCount; ++childSlot) {
      const auto& child = wide.mbvhNode[node.child[childSlot]];
      quantized[0][childSlot] = quantizeBound(child.aabbMin.x, minimum.x, extent.x, false);
      quantized[1][childSlot] = quantizeBound(child.aabbMin.y, minimum.y, extent.y, false);
      quantized[2][childSlot] = quantizeBound(child.aabbMin.z, minimum.z, extent.z, false);
      quantized[3][childSlot] = quantizeBound(child.aabbMax.x, minimum.x, extent.x, true);
      quantized[4][childSlot] = quantizeBound(child.aabbMax.y, minimum.y, extent.y, true);
      quantized[5][childSlot] = quantizeBound(child.aabbMax.z, minimum.z, extent.z, true);

      uint32_t childInfo;
      if (child.isLeaf()) {
        if (child.triCount > 255) return false;
        const uint32_t primitiveOffset = static_cast<uint32_t>(nodes.size() * 4 + primitiveData.size() / 4);
        if (primitiveOffset > BVH4_LEAF_OFFSET_MASK) return false;
        childInfo = BVH4_LEAF_BIT |
          (child.triCount << BVH4_LEAF_COUNT_SHIFT) |
          primitiveOffset;
        for (uint32_t i = 0; i < child.triCount; ++i) {
          const uint32_t compactTriangle = bvh.primIdx[child.firstTri + i];
          appendPrimitive(
            compactTriangle,
            indices,
            triangleMap,
            displacement,
            primitiveData
          );
        }
      } else {
        childInfo = addresses[node.child[childSlot]];
      }
      output[start + 6 + childSlot] = childInfo;
    }
    for (uint32_t component = 0; component < 6; ++component) {
      output[start + 10 + component] = packBytes(quantized[component]);
    }
  }

  output.insert(output.end(), primitiveData.begin(), primitiveData.end());
  stackRequirement = wideStackRequirement(wide, 0);
  return true;
}

void serializeBvh(
  tinybvh::BVH& bvh,
  const std::vector<uint32_t>& indices,
  const std::vector<uint32_t>& triangleMap,
  const float* displacement,
  uint32_t requestedLayout,
  bool forceBvh2,
  BuildResult& result
) {
  std::vector<uint32_t> flattened;
  flattened.reserve(triangleMap.size() * 6);
  if (forceBvh2 || requestedLayout == BVH2_LAYOUT) {
    result.layout = BVH2_LAYOUT;
    flattenNode(bvh, 0, 1, indices, triangleMap, displacement, flattened, result.maxDepth
#ifdef MUTRACER_TINYBVH_NATIVE
      , nativeCaptureTriangleIds ? &result.triangleIds : nullptr
#endif
    );
  } else if (requestedLayout == BVH4_LAYOUT) {
    result.layout = BVH4_LAYOUT;
    if (!flattenWideBvh(
      bvh, indices, triangleMap, displacement, flattened, result.maxDepth
    )) return;
  } else if (requestedLayout == BVH_GPU_LAYOUT) {
    result.layout = BVH_GPU_LAYOUT;
    if (!flattenGpuBvh(
      bvh, indices, triangleMap, displacement, flattened, result.maxDepth
    )) return;
  } else if (requestedLayout == CWBVH_LAYOUT) {
    result.layout = CWBVH_LAYOUT;
    if (!flattenCwbvh(
      bvh, indices, triangleMap, displacement, flattened, result.maxDepth
    )) {
      // TinyBVH's CWBVH converter requires an interior root. Keep tiny meshes
      // renderable with its native 64-byte GPU layout instead.
      result.layout = BVH_GPU_LAYOUT;
      if (!flattenGpuBvh(
        bvh, indices, triangleMap, displacement, flattened, result.maxDepth
      )) return;
    }
  } else {
    return;
  }
  result.byteLength = static_cast<uint32_t>(flattened.size() * sizeof(uint32_t));
  result.data = static_cast<uint32_t*>(std::malloc(result.byteLength));
  if (result.data) std::memcpy(result.data, flattened.data(), result.byteLength);
}

} // namespace

extern "C" {

BuildResult* tinybvh_build(
  const float* positions,
  uint32_t vertexCount,
  uint32_t positionStride,
  const float* normals,
  uint32_t normalStride,
  const uint32_t* sourceIndices,
  uint32_t indexCount,
  float displacementScale,
  const float* displacement,
  uint32_t requestedLayout,
  uint32_t spatialSplits
) {
  auto* result = new BuildResult();
  if (!positions || !sourceIndices || positionStride < 3 || indexCount < 3) return result;

  std::vector<uint32_t> indices(sourceIndices, sourceIndices + indexCount);
  std::vector<uint32_t> filteredIndices;
  std::vector<uint32_t> triangleMap;
  filteredIndices.reserve(indexCount);
  triangleMap.reserve(indexCount / 3);
  for (uint32_t triangle = 0; triangle < indexCount / 3; ++triangle) {
    const uint32_t i0 = indices[triangle * 3];
    const uint32_t i1 = indices[triangle * 3 + 1];
    const uint32_t i2 = indices[triangle * 3 + 2];
    if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) continue;
    if (!finiteVertex(positions, positionStride, i0) ||
        !finiteVertex(positions, positionStride, i1) ||
        !finiteVertex(positions, positionStride, i2)) continue;
    filteredIndices.push_back(i0);
    filteredIndices.push_back(i1);
    filteredIndices.push_back(i2);
    triangleMap.push_back(triangle);
  }
  if (triangleMap.empty()) return result;

  tinybvh::BVH localBvh;
  tinybvh::BVH* bvh = &localBvh;
#if defined(MUTRACER_TINYBVH_NATIVE) && defined(BVH_USENEON)
  // Keep the backing vertices alive through layout conversion/serialization.
  std::vector<tinybvh::bvhvec4> alignedPositions;
#endif
  const bool useDisplacement = normals && normalStride >= 3 && displacement && std::abs(displacementScale) > 1e-6f;
  if (useDisplacement) {
    std::vector<tinybvh::bvhvec4> bounds(triangleMap.size() * 2);
    for (uint32_t compactTriangle = 0; compactTriangle < triangleMap.size(); ++compactTriangle) {
      const uint32_t triangle = triangleMap[compactTriangle];
      tinybvh::bvhvec3 minimum(1e30f), maximum(-1e30f);
      for (uint32_t corner = 0; corner < 3; ++corner) {
        const uint32_t vertexIndex = indices[triangle * 3 + corner];
        const tinybvh::bvhvec3 position = vertexAt(positions, positionStride, vertexIndex);
        tinybvh::bvhvec3 normal = vertexAt(normals, normalStride, vertexIndex);
        normalize(normal);
        float minHeight = displacement[triangle * 2] * displacementScale;
        float maxHeight = displacement[triangle * 2 + 1] * displacementScale;
        if (!std::isfinite(minHeight) || !std::isfinite(maxHeight)) {
          minHeight = 0.0f;
          maxHeight = displacementScale;
        }
        growBounds(minimum, maximum, tinybvh::bvhvec3(
          position.x + normal.x * minHeight,
          position.y + normal.y * minHeight,
          position.z + normal.z * minHeight
        ));
        growBounds(minimum, maximum, tinybvh::bvhvec3(
          position.x + normal.x * maxHeight,
          position.y + normal.y * maxHeight,
          position.z + normal.z * maxHeight
        ));
      }
      bounds[compactTriangle * 2] = tinybvh::bvhvec4(minimum, 0.0f);
      bounds[compactTriangle * 2 + 1] = tinybvh::bvhvec4(maximum, 0.0f);
    }
    bvh->BuildAABB(bounds.data(), static_cast<uint32_t>(triangleMap.size()));
  } else {
    const float* buildPositions = positions;
    const uint32_t* buildIndices = filteredIndices.data();
    // SBVH is opt-in: it lowers SAH cost but builds several times slower
    // than the default binned SAH builder.
    bvh->settings.useSpatialSplits = spatialSplits != 0;
    tinybvh::bvhvec4slice vertices{
      reinterpret_cast<const tinybvh::bvhvec4*>(buildPositions),
      vertexCount,
      static_cast<uint32_t>(positionStride * sizeof(float))
    };
#if defined(MUTRACER_TINYBVH_NATIVE) && defined(BVH_USENEON)
    // TinyBVH 1.9 dispatches to the full NEON/Bonsai builder. Its input slice
    // needs aligned float4 vertices; keep this storage through serialization.
    alignedPositions.resize(vertexCount);
    for (uint32_t i = 0; i < vertexCount; ++i) {
      alignedPositions[i] = tinybvh::bvhvec4(vertexAt(positions, positionStride, i), 0.0f);
    }
    bvh->Build(alignedPositions.data(), buildIndices, static_cast<uint32_t>(triangleMap.size()));
#else
    bvh->Build(vertices, buildIndices, static_cast<uint32_t>(triangleMap.size()));
#endif
  }

  serializeBvh(
    *bvh,
    indices,
    triangleMap,
    displacement,
    requestedLayout,
    useDisplacement,
    *result
  );
  return result;
}

// uintptr_t is i32 in Wasm32 and preserves full pointers in native builds.
uintptr_t tinybvh_result_data(const BuildResult* result) {
  return reinterpret_cast<uintptr_t>(result ? result->data : nullptr);
}

uint32_t tinybvh_result_size(const BuildResult* result) {
  return result ? result->byteLength : 0;
}

uint32_t tinybvh_result_max_depth(const BuildResult* result) {
  return result ? result->maxDepth : 0;
}

uint32_t tinybvh_result_layout(const BuildResult* result) {
  return result ? result->layout : BVH2_LAYOUT;
}

#ifdef MUTRACER_TINYBVH_NATIVE
uintptr_t mt_native_tiny_triangle_ids(const BuildResult* result) {return reinterpret_cast<uintptr_t>(result->triangleIds.data());}
uint32_t mt_native_tiny_triangle_ids_size(const BuildResult* result) {return static_cast<uint32_t>(result->triangleIds.size());}
#endif
void tinybvh_result_destroy(BuildResult* result) {
  if (!result) return;
  std::free(result->data);
  delete result;
}

}
