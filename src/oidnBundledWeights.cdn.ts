import { VERSION } from './version';

// Library bundles cannot carry package-relative assets; use the published copy.
export const standardWeightsUrl = `https://cdn.jsdelivr.net/npm/mutracer@${VERSION}/oidn/weights/rt_hdr_alb_nrm.tza`;
export const smallWeightsUrl = `https://cdn.jsdelivr.net/npm/mutracer@${VERSION}/oidn/weights/rt_hdr_alb_nrm_small.tza`;
