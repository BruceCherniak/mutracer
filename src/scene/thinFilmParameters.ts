// Per-material encoding; no additional scene feature bits.
export const thinFilmMapChannels = ['r', 'g', 'b', 'a'] as const;
export type ThinFilmMapChannel = typeof thinFilmMapChannels[number];
export function thinFilmMapChannelIndex(channel: unknown): number {
  const index = thinFilmMapChannels.indexOf(channel as ThinFilmMapChannel);
  if (index < 0) throw new Error(`Invalid thinFilmMapChannel: ${String(channel)}; expected r, g, b or a`);
  return index;
}
export function finiteFilmThickness(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}
