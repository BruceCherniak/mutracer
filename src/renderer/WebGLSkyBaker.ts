/**
 * Physically based clear sky for the viewer's default environment, baked on
 * the GPU into an equirectangular radiance map.
 *
 * Integrates single scattering through a spherical Rayleigh, Mie and ozone
 * atmosphere and adds multiple scattering with the isotropic approximation
 * of Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering
 * Technique" (EGSR 2020). Coefficients are the Earth defaults from Bruneton,
 * "Precomputed Atmospheric Scattering" (2008/2017). Formulas only; no code is
 * taken from either reference.
 *
 * WebGL 2 passes: transmittance table, multiple scattering by altitude, a
 * sky-view table by elevation and azimuth relative to the sun, irradiance and
 * exposure, then the map itself with an anti-aliased, limb-darkened sun disk.
 * Distances are in kilometers so float32 keeps the horizon precise.
 */

import { sunPosition } from '../scene/skyParameters.js';
import { SUN_RADIUS, TURBIDITY, GROUND_ALBEDO, ILLUMINANCE, REFERENCE_ILLUMINANCE } from './skyModel.js';

export interface SkyData { data: Float32Array; width: number; height: number; }

const T_SIZE = [256, 64] as const; // cos(view zenith) × altitude
const MS_SIZE = [32, 1] as const; // altitude
const SV_SIZE = [96, 192] as const; // relative azimuth × elevation

const COMMON = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 color;
const float PI = 3.14159265358979;
const float R_GROUND = 6360.0;
const float R_TOP = 6460.0;
const float CAMERA_ALTITUDE = 0.2;
const vec3 RAYLEIGH = vec3(5.802e-3, 13.558e-3, 33.1e-3);
const float MIE_SCATTERING = 3.996e-3;
const float MIE_EXTINCTION = 4.44e-3;
const float MIE_G = 0.8;
const vec3 OZONE = vec3(0.65e-3, 1.881e-3, 0.085e-3);
const ivec2 T_SIZE = ivec2(${T_SIZE[0]}, ${T_SIZE[1]});
const int MS_ALTITUDES = ${MS_SIZE[0]};
const ivec2 SV_SIZE = ivec2(${SV_SIZE[0]}, ${SV_SIZE[1]});
uniform vec3 uSun; // atmosphere frame: the sun's azimuth is +X
uniform float uTurbidity;
uniform vec3 uAlbedo;

// (R - r)(R + r) + r²μ² avoids cancelling planet-sized squares.
float discriminant(float r, float mu, float radius) { return (radius - r) * (radius + r) + r * r * mu * mu; }
bool hitsGround(float r, float mu) { return mu < 0.0 && discriminant(r, mu, R_GROUND) >= 0.0; }
float distanceToGround(float r, float mu) { return max(-r * mu - sqrt(max(discriminant(r, mu, R_GROUND), 0.0)), 0.0); }
float distanceToTop(float r, float mu) { return max(-r * mu + sqrt(max(discriminant(r, mu, R_TOP), 0.0)), 0.0); }

/** Rayleigh, Mie and ozone densities. */
vec3 densities(float r) {
  float h = max(r - R_GROUND, 0.0);
  return vec3(exp(-h / 8.0), exp(-h / 1.2) * uTurbidity, max(0.0, 1.0 - abs(h - 25.0) / 15.0));
}
vec3 extinction(vec3 d) { return RAYLEIGH * d.x + MIE_EXTINCTION * d.y + OZONE * d.z; }

float altitudeAt(float x) { return x * x * (R_TOP - R_GROUND); }
float altitudeCoord(float h) { return sqrt(clamp(h / (R_TOP - R_GROUND), 0.0, 1.0)); }

