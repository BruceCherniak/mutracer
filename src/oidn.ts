import { initUNetFromBuffer, type UNet } from 'oidn-web';
import type Renderer from './Renderer';
import { VERSION } from './version';
import { standardWeightsUrl, smallWeightsUrl } from './oidnBundledWeights';

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
  /** Albedo prefilter weights URL; required when overriding auxiliary networks. */
  albedo: string | URL;
  /** Normal prefilter weights URL; required when overriding auxiliary networks. */
  normal: string | URL;
}
export interface OIDNAuxiliaryDenoisers {
  /** Loaded albedo prefilter; supplied by the clean-aux loader. */
  albedo: OIDNDenoiser;
  /** Loaded normal prefilter; supplied by the clean-aux loader. */
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

/** Package containing all OIDN RT networks. Default: `oidn-weights`. */
export const OIDN_WEIGHTS_PACKAGE = 'oidn-weights';
/** OIDN network version, independent of MuTracer. Default: `2.3.0`. */
export const OIDN_WEIGHTS_PACKAGE_VERSION = '2.3.0';
/** Default large-network directory: jsDelivr's `oidn-weights@2.3.0/`. */
export const DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL =
  `https://cdn.jsdelivr.net/npm/${OIDN_WEIGHTS_PACKAGE}@${OIDN_WEIGHTS_PACKAGE_VERSION}/`;
/**
 * Fallback for bundled standard/small weights when application assets fail.
 * Defaults to jsDelivr's `mutracer@VERSION/oidn/weights/` directory.
 */
export const DEFAULT_OIDN_WEIGHTS_BASE_URL =
  `https://cdn.jsdelivr.net/npm/mutracer@${VERSION}/oidn/weights/`;

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
  /** Override directory for all weights. Defaults to bundled standard/small assets and the oidn-weights CDN for large networks. */
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
  weightsBaseUrl?: string | URL
) {
  if (weightsBaseUrl === undefined) {
    if (model === 'standard') return String(standardWeightsUrl);
    if (model === 'small') return String(smallWeightsUrl);
  }
  const baseUrl = String(weightsBaseUrl ?? DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL);
  return `${baseUrl}${baseUrl.endsWith('/') ? '' : '/'}${OIDN_MODEL_FILENAMES[model]}`;
}

export function resolveOIDNAuxiliaryModelUrls(
  weightsBaseUrl: string | URL = DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL
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
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0xD7 || bytes[1] !== 0x41) {
    throw new Error(`Invalid OIDN TZA weights from ${url}: expected magic D7 41 (received non-TZA content).`);
  }
  return buffer;
}

/**
 * Loads an HDR OIDN model with albedo/normal guides on the renderer's WebGPU
 * device and attaches it to the renderer by default.
 */
async function loadOIDN(
  renderer: Renderer,
  weightsUrl: string | URL,
  options: CustomOIDNModelOptions = {},
  fetchWeights = fetchOIDNWeights
): Promise<OIDNDenoiser> {
  const { device } = await renderer.getGPUDeviceAndAdapter();
  if (!renderer.isUsingWebGPU() || !device) {
    throw new Error('OIDN requires a WebGPU renderer.');
  }

  const auxiliaryUrls = options.auxiliaryModelUrls;
  const weightBuffers = await Promise.all([
    fetchWeights(weightsUrl, options.signal),
    ...(auxiliaryUrls
      ? [
          fetchWeights(auxiliaryUrls.albedo, options.signal),
          fetchWeights(auxiliaryUrls.normal, options.signal)
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
      // Shapes for whole-image tiles. Renderer.setDenoiser() prepares the
      // overlapped tiles of `whileConverging` itself once it attaches.
      await Promise.all([
        denoiser.prepareForImage?.(width, height),
        denoiser.auxiliaryDenoisers?.albedo.prepareForImage?.(width, height),
        denoiser.auxiliaryDenoisers?.normal.prepareForImage?.(width, height)
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

/** Loads an explicit HDR network URL; download failures never fall back to a CDN. */
export function initializeOIDNFromURL(
  renderer: Renderer,
  weightsUrl: string | URL,
  options: CustomOIDNModelOptions = {}
): Promise<OIDNDenoiser> {
  return loadOIDN(renderer, weightsUrl, options);
}

let warnedBundledWeights = false;

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
  const mainUrl = resolveOIDNModelUrl(model, weightsBaseUrl);
  const defaultBundled = weightsBaseUrl === undefined && model !== 'cleanAuxLarge';
  const defaultLarge = new Set<string>(weightsBaseUrl === undefined && model === 'cleanAuxLarge'
    ? [mainUrl, ...(!auxiliaryModelUrls ? Object.values(resolveOIDNAuxiliaryModelUrls()).map(String) : [])]
    : []);
  const fetchWeights = async (url: string | URL, signal?: AbortSignal) => {
    try {
      return await fetchOIDNWeights(url, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (defaultBundled && String(url) === mainUrl) {
        if (!warnedBundledWeights) {
          warnedBundledWeights = true;
          console.warn('Bundled OIDN weights failed to load; falling back to jsDelivr. In Vite development add optimizeDeps: { exclude: ["mutracer"] }, or pass weightsBaseUrl to self-host the weights.', error);
        }
        return fetchOIDNWeights(resolveOIDNModelUrl(model, DEFAULT_OIDN_WEIGHTS_BASE_URL), signal);
      }
      if (defaultLarge.has(String(url))) {
        throw new Error(`Failed to load ${OIDN_WEIGHTS_PACKAGE} network from ${url}. Self-host node_modules/oidn-weights/*.tza and pass weightsBaseUrl. ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  };
  return loadOIDN(
    renderer,
    mainUrl,
    {
      ...loadOptions,
      auxiliaryModelUrls:
        model === 'cleanAuxLarge'
          ? auxiliaryModelUrls ?? resolveOIDNAuxiliaryModelUrls(weightsBaseUrl)
          : undefined
    },
    fetchWeights
  );
}
