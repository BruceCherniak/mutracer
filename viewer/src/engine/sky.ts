/**
 * Physically based clear sky for the viewer's default environment.
 *
 * Integrates single scattering through a spherical Rayleigh, Mie and ozone
 * atmosphere and adds multiple scattering with the isotropic approximation
 * of Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering
 * Technique" (EGSR 2020). Coefficients are the Earth defaults from Bruneton,
 * "Precomputed Atmospheric Scattering" (2008/2017). Formulas only; no code is
 * taken from either reference.
 *
 * The sky depends only on view elevation and azimuth relative to the sun, so
 * it is integrated into a small table and then expanded to the full map.
 */

export interface SkyData {
  data: Float32Array;
  width: number;
  height: number;
}

export interface PhysicalSkyOptions {
  width?: number;
  height?: number;
  /** Sun elevation above the horizon, in degrees. */
  sunElevation?: number;
  /** Sun azimuth around +Y, in degrees. */
  sunAzimuth?: number;
  /** Apparent sun radius, in degrees. Larger than the real 0.27° so the disk spans several texels. */
  sunRadius?: number;
  /** Aerosol density relative to a very clean atmosphere (optical depth about 0.005). */
  turbidity?: number;
  /** Linear ground albedo. */
  groundAlbedo?: [number, number, number];
  /** Sun plus sky irradiance on a horizontal plane with the sun at 33°; lower suns are dimmer. */
  illuminance?: number;
}

type Vec3 = [number, number, number];

const EARTH_RADIUS = 6360e3;
const TOP_RADIUS = 6460e3;
const CAMERA_ALTITUDE = 200;
const RAYLEIGH_SCATTERING: Vec3 = [5.802e-6, 13.558e-6, 33.1e-6];
const RAYLEIGH_HEIGHT = 8000;
const MIE_SCATTERING = 3.996e-6;
const MIE_EXTINCTION = 4.44e-6;
const MIE_HEIGHT = 1200;
const MIE_G = 0.8;
const OZONE_ABSORPTION: Vec3 = [0.65e-6, 1.881e-6, 0.085e-6];

// Table resolution: view elevation (denser at the horizon) by relative azimuth.
const ELEVATIONS = 192;
const AZIMUTHS = 96;
const VIEW_STEPS = 40;
const MS_ALTITUDES = 32;
const MS_DIRECTIONS = 64;
const MS_STEPS = 20;
const T_ALTITUDES = 64;
const T_ANGLES = 256;
// Horizontal illuminance of this atmosphere for unit solar irradiance and a 33° sun.
const REFERENCE_ILLUMINANCE = 0.488;

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

class Atmosphere {
  private readonly transmittance = new Float32Array(T_ALTITUDES * T_ANGLES * 3);
  private readonly multiple = new Float32Array(MS_ALTITUDES * 3);
  private readonly mie: number;

  constructor(readonly sun: Vec3, turbidity: number, readonly albedo: Vec3) {
    this.mie = turbidity;
    for (let i = 0; i < T_ALTITUDES; i++) {
      const r = EARTH_RADIUS + altitudeAt(i / (T_ALTITUDES - 1));
      for (let j = 0; j < T_ANGLES; j++) {
        const t = this.integrateTransmittance(r, (j / (T_ANGLES - 1)) * 2 - 1);
        this.transmittance.set(t, (i * T_ANGLES + j) * 3);
      }
    }
    this.integrateMultipleScattering();
  }

  /** Scattering, extinction for one channel and density terms at a radius. */
  private medium(r: number) {
    const h = Math.max(r - EARTH_RADIUS, 0);
    const rayleigh = Math.exp(-h / RAYLEIGH_HEIGHT);
    const mie = Math.exp(-h / MIE_HEIGHT) * this.mie;
    const ozone = Math.max(0, 1 - Math.abs(h - 25000) / 15000);
    return { rayleigh, mie, ozone };
  }

  private extinction(r: number): Vec3 {
    const { rayleigh, mie, ozone } = this.medium(r);
    return [0, 1, 2].map((c) => RAYLEIGH_SCATTERING[c] * rayleigh + MIE_EXTINCTION * mie + OZONE_ABSORPTION[c] * ozone) as Vec3;
  }

  private integrateTransmittance(r: number, mu: number): Vec3 {
    if (hitsGround(r, mu)) return [0, 0, 0];
    const length = distanceToTop(r, mu);
    const depth: Vec3 = [0, 0, 0];
    const steps = 48;
    for (let i = 0; i < steps; i++) {
      const t = ((i + 0.5) / steps) * length;
      const e = this.extinction(radiusAt(r, mu, t));
      for (let c = 0; c < 3; c++) depth[c] += e[c] * (length / steps);
    }
    return depth.map((d) => Math.exp(-d)) as Vec3;
  }

