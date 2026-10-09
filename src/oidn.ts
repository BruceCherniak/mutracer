import { initUNetFromBuffer, type UNet } from 'oidn-web';
import type Renderer from './Renderer';
import { VERSION } from './version';

export type OIDNEngine = 'auto' | 'wgsl' | 'webnn';
export type OIDNPrecision = 'auto' | 'fp32' | 'fp16';
export type OIDNHDRTransfer = 'pu' | 'log';
export interface OIDNDynamicTileOptions {
  minTileSize?: number;
  initialTileSize?: number;
  targetTileTimeMs?: number;
  adjustmentStep?: number;
}
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
  albedo: string | URL;
  normal: string | URL;
}
export interface OIDNAuxiliaryDenoisers {
  albedo: OIDNDenoiser;
  normal: OIDNDenoiser;
}
export type OIDNDenoiser = UNet & {
  /** Optional RT auxiliary filters used before a clean-aux beauty model. */
  auxiliaryDenoisers?: OIDNAuxiliaryDenoisers;
  /** Optional shape preparation supported by newer oidn-web runtimes. */
  prepareForImage?: (
    width: number,
    height: number,
    options?: { tileOverlap?: number }
  ) => Promise<void>;
};

/**
 * Weights published with this package version on jsDelivr. Self-host the
 * `oidn/weights` directory and pass `weightsBaseUrl` for production use.
 */
export const DEFAULT_OIDN_WEIGHTS_BASE_URL =
  `https://cdn.jsdelivr.net/npm/claypt@${VERSION}/oidn/weights/`;

export interface OIDNLoadOptions {
  /** Attach the loaded denoiser to the renderer. Defaults to true. */
  attach?: boolean;
  /** Maximum OIDN tile size. By default oidn-web chooses the tile size. */
  maxTileSize?: number;
  /** Optional signal used while downloading the weights. */
  signal?: AbortSignal;
  /** OIDN execution engine. `webnn` enables the experimental WebNN FP16 path. */
  engine?: OIDNEngine;
  /** Native WGSL precision. `auto` uses FP16 when shader-f16 is available. */
  precision?: OIDNPrecision;
  /** Adaptive tile controller settings, or false for fixed tiles. */
  dynamicTile?: OIDNDynamicTileSetting;
}

export interface InitializeOIDNOptions extends OIDNLoadOptions {
  /** Packaged model to load. Defaults to the standard model. */
  model?: OIDNModel;
  /** Directory containing the packaged weights. Defaults to the jsDelivr copy for this version. */
  weightsBaseUrl?: string | URL;
  /** Override the packaged albedo/normal prefilter weights for a clean-aux model. */
  auxiliaryModelUrls?: OIDNAuxiliaryModelUrls;
}

export interface CustomOIDNModelOptions extends OIDNLoadOptions {
  /** Whether the custom model consumes albedo and normal guides. Defaults to true. */
  aux?: boolean;
  /** Whether the custom model consumes HDR color. Defaults to true. */
  hdr?: boolean;
  /** HDR encoding expected by the weights. OIDN's RT models use PU. */
  hdrTransfer?: OIDNHDRTransfer;
  /** Optional albedo/normal filters to run before the custom clean-aux model. */
  auxiliaryModelUrls?: OIDNAuxiliaryModelUrls;
}

export function resolveOIDNModelUrl(
  model: OIDNModel,
  weightsBaseUrl: string | URL = DEFAULT_OIDN_WEIGHTS_BASE_URL
) {
  const baseUrl = String(weightsBaseUrl);
  return `${baseUrl}${baseUrl.endsWith('/') ? '' : '/'}${OIDN_MODEL_FILENAMES[model]}`;
}

export function resolveOIDNAuxiliaryModelUrls(
  weightsBaseUrl: string | URL = DEFAULT_OIDN_WEIGHTS_BASE_URL
): OIDNAuxiliaryModelUrls {
  const baseUrl = String(weightsBaseUrl);
  const prefix = `${baseUrl}${baseUrl.endsWith('/') ? '' : '/'}`;
  return {
    albedo: `${prefix}${OIDN_AUXILIARY_MODEL_FILENAMES.albedo}`,
    normal: `${prefix}${OIDN_AUXILIARY_MODEL_FILENAMES.normal}`
  };
}

