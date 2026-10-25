import type {Denoiser} from '../Render.js';
import type {JNLMDenoiser} from './jnlm.js';
import type {OIDNDenoiser} from './oidnNetwork.js';

export interface OIDNWebGPUData {
  data: GPUBuffer | GPUTexture;
  width: number;
  height: number;
}
export interface OIDNWebGPUOutputData {
  data: GPUBuffer;
  width: number;
  height: number;
}

export interface OIDNWeb {
  auxiliaryDenoisers?: {
    albedo: OIDNWeb;
    normal: OIDNWeb;
  };
  /** Optional serializable execution details exposed by native oidn-webgpu. */
  getRuntimeInfo?: () => unknown;
  /** Optional shape preparation supported by newer oidn-webgpu runtimes. */
  prepareForImage?: (
    width: number,
    height: number,
    options?: { tileOverlap?: number }
  ) => Promise<void>;
  tileExecute: (opts: {
    color: OIDNWebGPUData;
    albedo?: OIDNWebGPUData;
    normal?: OIDNWebGPUData;
    denoiseAlpha?: boolean;
    wholeImage?: boolean;
    tileOverlap?: number;
    scheduling?: 'animation-frame' | 'event-loop';
    done: (outputData: {
      data: GPUBuffer;
      width: number;
      height: number;
    }) => void;
    error?: (reason: unknown) => void;
    progress?: (
      outputData: OIDNWebGPUOutputData,
      tileData: OIDNWebGPUOutputData | undefined,
      tile: { x: number; y: number; width: number; height: number },
      currentIdx: number,
      totalIdx: number
    ) => void;
  }) => () => void;
}

/** Explicit private dispatch; built-ins do not implement the public custom interface. */
export type DenoiserHandle =
  | {kind: 'jnlm'; denoiser: JNLMDenoiser}
  | {kind: 'oidn'; denoiser: OIDNWeb}
  | {kind: 'custom'; denoiser: Denoiser};
/** Only these handles are owned and released by the engine. */
export type OwnedDenoiser =
  | {kind: 'jnlm'; denoiser: JNLMDenoiser}
  | {kind: 'oidn'; denoiser: OIDNDenoiser};