  /** Transmittance from a point toward the top of the atmosphere. */
  transmittanceTo(r: number, mu: number): Vec3 {
    const u = altitudeCoord(r - EARTH_RADIUS) * (T_ALTITUDES - 1);
    const v = ((Math.min(Math.max(mu, -1), 1) + 1) / 2) * (T_ANGLES - 1);
    return bilinear(this.transmittance, T_ANGLES, u, v);
  }

  private multipleAt(r: number): Vec3 {
    const u = altitudeCoord(r - EARTH_RADIUS) * (MS_ALTITUDES - 1);
    const i = Math.min(Math.floor(u), MS_ALTITUDES - 2), f = u - i;
    return [0, 1, 2].map((c) => this.multiple[i * 3 + c] * (1 - f) + this.multiple[(i + 1) * 3 + c] * f) as Vec3;
  }

  /** Isotropic second-order radiance and its geometric series (Hillaire 2020, eq. 5-9). */
  private integrateMultipleScattering() {
    for (let a = 0; a < MS_ALTITUDES; a++) {
      const r = EARTH_RADIUS + altitudeAt(a / (MS_ALTITUDES - 1));
      const second: Vec3 = [0, 0, 0];
      const transfer: Vec3 = [0, 0, 0];
      for (let d = 0; d < MS_DIRECTIONS; d++) {
        // Fibonacci sphere; the planet is symmetric about the local vertical.
        const mu = 1 - (2 * (d + 0.5)) / MS_DIRECTIONS;
        const phi = d * Math.PI * (3 - Math.sqrt(5));
        const s = Math.sqrt(1 - mu * mu);
        const dir: Vec3 = [s * Math.cos(phi), mu, s * Math.sin(phi)];
        const { radiance, throughput } = this.march([0, r, 0], dir, MS_STEPS, false);
        for (let c = 0; c < 3; c++) {
          second[c] += radiance[c] / MS_DIRECTIONS;
          transfer[c] += throughput[c] / MS_DIRECTIONS;
        }
      }
      for (let c = 0; c < 3; c++) this.multiple[a * 3 + c] = second[c] / (1 - transfer[c]);
    }
  }

  /**
   * Radiance arriving at `origin` from direction `dir`, for unit solar
   * irradiance. Without `full` it uses isotropic phase and no multiple
   * scattering, and also returns the scattered fraction for the series.
   */
  march(origin: Vec3, dir: Vec3, steps: number, full: boolean, skyIrradiance?: Vec3) {
    const r = Math.hypot(...origin);
    const mu = dot(origin, dir) / r;
    const ground = hitsGround(r, mu);
    const length = ground ? distanceToGround(r, mu) : distanceToTop(r, mu);
    const nu = dot(dir, this.sun);
    const rayleighPhase = full ? (3 / (16 * Math.PI)) * (1 + nu * nu) : 1 / (4 * Math.PI);
    const miePhase = full ? cornetteShanks(nu) : 1 / (4 * Math.PI);
    const radiance: Vec3 = [0, 0, 0];
    const throughput: Vec3 = [0, 0, 0];
    const view: Vec3 = [1, 1, 1];
    let previous = 0;
    for (let i = 0; i < steps; i++) {
      // Quadratic spacing keeps long horizon rays resolved near the camera.
      const next = length * ((i + 1) / steps) ** 2;
      const dt = next - previous;
      const t = (previous + next) / 2;
      previous = next;
      const p: Vec3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
      const pr = Math.hypot(...p);
      const { rayleigh, mie } = this.medium(pr);
      const extinction = this.extinction(pr);
      const sunT = this.transmittanceTo(pr, dot(p, this.sun) / pr);
      const ms = full ? this.multipleAt(pr) : [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const scatterR = RAYLEIGH_SCATTERING[c] * rayleigh;
        const scatterM = MIE_SCATTERING * mie;
        const source = sunT[c] * (scatterR * rayleighPhase + scatterM * miePhase) + (scatterR + scatterM) * ms[c];
        // Analytic integration of the source over the segment's extinction.
        const segment = Math.exp(-extinction[c] * dt);
        const weight = extinction[c] > 0 ? (1 - segment) / extinction[c] : dt;
        radiance[c] += view[c] * source * weight;
        throughput[c] += view[c] * (scatterR + scatterM) * weight;
        view[c] *= segment;
      }
    }
    if (ground) {
      const p: Vec3 = [origin[0] + dir[0] * length, origin[1] + dir[1] * length, origin[2] + dir[2] * length];
      const pr = Math.hypot(...p);
      const cosSun = dot(p, this.sun) / pr;
      const sunT = this.transmittanceTo(pr, cosSun);
      for (let c = 0; c < 3; c++) {
        const irradiance = sunT[c] * Math.max(cosSun, 0) + (skyIrradiance?.[c] ?? 0);
        radiance[c] += view[c] * (this.albedo[c] / Math.PI) * irradiance;
      }
    }
    return { radiance, throughput, transmittance: view };
  }
}

