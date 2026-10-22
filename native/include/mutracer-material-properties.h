#ifndef MUTRACER_MATERIAL_PROPERTIES_H
#define MUTRACER_MATERIAL_PROPERTIES_H
/* Material extension entries: four uint32 words {id, x, y, z}. Float/color/vec2
 * payloads contain f32 bits; bool/enum/texture payloads contain u32. Unused words
 * must be zero. Texture UINT32_MAX clears a slot. Each ID appears at most once.
 * Omitted properties keep the basic material descriptor's value/default.
 * Use OpenPBR's documented value ranges; numeric payloads must be finite.
 */
enum mt_material_property {
  MT_MAT_BASE_WEIGHT = 1, /* float */
  MT_MAT_BASE_COLOR = 2, /* color */
  MT_MAT_BASE_DIFFUSE_ROUGHNESS = 3, /* float */
  MT_MAT_BASE_METALNESS = 4, /* float */
  MT_MAT_SPECULAR_WEIGHT = 5, /* float */
  MT_MAT_SPECULAR_COLOR = 6, /* color */
  MT_MAT_SPECULAR_ROUGHNESS = 7, /* float */
  MT_MAT_SPECULAR_IOR = 8, /* float */
  MT_MAT_SPECULAR_ANISOTROPY = 9, /* float */
  MT_MAT_TRANSMISSION_WEIGHT = 10, /* float */
  MT_MAT_TRANSMISSION_COLOR = 11, /* color */
  MT_MAT_TRANSMISSION_DEPTH = 12, /* float */
  MT_MAT_TRANSMISSION_SCATTER = 13, /* color */
  MT_MAT_TRANSMISSION_SCATTER_ANISOTROPY = 14, /* float */
  MT_MAT_TRANSMISSION_DISPERSION_SCALE = 15, /* float */
  MT_MAT_TRANSMISSION_DISPERSION_ABBE_NUMBER = 16, /* float */
  MT_MAT_SUBSURFACE_WEIGHT = 17, /* float */
  MT_MAT_SUBSURFACE_COLOR = 18, /* color */
  MT_MAT_SUBSURFACE_RADIUS = 19, /* float */
  MT_MAT_SUBSURFACE_RADIUS_SCALE = 20, /* color */
  MT_MAT_SUBSURFACE_ANISOTROPY = 21, /* float */
  MT_MAT_FUZZ_WEIGHT = 22, /* float */
  MT_MAT_FUZZ_COLOR = 23, /* color */
  MT_MAT_FUZZ_ROUGHNESS = 24, /* float */
  MT_MAT_COAT_WEIGHT = 25, /* float */
  MT_MAT_COAT_COLOR = 26, /* color */
  MT_MAT_COAT_ROUGHNESS = 27, /* float */
  MT_MAT_COAT_ANISOTROPY = 28, /* float */
  MT_MAT_COAT_IOR = 29, /* float */
  MT_MAT_COAT_DARKENING = 30, /* float */
  MT_MAT_THIN_FILM_WEIGHT = 31, /* float */
  MT_MAT_THIN_FILM_THICKNESS = 32, /* float */
  MT_MAT_THIN_FILM_IOR = 33, /* float */
  MT_MAT_EMISSION_COLOR = 34, /* color */
  MT_MAT_EMISSION_LUMINANCE = 35, /* float */
  MT_MAT_OPACITY = 36, /* float */
  MT_MAT_THIN_WALLED = 37, /* bool */
  MT_MAT_DOUBLE_SIDED = 38, /* bool */
  MT_MAT_MAP = 39, /* texture */
  MT_MAT_ALPHA_MAP = 40, /* texture */
  MT_MAT_ALPHA_MODE = 41, /* enum: 0=auto, 1=opaque, 2=mask, 3=blend */
  MT_MAT_ALPHA_CUTOFF = 42, /* float */
  MT_MAT_EMISSIVE_MAP = 43, /* texture */
  MT_MAT_NORMAL_MAP = 44, /* texture */
  MT_MAT_NORMAL_SCALE = 45, /* vec2 */
  MT_MAT_METALLIC_ROUGHNESS_MAP = 46, /* texture */
  MT_MAT_ROUGHNESS_MAP = 47, /* texture */
  MT_MAT_METALNESS_MAP = 48, /* texture */
  MT_MAT_TRANSMISSION_MAP = 49, /* texture */
  MT_MAT_THIN_FILM_MAP = 50, /* texture */
  MT_MAT_SHADOW_CATCHER = 51, /* bool */
  MT_MAT_UNLIT = 52, /* bool */
  MT_MAT_BEVEL_SIZE = 53, /* float */
  MT_MAT_MAP_ALPHA_USAGE = 54, /* enum: 0=opaque, 1=alpha, 2=transmission */
  MT_MAT_UV_PROJECTION = 55, /* enum: 0=none, 1=spherical, 2=cylindrical, 3=triplanar */
  MT_MAT_UV_PROJECTION_SCALE = 56, /* vec2 */
  MT_MAT_DISPLACEMENT_UV_PROJECTION = 57, /* enum: 0=none, 1=triplanar, 2=spherical, 3=cylindrical */
  MT_MAT_DISPLACEMENT_UV_PROJECTION_SCALE = 58, /* float */
  MT_MAT_DISPLACEMENT_MAP = 59, /* texture */
  MT_MAT_DISPLACEMENT_SCALE = 60, /* float */
  MT_MAT_DISPLACEMENT_STEP_SIZE = 61, /* float */
  MT_MAT_THIN_FILM_THICKNESS_MINIMUM = 62, /* float */
  MT_MAT_THIN_FILM_MAP_CHANNEL = 63, /* enum: 0=r, 1=g, 2=b, 3=a */
  MT_MAT_COAT_WEIGHT_MAP = 64, /* texture */
  MT_MAT_COAT_ROUGHNESS_MAP = 65, /* texture */
  MT_MAT_FUZZ_COLOR_MAP = 66, /* texture */
  MT_MAT_FUZZ_ROUGHNESS_MAP = 67, /* texture */
  MT_MAT_SPECULAR_WEIGHT_MAP = 68, /* texture */
  MT_MAT_SPECULAR_COLOR_MAP = 69, /* texture */
  MT_MAT_ANISOTROPY_MAP = 70, /* texture */
  MT_MAT_SPECULAR_ANISOTROPY_ROTATION = 71, /* float */
  MT_MAT_COAT_ANISOTROPY_ROTATION = 72, /* float */
  MT_MAT_SPECULAR_ANISOTROPY_MODEL = 73, /* enum: 0=openpbr, 1=gltf */
  MT_MAT_COAT_NORMAL_MAP = 74, /* texture */
  MT_MAT_COAT_NORMAL_SCALE = 75, /* vec2 */
  MT_MAT_DISPLACEMENT_BIAS = 76, /* float */
};
#endif