async function fetchOIDNWeights(url: string | URL, signal?: AbortSignal) {
  const response = await fetch(String(url), { signal });
  if (!response.ok) {
    throw new Error(
      `Failed to load OIDN weights from ${url}: ${response.status} ${response.statusText}`
    );
  }
  return response.arrayBuffer();
}

/**
 * Loads an HDR OIDN model with albedo/normal guides on the renderer's WebGPU
 * device and attaches it to the renderer by default.
 */
export async function initializeOIDNFromURL(
  renderer: Renderer,
  weightsUrl: string | URL,
  options: CustomOIDNModelOptions = {}
): Promise<OIDNDenoiser> {
  const { device } = await renderer.getGPUDeviceAndAdapter();
  if (!renderer.isUsingWebGPU() || !device) {
    throw new Error('OIDN requires a WebGPU renderer.');
  }

  const auxiliaryUrls = options.auxiliaryModelUrls;
  const weightBuffers = await Promise.all([
    fetchOIDNWeights(weightsUrl, options.signal),
    ...(auxiliaryUrls
      ? [
          fetchOIDNWeights(auxiliaryUrls.albedo, options.signal),
          fetchOIDNWeights(auxiliaryUrls.normal, options.signal)
        ]
      : [])
  ]);
  const backend = { device };
  const runtimeOptions = {
    hdrTransfer: options.hdrTransfer ?? 'pu',
    maxTileSize: options.maxTileSize,
    engine: options.engine,
    precision: options.precision,
    dynamicTile: options.dynamicTile
  };
  let denoiser: OIDNDenoiser | undefined;
  let albedoDenoiser: OIDNDenoiser | undefined;
  try {
    denoiser = await initUNetFromBuffer(weightBuffers[0], backend, {
      aux: options.aux ?? true,
      hdr: options.hdr ?? true,
      ...runtimeOptions
    });
    if (auxiliaryUrls) {
      // Auxiliary RT networks are color-only three-channel UNets. The render
      // pipeline supplies their feature-specific transfer functions.
      albedoDenoiser = await initUNetFromBuffer(weightBuffers[1], backend, {
        aux: false,
        hdr: false,
        ...runtimeOptions
      });
      const normalDenoiser = await initUNetFromBuffer(
        weightBuffers[2],
        backend,
        {
          aux: false,
          hdr: false,
          ...runtimeOptions
        }
      );
      denoiser.auxiliaryDenoisers = {
        albedo: albedoDenoiser,
        normal: normalDenoiser
      };
    }
  } catch (error) {
    albedoDenoiser?.dispose();
    denoiser?.dispose();
    throw error;
  }
  try {
    const { width, height } = renderer.getSize();
    if (width > 0 && height > 0) {
      const tileOverlap = renderer.oidnWhileConverging ? 80 : undefined;
      await Promise.all([
        denoiser.prepareForImage?.(width, height, { tileOverlap }),
        denoiser.auxiliaryDenoisers?.albedo.prepareForImage?.(width, height, {
          tileOverlap
        }),
        denoiser.auxiliaryDenoisers?.normal.prepareForImage?.(width, height, {
          tileOverlap
        })
      ]);
    }
  } catch (error) {
    denoiser.auxiliaryDenoisers?.normal.dispose();
    denoiser.auxiliaryDenoisers?.albedo.dispose();
    denoiser.dispose();
    throw error;
  }
  if (options.attach !== false) renderer.oidn = denoiser;
  return denoiser;
}

/** Loads one of the packaged OIDN models. */
export function initializeOIDN(
  renderer: Renderer,
  options: InitializeOIDNOptions = {}
) {
  const {
    model = 'standard',
    weightsBaseUrl,
    auxiliaryModelUrls,
    ...loadOptions
  } = options;
  return initializeOIDNFromURL(
    renderer,
    resolveOIDNModelUrl(model, weightsBaseUrl),
    {
      ...loadOptions,
      auxiliaryModelUrls:
        model === 'cleanAuxLarge'
          ? auxiliaryModelUrls ?? resolveOIDNAuxiliaryModelUrls(weightsBaseUrl)
          : undefined
    }
  );
}