/** Clear sky at a local solar time, in hours. */
export function createSkyAt(hours = DEFAULT_SKY_TIME, width = 1024, height = 512): SkyData {
  const { elevation, azimuth } = sunPosition(hours);
  return createPhysicalSky({ width, height, sunElevation: elevation, sunAzimuth: azimuth });
}

/** Builds an equirectangular map with v = 0 at +Y and u following atan2(-z, -x). */
export function createPhysicalSky({
  width = 1024,
  height = 512,
  sunElevation = 33,
  sunAzimuth = 50,
  sunRadius = 0.4,
  turbidity = 5,
  groundAlbedo = [0.2, 0.18, 0.15],
  illuminance = Math.PI
}: PhysicalSkyOptions = {}): SkyData {
  const elevation = deg(sunElevation);
  const azimuth = deg(sunAzimuth);
  const sun: Vec3 = [Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth)];
  // Atmosphere frame: the sun's azimuth is +X so tables only need |Δφ|.
  const localSun: Vec3 = [Math.cos(elevation), Math.sin(elevation), 0];
  const atmosphere = new Atmosphere(localSun, turbidity, groundAlbedo);
  const origin: Vec3 = [0, EARTH_RADIUS + CAMERA_ALTITUDE, 0];
  const table = new Float32Array(ELEVATIONS * AZIMUTHS * 3);
  const fill = (row: number, skyIrradiance?: Vec3) => {
    const e = elevationAt(row);
    for (let col = 0; col < AZIMUTHS; col++) {
      const phi = (col / (AZIMUTHS - 1)) * Math.PI;
      const dir: Vec3 = [Math.cos(e) * Math.cos(phi), Math.sin(e), Math.cos(e) * Math.sin(phi)];
      table.set(atmosphere.march(origin, dir, VIEW_STEPS, true, skyIrradiance).radiance, (row * AZIMUTHS + col) * 3);
    }
  };
  // Upper rows first: the ground below is lit by that sky.
  const horizon = ELEVATIONS / 2;
  for (let row = horizon; row < ELEVATIONS; row++) fill(row);
  const sky = skyIrradiance(table);
  for (let row = 0; row < horizon; row++) fill(row, sky);

  const sunTransmittance = atmosphere.transmittanceTo(EARTH_RADIUS + CAMERA_ALTITUDE, Math.sin(elevation));
  const data = new Float32Array(width * height * 4);
  const cosRadius = Math.cos(deg(sunRadius));
  const disk = new Float32Array(width * height);
  let diskIrradiance = 0;
  for (let row = 0; row < height; row++) {
    const theta = ((row + 0.5) / height) * Math.PI;
    const texelSolidAngle = (2 * Math.PI / width) * (Math.PI / height) * Math.sin(theta);
    for (let col = 0; col < width; col++) {
      const phi = ((col + 0.5) / width) * 2 * Math.PI;
      const dir = equirectDirection(theta, phi);
      const relative = Math.abs(wrapAngle(Math.atan2(dir[2], dir[0]) - azimuth));
      const radiance = sampleTable(table, Math.asin(Math.min(Math.max(dir[1], -1), 1)), relative);
      const o = (row * width + col) * 4;
      data.set(radiance, o);
      data[o + 3] = 1;
      // Supersample texels near the sun for an anti-aliased, limb-darkened disk.
      if (dot(dir, sun) > Math.cos(deg(sunRadius) + 2 * Math.PI / height * 2)) {
        let coverage = 0;
        const n = 8;
        for (let sy = 0; sy < n; sy++) {
          for (let sx = 0; sx < n; sx++) {
            const d = equirectDirection(((row + (sy + 0.5) / n) / height) * Math.PI, ((col + (sx + 0.5) / n) / width) * 2 * Math.PI);
            const c = dot(d, sun);
            if (c <= cosRadius) continue;
            const limb = Math.sqrt(Math.max(0, 1 - (Math.acos(Math.min(c, 1)) / deg(sunRadius)) ** 2));
            coverage += (1 - 0.6 * (1 - limb)) / (n * n);
          }
        }
        disk[row * width + col] = coverage;
        diskIrradiance += coverage * texelSolidAngle;
      }
    }
  }
  // The disk carries the transmitted unit solar irradiance, independent of its size.
  if (diskIrradiance > 0) {
    for (let i = 0; i < disk.length; i++) {
      if (!disk[i]) continue;
      for (let c = 0; c < 3; c++) data[i * 4 + c] += (disk[i] / diskIrradiance) * sunTransmittance[c];
    }
  }
  const horizontal = luminance(sky) + luminance(sunTransmittance) * Math.sin(elevation);
  // Half of the change from the reference is compensated, like a camera's
  // partial auto-exposure: low suns stay readable but still look dimmer.
  const scale = illuminance / Math.sqrt(Math.max(horizontal, REFERENCE_ILLUMINANCE * 1e-3) * REFERENCE_ILLUMINANCE);
  for (let i = 0; i < data.length; i++) if (i % 4 !== 3) data[i] *= scale;
  return { data, width, height };
}

