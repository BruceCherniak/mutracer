const BAKED_SIZE = 128;

export class IESParseError extends Error {
  constructor(message: string, profileName = 'IES profile') {
    super(`${profileName}: ${message}`);
    this.name = 'IESParseError';
  }
}

function angleIndex(angle: number, angles: number[]) {
  if (angles.length === 1 || angle <= angles[0]) return 0;
  const last = angles.length - 1;
  if (angle >= angles[last]) return last;
  for (let i = 1; i <= last; i++) {
    if (angle <= angles[i]) {
      return i - 1 + (angle - angles[i - 1]) / (angles[i] - angles[i - 1]);
    }
  }
  return last;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export default class IESProfile {
  readonly type = 'IESProfile' as const;
  readonly size = BAKED_SIZE;

  constructor(
    readonly name: string,
    readonly verticalAngles: number[],
    readonly horizontalAngles: number[],
    readonly candelaValues: number[],
    readonly peakCandela: number,
    readonly data: Float32Array
  ) {}

  /** Bilinear LM-63 candela lookup, normalized so the source peak is exactly 1. */
  evaluateAngles(verticalDegrees: number, horizontalDegrees: number) {
    if (verticalDegrees > this.verticalAngles[this.verticalAngles.length - 1]) {
      return 0;
    }
    let horizontal = horizontalDegrees;
    const lastHorizontal =
      this.horizontalAngles[this.horizontalAngles.length - 1];
    if (lastHorizontal <= 180) {
      horizontal = Math.abs(horizontal);
      if (lastHorizontal === 90 && horizontal > 90) {
        horizontal = 180 - horizontal;
      }
    } else if (horizontal < 0) {
      horizontal += 360;
    }
    const v = angleIndex(verticalDegrees, this.verticalAngles);
    const h = angleIndex(horizontal, this.horizontalAngles);
    const v0 = Math.floor(v);
    const v1 = Math.ceil(v);
    const h0 = Math.floor(h);
    const h1 = Math.ceil(h);
    const vf = v - v0;
    const hf = h - h0;
    const n = this.verticalAngles.length;
    const a = this.candelaValues[h0 * n + v0];
    const b = this.candelaValues[h0 * n + v1];
    const c = this.candelaValues[h1 * n + v0];
    const d = this.candelaValues[h1 * n + v1];
    return lerp(lerp(a, b, vf), lerp(c, d, vf), hf) / this.peakCandela;
  }

  /** CPU reference for the manual bilinear lookup used by the WebGL/WGSL paths. */
  sampleBaked(
    verticalRadians: number,
    horizontalRadians: number,
    rotationRadians = 0
  ) {
    const u = verticalRadians / Math.PI;
    const v = (horizontalRadians - rotationRadians) / (2 * Math.PI) + 0.5;
    const px = u * BAKED_SIZE - 0.5;
    const py = v * BAKED_SIZE - 0.5;
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const fx = px - x0;
    const fy = py - y0;
    const wrap = (value: number) =>
      ((value % BAKED_SIZE) + BAKED_SIZE) % BAKED_SIZE;
    const at = (x: number, y: number) =>
      this.data[wrap(y) * BAKED_SIZE + wrap(x)];
    return lerp(
      lerp(at(x0, y0), at(x0 + 1, y0), fx),
      lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx),
      fy
    );
  }
}

const SUPPORTED_HEADERS = [
  'IESNA:LM-63-1986',
  'IESNA:LM-63-1991',
  'IESNA91',
  'IESNA:LM-63-1995',
  'IESNA:LM-63-2002',
  'ERCO Leuchten'
];

export function parseIESProfile(source: string, profileName = 'IES profile') {
  const lines = source.replace(/\r/g, '').split('\n');
  const header = lines[0]?.trim();
  if (!SUPPORTED_HEADERS.includes(header)) {
    throw new IESParseError(
      `unsupported LM-63 header "${header || '<empty>'}"`,
      profileName
    );
  }
  const tiltIndex = lines.findIndex((line) => line.trim().startsWith('TILT='));
  if (tiltIndex < 0) throw new IESParseError('missing TILT record', profileName);
  if (lines[tiltIndex].trim() !== 'TILT=NONE') {
    throw new IESParseError('only TILT=NONE is supported', profileName);
  }
  const tokens = lines
    .slice(tiltIndex + 1)
    .join(' ')
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  const values = tokens.map((token) => Number(token));
  const invalid = values.findIndex((value) => !Number.isFinite(value));
  if (invalid >= 0) {
    throw new IESParseError(
      `invalid numeric token "${tokens[invalid]}"`,
      profileName
    );
  }
  if (values.length < 13) {
    throw new IESParseError('incomplete numeric header', profileName);
  }
  const verticalCount = values[3];
  const horizontalCount = values[4];
  if (
    !Number.isInteger(verticalCount) ||
    verticalCount < 1 ||
    !Number.isInteger(horizontalCount) ||
    horizontalCount < 1
  ) {
    throw new IESParseError('angle counts must be positive integers', profileName);
  }
  if (values[5] !== 1) {
    throw new IESParseError('only Type C photometry is supported', profileName);
  }
  const expected =
    13 + verticalCount + horizontalCount + verticalCount * horizontalCount;
  if (values.length !== expected) {
    throw new IESParseError(
      `numeric data size is ${values.length}, expected ${expected}`,
      profileName
    );
  }
  const verticalAngles = values.slice(13, 13 + verticalCount);
  const horizontalAngles = values.slice(
    13 + verticalCount,
    13 + verticalCount + horizontalCount
  );
  const candelaValues = values.slice(13 + verticalCount + horizontalCount);
  const validateAngles = (angles: number[], label: string, max: number) => {
    if (
      angles.some(
        (v, i) => v < 0 || v > max || (i > 0 && v <= angles[i - 1])
      )
    ) {
      throw new IESParseError(
        `${label} angles must be finite, strictly increasing, and within 0..${max}`,
        profileName
      );
    }
  };
  validateAngles(verticalAngles, 'vertical', 180);
  validateAngles(horizontalAngles, 'horizontal', 360);
  if (verticalAngles[0] !== 0 || horizontalAngles[0] !== 0) {
    throw new IESParseError(
      'Type C angle tables must begin at 0 degrees',
      profileName
    );
  }
  if (candelaValues.some((v) => v < 0)) {
    throw new IESParseError('candela values must be non-negative', profileName);
  }
  const peakCandela = Math.max(...candelaValues);
  if (!(peakCandela > 0)) {
    throw new IESParseError(
      'candela peak must be greater than zero',
      profileName
    );
  }

  const profile = new IESProfile(
    profileName,
    verticalAngles,
    horizontalAngles,
    candelaValues,
    peakCandela,
    new Float32Array(BAKED_SIZE * BAKED_SIZE)
  );
  for (let y = 0; y < BAKED_SIZE; y++) {
    const horizontal = (y * 360) / BAKED_SIZE - 180;
    for (let x = 0; x < BAKED_SIZE; x++) {
      profile.data[y * BAKED_SIZE + x] = profile.evaluateAngles(
        (x * 180) / BAKED_SIZE,
        horizontal
      );
    }
  }
  return profile;
}
