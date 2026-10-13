/** Internal pipeline floor: 4 scene + 4 accumulation buffers, 8 textures
 * including displacement, one adaptive storage texture, and 16×16 compute.
 * Buffer capacity covers one aligned 16×16 shadow-catcher target (48 B/pixel).
 * Larger scenes/images and OIDN impose additional, size-dependent requirements.
 */
export const minimumDeviceLimits = {
  maxStorageBuffersPerShaderStage: 8,
  maxStorageBufferBindingSize: 12288,
  maxBufferSize: 12288,
  maxSampledTexturesPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 1,
  maxComputeWorkgroupStorageSize: 0,
  maxComputeWorkgroupSizeX: 64,
  maxComputeWorkgroupSizeY: 16,
  maxComputeInvocationsPerWorkgroup: 256,
  maxBindGroups: 4,
} as const;

export function validateDevice(device: GPUDevice): void {
  const missing: string[] = [];
  for (const [key, required] of Object.entries(minimumDeviceLimits)) {
    const actual = device.limits[key as keyof GPUSupportedLimits];
    if (typeof actual !== 'number' || actual < required) missing.push(`${key}: requires ${required}, actual ${actual}`);
  }
  // No mandatory optional features: tracing uses f32, manual float filtering
  // and render attachments; timestamp queries have a wall-clock fallback.
  if (missing.length) throw new Error(`GPUDevice does not meet MuTracer requirements:\n${missing.join('\n')}`);
}

/** Recommended descriptor for MuTracer and OIDN on this adapter. Requests
 * supported optional features and adapter limits; defaults depend on adapter.
 * The resulting device remains owned by the caller.
 */
export function getRecommendedDeviceDescriptor(adapter: GPUAdapter): GPUDeviceDescriptor {
  const features: GPUFeatureName[] = [];
  for (const feature of ['timestamp-query', 'bgra8unorm-storage', 'shader-f16', 'subgroups',
    'texture-formats-tier1', 'texture-formats-tier2', 'float32-filterable'] as GPUFeatureName[]) {
    if (adapter.features.has(feature)) features.push(feature);
  }
  const limits = adapter.limits;
  const requiredLimits: Record<string, number> = {};
  for (const key of ['maxComputeWorkgroupStorageSize', 'maxComputeWorkgroupsPerDimension',
    'maxStorageBufferBindingSize', 'maxStorageBuffersPerShaderStage', 'maxSampledTexturesPerShaderStage',
    'maxStorageTexturesPerShaderStage', 'maxBufferSize', 'maxTextureArrayLayers',
    'maxComputeWorkgroupSizeX', 'maxComputeInvocationsPerWorkgroup'] as const) requiredLimits[key] = limits[key];
  return {requiredFeatures: features, requiredLimits};
}