function skyIrradiance(table: Float32Array): Vec3 {
  const result: Vec3 = [0, 0, 0];
  const rows = 256, cols = 64;
  for (let i = 0; i < rows; i++) {
    const e = ((i + 0.5) / rows) * (Math.PI / 2);
    for (let j = 0; j < cols; j++) {
      const phi = ((j + 0.5) / cols) * Math.PI;
      const radiance = sampleTable(table, e, phi);
      // Mirror-symmetric in azimuth: 2 × half-circle, dω = cos e de dφ, cosine = sin e.
      const weight = 2 * Math.sin(e) * Math.cos(e) * (Math.PI / 2 / rows) * (Math.PI / cols);
      for (let c = 0; c < 3; c++) result[c] += radiance[c] * weight;
    }
  }
  return result;
}

function sampleTable(table: Float32Array, elevation: number, relativeAzimuth: number): Vec3 {
  const u = elevationCoord(elevation) * (ELEVATIONS - 1);
  const v = (relativeAzimuth / Math.PI) * (AZIMUTHS - 1);
  return bilinear(table, AZIMUTHS, u, v);
}

/** Elevation rows are spaced by sqrt so the horizon band gets most of them. */
function elevationAt(row: number) {
  const x = (row / (ELEVATIONS - 1)) * 2 - 1;
  return Math.sign(x) * x * x * (Math.PI / 2);
}

function elevationCoord(elevation: number) {
  const x = Math.sign(elevation) * Math.sqrt(Math.abs(elevation) / (Math.PI / 2));
  return Math.min(Math.max((x + 1) / 2, 0), 1);
}

function altitudeAt(x: number) {
  return x * x * (TOP_RADIUS - EARTH_RADIUS);
}

function altitudeCoord(altitude: number) {
  return Math.sqrt(Math.min(Math.max(altitude / (TOP_RADIUS - EARTH_RADIUS), 0), 1));
}

function bilinear(table: Float32Array, columns: number, u: number, v: number): Vec3 {
  const rows = table.length / 3 / columns;
  const i = Math.min(Math.max(Math.floor(u), 0), rows - 2), fi = Math.min(Math.max(u - i, 0), 1);
  const j = Math.min(Math.max(Math.floor(v), 0), columns - 2), fj = Math.min(Math.max(v - j, 0), 1);
  const out: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = table[(i * columns + j) * 3 + c], b = table[(i * columns + j + 1) * 3 + c];
    const d = table[((i + 1) * columns + j) * 3 + c], e = table[((i + 1) * columns + j + 1) * 3 + c];
    out[c] = (a * (1 - fj) + b * fj) * (1 - fi) + (d * (1 - fj) + e * fj) * fi;
  }
  return out;
}

function hitsGround(r: number, mu: number) {
  return mu < 0 && r * r * (mu * mu - 1) + EARTH_RADIUS * EARTH_RADIUS >= 0;
}

function distanceToGround(r: number, mu: number) {
  return Math.max(-r * mu - Math.sqrt(Math.max(r * r * (mu * mu - 1) + EARTH_RADIUS * EARTH_RADIUS, 0)), 0);
}

function distanceToTop(r: number, mu: number) {
  return Math.max(-r * mu + Math.sqrt(Math.max(r * r * (mu * mu - 1) + TOP_RADIUS * TOP_RADIUS, 0)), 0);
}

function radiusAt(r: number, mu: number, t: number) {
  return Math.sqrt(t * t + 2 * r * mu * t + r * r);
}

function cornetteShanks(nu: number) {
  const g2 = MIE_G * MIE_G;
  return (3 / (8 * Math.PI)) * ((1 - g2) * (1 + nu * nu)) / ((2 + g2) * Math.pow(1 + g2 - 2 * MIE_G * nu, 1.5));
}

function equirectDirection(theta: number, phi: number): Vec3 {
  return [-Math.sin(theta) * Math.cos(phi), Math.cos(theta), -Math.sin(theta) * Math.sin(phi)];
}

function wrapAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function luminance(c: Vec3) {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function deg(d: number) {
  return (d * Math.PI) / 180;
}
