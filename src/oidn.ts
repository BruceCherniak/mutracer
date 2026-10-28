/// <reference types="@webgpu/types" preserve="true" />

import { VERSION } from './version.js';
import { standardWeightsUrl, smallWeightsUrl } from './oidnBundledWeights.js';

export type OIDNEngine = 'auto' | 'wgsl' | 'webnn';
export type OIDNPrecision = 'auto' | 'fp32' | 'fp16';
export type OIDNHDRTransfer = 'pu' | 'log';
export interface OIDNDynamicTileOptions {
  /** Smallest output tile edge in pixels. Default `256`, clamped to maxTileSize. */
  minTileSize?: number;
  /** Initial output tile edge in pixels. Default `432`, clamped to tile limits. */
  initialTileSize?: number;
  /** Target upper bound for one tile GPU latency in milliseconds. Default `16`. */
  targetTileTimeMs?: number;
  /** Tile edge adjustment in pixels per completed execution. Default `16`. */
  adjustmentStep?: number;
}
/** Adaptive tiles. Default true; false selects fixed tiles. */
export type OIDNDynamicTileSetting = boolean | OIDNDynamicTileOptions;

export const OIDN_MODEL_FILENAMES = {
  small: 'rt_hdr_alb_nrm_small.tza',
  standard: 'rt_hdr_alb_nrm.tza',
  cleanAuxLarge: 'rt_hdr_calb_cnrm_large.tza'
} as const;
export const OIDN_AUXILIARY_MODEL_FILENAMES = {
  albedo: 'rt_alb_large.tza',
  normal: 'rt_nrm_large.tza'
} as const;

export type OIDNModel = keyof typeof OIDN_MODEL_FILENAMES;
export interface OIDNAuxiliaryModelUrls {
  /** Required when overriding auxiliary networks. Default packaged cleanAuxLarge albedo weights. */
  albedo: string | URL;
  /** Required when overriding auxiliary networks. Default packaged cleanAuxLarge normal weights. */
  normal: string | URL;
}
/** Package containing all OIDN RT networks. Default: `oidn-weights`. */
export const OIDN_WEIGHTS_PACKAGE = 'oidn-weights';
/** Weights package version for OIDN 2.3.0, independent of MuTracer. Default: `2.3.0-1`. */
export const OIDN_WEIGHTS_PACKAGE_VERSION = '2.3.0-1';
/** Default large-network directory: jsDelivr's `oidn-weights@2.3.0-1/`. */
export const DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL =
  `https://cdn.jsdelivr.net/npm/${OIDN_WEIGHTS_PACKAGE}@${OIDN_WEIGHTS_PACKAGE_VERSION}/`;
/**
 * Fallback for bundled standard/small weights when application assets fail.
 * Defaults to jsDelivr's `@meimu/mutracer@VERSION/oidn/weights/` directory.
 */
export const DEFAULT_OIDN_WEIGHTS_BASE_URL =
  `https://cdn.jsdelivr.net/npm/@meimu/mutracer@${VERSION}/oidn/weights/`;

export function resolveOIDNModelUrl(
  model: OIDNModel,
  weightsBaseUrl?: string | URL
) {
  if (weightsBaseUrl === undefined) {
    if (model === 'standard') return String(standardWeightsUrl);
    if (model === 'small') return String(smallWeightsUrl);
  }
  const base = weightsBaseUrl ?? DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL;
  // Narrow before coercion so native compilers see one representation at a time.
  const baseUrl = typeof base === 'string' ? base : String(base);
  return `${baseUrl}${baseUrl.endsWith('/') ? '' : '/'}${OIDN_MODEL_FILENAMES[model]}`;
}

export function resolveOIDNAuxiliaryModelUrls(
  weightsBaseUrl: string | URL = DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL
): OIDNAuxiliaryModelUrls {
  const baseUrl = typeof weightsBaseUrl === 'string' ? weightsBaseUrl : String(weightsBaseUrl);
  const prefix = `${baseUrl}${baseUrl.endsWith('/') ? '' : '/'}`;
  return {
    albedo: `${prefix}${OIDN_AUXILIARY_MODEL_FILENAMES.albedo}`,
    normal: `${prefix}${OIDN_AUXILIARY_MODEL_FILENAMES.normal}`
  };
}
