import type {Denoiser} from '@meimu/mutracer';

/** Minimal caller-owned custom filter: identity in linear HDR, useful for integration checks. */
export const copyDenoiser: Denoiser = {
  async denoise({device, width, height, color, output}, {signal}) {
    if (signal.aborted) return;
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(color, 0, output, 0, width * height * 16);
    device.queue.submit([encoder.finish()]);
  }
};