/** Bilinear lookup in texel-index space; float textures need not be filterable. */
vec3 fetchLinear(sampler2D table, vec2 p) {
  ivec2 size = textureSize(table, 0);
  vec2 q = clamp(p, vec2(0.0), vec2(size - 1));
  ivec2 i = min(ivec2(floor(q)), max(size - 2, ivec2(0)));
  vec2 f = clamp(q - vec2(i), 0.0, 1.0);
  ivec2 j = min(i + 1, size - 1);
  vec3 a = texelFetch(table, i, 0).rgb, b = texelFetch(table, ivec2(j.x, i.y), 0).rgb;
  vec3 c = texelFetch(table, ivec2(i.x, j.y), 0).rgb, d = texelFetch(table, j, 0).rgb;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

const ATMOSPHERE = /* glsl */ `
uniform sampler2D uTransmittance;
uniform sampler2D uMultiple;
uniform bool uFull;
uniform vec3 uSkyIrradiance;

/** Transmittance from a point toward the top of the atmosphere. */
vec3 transmittanceTo(float r, float mu) {
  return fetchLinear(uTransmittance, vec2((clamp(mu, -1.0, 1.0) + 1.0) * 0.5 * float(T_SIZE.x - 1),
    altitudeCoord(r - R_GROUND) * float(T_SIZE.y - 1)));
}

float cornetteShanks(float nu) {
  float g2 = MIE_G * MIE_G;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + nu * nu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * MIE_G * nu, 1.5));
}

/**
 * Radiance arriving at origin from dir, for unit solar irradiance. Without
 * uFull it uses isotropic phase and no multiple scattering, and returns the
 * scattered fraction for the multiple-scattering series.
 */
void march(vec3 origin, vec3 dir, int steps, out vec3 radiance, out vec3 throughput) {
  float r = length(origin);
  float mu = dot(origin, dir) / r;
  bool ground = hitsGround(r, mu);
  float len = ground ? distanceToGround(r, mu) : distanceToTop(r, mu);
  float nu = dot(dir, uSun);
  float rayleighPhase = uFull ? 3.0 / (16.0 * PI) * (1.0 + nu * nu) : 1.0 / (4.0 * PI);
  float miePhase = uFull ? cornetteShanks(nu) : 1.0 / (4.0 * PI);
  radiance = vec3(0.0);
  throughput = vec3(0.0);
  vec3 view = vec3(1.0);
  float previous = 0.0;
  for (int i = 0; i < steps; i++) {
    // Quadratic spacing keeps long horizon rays resolved near the camera.
    float s = float(i + 1) / float(steps);
    float next = len * s * s;
    float dt = next - previous;
    vec3 p = origin + dir * (0.5 * (previous + next));
    previous = next;
    float pr = length(p);
    vec3 d = densities(pr);
    vec3 e = extinction(d);
    vec3 sunT = transmittanceTo(pr, dot(p, uSun) / pr);
    vec3 scatterR = RAYLEIGH * d.x;
    float scatterM = MIE_SCATTERING * d.y;
    vec3 ms = vec3(0.0);
    if (uFull) {
      float x = altitudeCoord(pr - R_GROUND) * float(MS_ALTITUDES - 1);
      ms = fetchLinear(uMultiple, vec2(x, 0.0));
    }
    vec3 source = sunT * (scatterR * rayleighPhase + scatterM * miePhase) + (scatterR + scatterM) * ms;
    // Analytic integration of the source over the segment's extinction.
    vec3 segment = exp(-e * dt);
    vec3 weight = (1.0 - segment) / max(e, vec3(1e-9));
    radiance += view * source * weight;
    throughput += view * (scatterR + scatterM) * weight;
    view *= segment;
  }
  if (ground) {
    vec3 p = origin + dir * len;
    float pr = length(p);
    float cosSun = dot(p, uSun) / pr;
    vec3 irradiance = transmittanceTo(pr, cosSun) * max(cosSun, 0.0) + uSkyIrradiance;
    radiance += view * uAlbedo / PI * irradiance;
  }
}
`;

const TRANSMITTANCE = COMMON + /* glsl */ `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float mu = float(p.x) / float(T_SIZE.x - 1) * 2.0 - 1.0;
  float r = R_GROUND + altitudeAt(float(p.y) / float(T_SIZE.y - 1));
  if (hitsGround(r, mu)) { color = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float len = distanceToTop(r, mu);
  vec3 depth = vec3(0.0);
  const int STEPS = 48;
  for (int i = 0; i < STEPS; i++) {
    float t = (float(i) + 0.5) / float(STEPS) * len;
    depth += extinction(densities(sqrt(t * t + 2.0 * r * mu * t + r * r))) * (len / float(STEPS));
  }
  color = vec4(exp(-depth), 1.0);
}
`;

const MULTIPLE = COMMON + ATMOSPHERE + /* glsl */ `
void main() {
  float r = R_GROUND + altitudeAt(floor(gl_FragCoord.x) / float(MS_ALTITUDES - 1));
  const int DIRECTIONS = 64;
  vec3 second = vec3(0.0), transfer = vec3(0.0);
  for (int i = 0; i < DIRECTIONS; i++) {
    // Fibonacci sphere; the planet is symmetric about the local vertical.
    float mu = 1.0 - 2.0 * (float(i) + 0.5) / float(DIRECTIONS);
    float phi = float(i) * PI * (3.0 - sqrt(5.0));
    float s = sqrt(1.0 - mu * mu);
    vec3 radiance, throughput;
    march(vec3(0.0, r, 0.0), vec3(s * cos(phi), mu, s * sin(phi)), 20, radiance, throughput);
    second += radiance / float(DIRECTIONS);
    transfer += throughput / float(DIRECTIONS);
  }
  color = vec4(second / (1.0 - transfer), 1.0);
}
`;

// Elevation rows are spaced by the square root so the horizon gets most of them.
const ELEVATION_MAPPING = /* glsl */ `
float elevationAt(float row) {
  float x = row / float(SV_SIZE.y - 1) * 2.0 - 1.0;
  return sign(x) * x * x * (PI / 2.0);
}
float elevationCoord(float e) {
  float x = sign(e) * sqrt(abs(e) / (PI / 2.0));
  return clamp((x + 1.0) * 0.5, 0.0, 1.0) * float(SV_SIZE.y - 1);
}
`;

const SKY_VIEW = COMMON + ATMOSPHERE + ELEVATION_MAPPING + /* glsl */ `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float e = elevationAt(float(p.y));
  float phi = float(p.x) / float(SV_SIZE.x - 1) * PI;
  vec3 radiance, throughput;
  march(vec3(0.0, R_GROUND + CAMERA_ALTITUDE, 0.0), vec3(cos(e) * cos(phi), sin(e), cos(e) * sin(phi)), 40, radiance, throughput);
  color = vec4(radiance, 1.0);
}
`;

/** Texel 0: sky irradiance on the ground. Texel 1: sun transmittance at the camera and the exposure scale. */
const IRRADIANCE = COMMON + ELEVATION_MAPPING + /* glsl */ `
uniform sampler2D uTransmittance;
uniform sampler2D uSkyView;
void main() {
  vec3 sky = vec3(0.0);
  const int ROWS = 128, COLUMNS = 48;
  for (int i = 0; i < ROWS; i++) {
    float e = (float(i) + 0.5) / float(ROWS) * (PI / 2.0);
    // Mirror-symmetric in azimuth: 2 × half circle, dω = cos e de dφ, cosine = sin e.
    float weight = 2.0 * sin(e) * cos(e) * (PI / 2.0 / float(ROWS)) * (PI / float(COLUMNS));
    for (int j = 0; j < COLUMNS; j++) {
      float phi = (float(j) + 0.5) / float(COLUMNS) * PI;
      sky += fetchLinear(uSkyView, vec2(phi / PI * float(SV_SIZE.x - 1), elevationCoord(e))) * weight;
    }
  }
  if (int(gl_FragCoord.x) == 0) { color = vec4(sky, 1.0); return; }
  float r = R_GROUND + CAMERA_ALTITUDE;
  vec3 sunT = fetchLinear(uTransmittance, vec2((uSun.y + 1.0) * 0.5 * float(T_SIZE.x - 1), altitudeCoord(CAMERA_ALTITUDE) * float(T_SIZE.y - 1)));
  vec3 luma = vec3(0.2126, 0.7152, 0.0722);
  float horizontal = dot(sky, luma) + dot(sunT, luma) * max(uSun.y, 0.0);
  // Half of the change from the reference is compensated, like a camera's
  // partial auto-exposure: low suns stay readable but still look dimmer.
  const float REFERENCE = ${REFERENCE_ILLUMINANCE};
  float scale = ${ILLUMINANCE} / sqrt(max(horizontal, REFERENCE * 1e-3) * REFERENCE);
  color = vec4(sunT, scale);
}
`;

const MAP = COMMON + ELEVATION_MAPPING + /* glsl */ `
uniform sampler2D uSkyView;
uniform sampler2D uIrradiance;
uniform vec2 uSize;
uniform float uAzimuth;
uniform vec3 uSunWorld;
uniform float uSunRadius;

// v = 0 is +Y and u follows atan2(-z, -x), as MuTracer reads equirect maps.
vec3 mapDirection(vec2 texel) {
  float theta = texel.y / uSize.y * PI;
  float phi = texel.x / uSize.x * 2.0 * PI;
  return vec3(-sin(theta) * cos(phi), cos(theta), -sin(theta) * sin(phi));
}

void main() {
  vec3 dir = mapDirection(gl_FragCoord.xy);
  float relative = abs(atan(dir.z, dir.x) - uAzimuth);
  relative = min(mod(relative, 2.0 * PI), 2.0 * PI - mod(relative, 2.0 * PI));
  float e = asin(clamp(dir.y, -1.0, 1.0));
  vec3 radiance = fetchLinear(uSkyView, vec2(relative / PI * float(SV_SIZE.x - 1), elevationCoord(e)));
  vec4 sun = texelFetch(uIrradiance, ivec2(1, 0), 0);
  // Supersample texels near the sun for an anti-aliased, limb-darkened disk
  // that carries the transmitted unit solar irradiance.
  float texelAngle = PI / uSize.y;
  if (acos(clamp(dot(dir, uSunWorld), -1.0, 1.0)) < uSunRadius + 3.0 * texelAngle / max(sqrt(1.0 - dir.y * dir.y), 0.05)) {
    const int N = 6;
    const float LIMB = 0.6;
    float coverage = 0.0;
    for (int y = 0; y < N; y++) for (int x = 0; x < N; x++) {
      vec3 d = mapDirection(gl_FragCoord.xy - 0.5 + (vec2(x, y) + 0.5) / float(N));
      // Chord length keeps small angles precise in float32.
      float angle = 2.0 * asin(min(length(d - uSunWorld) * 0.5, 1.0));
      float t = angle / uSunRadius;
      if (t < 1.0) coverage += 1.0 - LIMB * (1.0 - sqrt(1.0 - t * t));
    }
    float solidAngle = 2.0 * PI * (1.0 - cos(uSunRadius));
    radiance += coverage / float(N * N) / (solidAngle * (1.0 - LIMB / 3.0)) * sun.rgb;
  }
  color = vec4(radiance * sun.a, 1.0);
}
`;

const VERTEX = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

interface Target { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number }

/** Bakes skies with its own WebGL 2 context; requires float render targets. */
export class WebGLSkyBaker {
  private readonly gl: WebGL2RenderingContext;
  private readonly programs: Record<'transmittance' | 'multiple' | 'skyView' | 'irradiance' | 'map', WebGLProgram>;
  private readonly targets: Record<'transmittance' | 'multiple' | 'skyView' | 'irradiance', Target>;
  private map?: Target;

  constructor() {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('The procedural sky needs WebGL 2.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('The procedural sky needs float render targets (EXT_color_buffer_float).');
    this.gl = gl;
    gl.bindVertexArray(gl.createVertexArray());
    this.programs = {
      transmittance: this.program(TRANSMITTANCE),
      multiple: this.program(MULTIPLE),
      skyView: this.program(SKY_VIEW),
      irradiance: this.program(IRRADIANCE),
      map: this.program(MAP)
    };
    this.targets = {
      transmittance: this.target(...T_SIZE),
      multiple: this.target(...MS_SIZE),
      skyView: this.target(...SV_SIZE),
      irradiance: this.target(2, 1)
    };
  }

  /** Clear sky at a local solar time, in hours. */
  bake(hours: number, width = 2048, height = 1024): SkyData {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('The procedural sky lost its WebGL context.');
    const { elevation, azimuth } = sunPosition(hours);
    const e = deg(elevation), a = deg(azimuth);
    const shared = (program: WebGLProgram) => {
      gl.useProgram(program);
      this.uniform(program, 'uSun', (l) => gl.uniform3f(l, Math.cos(e), Math.sin(e), 0));
      this.uniform(program, 'uTurbidity', (l) => gl.uniform1f(l, TURBIDITY));
      this.uniform(program, 'uAlbedo', (l) => gl.uniform3fv(l, GROUND_ALBEDO));
      return program;
    };
    const { transmittance, multiple, skyView, irradiance } = this.targets;
    const atmosphere = (program: WebGLProgram, full: boolean, sky: number[]) => {
      shared(program);
      this.bind(program, 'uTransmittance', 0, transmittance);
      // The multiple-scattering pass declares but never reads its own target;
      // bind another texture so WebGL sees no feedback loop.
      this.bind(program, 'uMultiple', 1, full ? multiple : irradiance);
      this.uniform(program, 'uFull', (l) => gl.uniform1i(l, full ? 1 : 0));
      this.uniform(program, 'uSkyIrradiance', (l) => gl.uniform3fv(l, sky));
    };

    this.draw(shared(this.programs.transmittance), transmittance);
    atmosphere(this.programs.multiple, false, [0, 0, 0]);
    this.draw(this.programs.multiple, multiple);
    // Upward views first: the ground seen below is lit by that sky.
    atmosphere(this.programs.skyView, true, [0, 0, 0]);
    this.draw(this.programs.skyView, skyView);
    shared(this.programs.irradiance);
    this.bind(this.programs.irradiance, 'uTransmittance', 0, transmittance);
    this.bind(this.programs.irradiance, 'uSkyView', 1, skyView);
    this.draw(this.programs.irradiance, irradiance);
    const sky = this.read(irradiance).subarray(0, 3);
    atmosphere(this.programs.skyView, true, Array.from(sky));
    this.draw(this.programs.skyView, skyView);

    if (!this.map || this.map.width !== width || this.map.height !== height) {
      if (this.map) this.release(this.map);
      this.map = this.target(width, height);
    }
    const map = shared(this.programs.map);
    this.bind(map, 'uSkyView', 0, skyView);
    this.bind(map, 'uIrradiance', 1, irradiance);
    this.uniform(map, 'uSize', (l) => gl.uniform2f(l, width, height));
    this.uniform(map, 'uAzimuth', (l) => gl.uniform1f(l, a));
    this.uniform(map, 'uSunWorld', (l) => gl.uniform3f(l, Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)));
    this.uniform(map, 'uSunRadius', (l) => gl.uniform1f(l, deg(SUN_RADIUS)));
    this.draw(map, this.map);
    // Row 0 is the zenith, as in an .hdr file.
    return { data: this.read(this.map), width, height };
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private program(fragment: string) {
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Sky shader: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Sky program: ${gl.getProgramInfoLog(program)}`);
    return program;
  }

  private target(width: number, height: number): Target {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The procedural sky cannot render to float textures.');
    return { texture, framebuffer, width, height };
  }

  private release(target: Target) {
    this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture);
  }

  private uniform(program: WebGLProgram, name: string, set: (location: WebGLUniformLocation) => void) {
    const location = this.gl.getUniformLocation(program, name);
    if (location) set(location);
  }

  private bind(program: WebGLProgram, name: string, unit: number, target: Target) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    this.uniform(program, name, (l) => gl.uniform1i(l, unit));
  }

  private draw(program: WebGLProgram, target: Target) {
    const gl = this.gl;
    gl.useProgram(program);
    // A texture cannot be sampled while it is the render target.
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private read(target: Target) {
    const gl = this.gl;
    const data = new Float32Array(target.width * target.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, data);
    return data;
  }
}

function deg(d: number) {
  return (d * Math.PI) / 180;
}
