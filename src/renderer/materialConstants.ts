/** Numeric shader representation of the public map-alpha strings. */
export const mapAlphaUsageConstants = { opaque: 0, alpha: 2, transmission: 3 } as const;

export const uvProjectionConstants = {
  none: 0,
  spherical: 1,
  cylindrical: 2,
  triplanar: 3
};


export const materialAlphaModeConstants = {
  opaque: 0,
  mask: 1,
  blend: 2
} as const;
