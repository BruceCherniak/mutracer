import type { EnvResolution } from '../store';

// Rendered with ClayPT by the thumbnail generator (see viewer/README.md).
const THUMBNAILS = import.meta.glob<string>('../assets/thumbnails/*.webp', { eager: true, query: '?url', import: 'default' });
export const thumbnailUrl = (name: string): string | undefined => THUMBNAILS[`../assets/thumbnails/${name}.webp`];

export interface ModelPreset {
  id: string;
  name: string;
  /** What the model is good for showing. */
  tag: string;
  /** `null` builds the procedural material-sphere scene. */
  url: string | null;
  thumbnail?: string;
  license: 'CC0' | 'CC-BY 4.0';
  /** Shown in the viewport for CC-BY assets. */
  credit: string;
  sourceUrl: string;
  sizeMB?: number;
}

const KHRONOS = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models';
const khronos = (
  id: string, model: string, name: string, tag: string, license: ModelPreset['license'],
  sizeMB: number
): ModelPreset => ({
  id, name, tag, license, sizeMB,
  url: `${KHRONOS}/${model}/glTF-Binary/${model}.glb`,
  thumbnail: thumbnailUrl(`model-${id}`),
  credit: `${name} · Khronos glTF Sample Assets · ${license}`,
  sourceUrl: `https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/${model}`
});

// Licenses checked against each model directory's LICENSE.md.
export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'spheres', name: 'Material spheres', tag: 'OpenPBR layers', url: null, license: 'CC0',
    thumbnail: thumbnailUrl('model-spheres'),
    credit: 'Procedural', sourceUrl: 'https://github.com/pissang/claypt'
  },
  khronos('toycar', 'ToyCar', 'Toy Car', 'Coat · transmission', 'CC0', 5.4),
  khronos('sheenchair', 'SheenChair', 'Sheen Chair', 'Fuzz', 'CC0', 4.1),
  khronos('helmet', 'DamagedHelmet', 'Damaged Helmet', 'Textures · emission', 'CC-BY 4.0', 3.8),
  khronos('candle', 'GlassHurricaneCandleHolder', 'Glass Candle Holder', 'Glass', 'CC-BY 4.0', 2.7),
  khronos('iridescence', 'IridescenceLamp', 'Iridescence Lamp', 'Thin film', 'CC-BY 4.0', 4.1),
  khronos('anisotropy', 'AnisotropyBarnLamp', 'Barn Lamp', 'Anisotropy', 'CC-BY 4.0', 7.8),
  khronos('watch', 'ChronographWatch', 'Chronograph Watch', 'Metals', 'CC-BY 4.0', 7.4),
  // Fox: model CC0, metadata CC-BY 4.0.
  khronos('fox', 'Fox', 'Fox', 'Animation', 'CC0', 0.2)
];

export interface EnvironmentPreset {
  id: string;
  name: string;
  /** `false` is the procedural sky. */
  polyHaven: boolean;
  thumbnail: string | null;
}

const polyHaven = (id: string, name: string): EnvironmentPreset => ({
  id, name, polyHaven: true,
  thumbnail: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256`
});

/** Poly Haven serves every HDRI at several widths; 1K is about 1.5 MB, 4K about 25 MB. */
export const ENV_RESOLUTIONS: { value: EnvResolution; label: string; size: string }[] = [
  { value: '1k', label: '1K', size: '~1.5 MB' },
  { value: '2k', label: '2K', size: '~6 MB' },
  { value: '4k', label: '4K', size: '~25 MB' }
];

export function environmentUrl(preset: EnvironmentPreset, resolution: EnvResolution) {
  return preset.polyHaven
    ? `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${resolution}/${preset.id}_${resolution}.hdr`
    : null;
}

/** Poly Haven HDRIs are CC0. */
export const ENVIRONMENT_PRESETS: EnvironmentPreset[] = [
  { id: 'sky', name: 'Procedural sky', polyHaven: false, thumbnail: null },
  polyHaven('studio_small_09', 'Studio'),
  polyHaven('empty_warehouse_01', 'Warehouse'),
  polyHaven('venice_sunset', 'Venice Sunset'),
  polyHaven('spruit_sunrise', 'Spruit Sunrise'),
  polyHaven('nature_reserve_forest', 'Forest'),
  polyHaven('lebombo', 'Lebombo'),
  polyHaven('snowy_field', 'Snowy Field'),
  polyHaven('moonless_golf', 'Night')
];
