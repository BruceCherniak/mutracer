/** Grow in coarse buckets; scene edits must not shrink a compiled stack. */
export function retainedShaderCapacity(required: number, previous = 0, minimum = 8) {
  return Math.max(previous, minimum, 2 ** Math.ceil(Math.log2(Math.max(1, required))));
}

