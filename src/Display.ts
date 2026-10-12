import type Engine from './Engine.js';
import type Render from './Render.js';
import type { ToneMapping, RenderOutput } from './renderer/RenderingPipeline.js';
import type { ColorRGB } from './types.js';
/** Display image channels. Default final. */
export type DisplayChannel = RenderOutput;
/** Image encoding options for Display.toBlob. */
export interface BlobOptions {
  /** Browser image MIME type. Default image/png. */ type?: string;
  /** Encoder quality in 0–1. Default undefined uses the browser default. */ quality?: number;
}
/** Canvas presentation and shared display settings; obtained from engine.display. */
export default class Display {
  /** Display canvas, supplied to Engine or newly created by default. */ readonly canvas: HTMLCanvasElement;
  /** Tone mapping transform. Default agx. */ toneMapping: ToneMapping = 'agx';
  /** Linear exposure multiplier. Default 1. */ toneMappingExposure = 1;
  /** Contrast multiplier. Default 1. */ contrast = 1;
  /** Saturation multiplier. Default 1. */ saturation = 1;
  /** White balance temperature shift in -1–1. Default 0. */ temperature = 0;
  /** Green/magenta tint in -1–1. Default 0. */ tint = 0;
  /** Vignette strength in 0–1. Default 0. */ vignette = 0;
  /** Bloom intensity; 0 disables it. Default 0. */ bloomIntensity = 0;
  /** Bloom luminance threshold. Default 1. */ bloomThreshold = 1;
  /** Bloom radius in 0–1. Default 0.6. */ bloomRadius = 0.6;
  /** Extended-range WebGPU presentation, ignored on WebGL. Default false. */ hdrOutputEnabled = false;
  /** Display image channel. Default final. */ channel: DisplayChannel = 'final';
  /** Linear shadow-catcher color. Default black. */ shadowCatcherColor: ColorRGB = [0, 0, 0];
  /** Shadow-catcher opacity multiplier. Default 1. */ shadowCatcherAlpha = 1;
  private constructor(private readonly engine: Engine, canvas: HTMLCanvasElement) { this.canvas = canvas; }
  /** @internal */ static _create(engine: Engine, canvas: HTMLCanvasElement) { return new Display(engine, canvas); }
  /** Resizes the drawing buffer; scale-based renders resize at their next refine. */
  setSize(width: number, height: number) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('Display dimensions must be positive.');
    width = Math.round(width); height = Math.round(height);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }
  private compose(render: Render) {
    if (render._engine !== this.engine) throw new Error('Render belongs to another engine.');
    const target = render._output;
    if (!target?.presentationComplete) return;
    target.activate();
    target.setToneMappingParams({toneMapping: this.toneMapping, exposure: this.toneMappingExposure, contrast: this.contrast, saturation: this.saturation, temperature: this.temperature, tint: this.tint, vignette: this.vignette});
    target.setBloomParams({intensity: this.bloomIntensity, threshold: this.bloomThreshold, radius: this.bloomRadius});
    target.setHDROutputEnabled?.(this.hdrOutputEnabled);
    target.setOutput(this.channel);
    target.setShadowCatcherParams(this.shadowCatcherColor, this.shadowCatcherAlpha);
    target.drawPostProcess();
    return target;
  }
  /** Presents a complete render or its fallback. Does not trace; leaves canvas unchanged if neither is ready. */
  present(render: Render): Render | undefined {
    if (render._engine !== this.engine) throw new Error('Render belongs to another engine.');
    const selected = render._complete ? render : render.fallback?._complete ? render.fallback : undefined;
    if (!selected) return;
    const target = this.compose(selected);
    if (!target) return;
    this.engine._present(target);
    return selected;
  }
  /** Encodes this render at its actual dimensions using these settings; leaves the display canvas unchanged. */
  async toBlob(render: Render, options: BlobOptions = {}): Promise<Blob> {
    const target = this.compose(render);
    if (!target) throw new Error('Render has no complete image.');
    const image = await target.readPresentation();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The image encoding context is not available.');
    const bytes = new Uint8ClampedArray(image.data.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, image.data[i])) * 255);
    context.putImageData(new ImageData(bytes, image.width, image.height), 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image could not be encoded')), options.type ?? 'image/png', options.quality));
  }
}
