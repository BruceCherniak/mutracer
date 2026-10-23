/** Immutable sky description, carried through scene snapshots without pixel storage. */
export interface ProceduralSkyImage {
  readonly type: 'ProceduralSky';
  readonly width: number;
  readonly height: number;
  readonly time: number;
}
export function isProceduralSkyImage(image: unknown): image is ProceduralSkyImage {
  return !!image && (image as ProceduralSkyImage).type === 'ProceduralSky';
}

const LATITUDE = 40;
/** Local solar time of the default sky, in hours. */
export const DEFAULT_SKY_TIME = 15;
/** Selectable times: from just before sunrise to just after sunset. */
export const SKY_TIME_RANGE = [5.5, 18.5] as const;
const DEFAULT_AZIMUTH = 50;

/**
 * Sun direction at a local solar time, for an equinox day at 40° latitude.
 * The path is rotated so the default 15:00 sun keeps its 50° azimuth.
 */
export function sunPosition(hours: number) {
  const latitude = deg(LATITUDE);
  const compass = (h: number) => {
    const angle = deg(15 * (h - 12));
    return Math.atan2(Math.sin(angle), Math.cos(angle) * Math.sin(latitude)) + Math.PI;
  };
  const angle = deg(15 * (hours - 12));
  const elevation = Math.asin(Math.cos(latitude) * Math.cos(angle));
  return {
    elevation: (elevation * 180) / Math.PI,
    azimuth: DEFAULT_AZIMUTH + ((compass(hours) - compass(DEFAULT_SKY_TIME)) * 180) / Math.PI
  };
}


function deg(d: number) { return d * Math.PI / 180; }
