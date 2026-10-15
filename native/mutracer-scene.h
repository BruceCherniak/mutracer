#ifndef MUTRACER_SCENE_H
#define MUTRACER_SCENE_H
#include <stddef.h>
#include <stdint.h>
#include "mutracer-material-properties.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Experimental raw scene ABI v1/v2/v3, macOS arm64, little endian. Every record is
 * uint32 words; float fields contain IEEE f32 bits. Offsets are words from the
 * beginning of input. Arrays/tables must fit length. Reserved words must be 0.
 * Caller owns all bytes and strings through the blocking call; none are retained.
 * Return 0 on success, 1 on failure (NUL-terminated message if capacity > 0).
 * Use one owner thread, including calls to the prepared-replay API.
 *
 * Header[32]: version[1/2/3], total_words, width,height, geometry_count,mesh_count,
 * material_count,light_count,texture_count, geometry_offset,mesh_offset,
 * material_offset,light_offset,texture_offset,camera_offset,reserved,
 * background_rgba[f32*4],reserved[12] for v1.
 * v2/v3 header words20..22: environment_texture_plus_one, background_texture_plus_one,
 * quality_flags; word23 is an optional batch table offset; words24..31 reserved.
 * Zero references disable the map.
 * Both maps require linear RGBA32F equirectangular pixels; flip_y/UV transforms
 * do not apply. Lighting and visible background are independent.
 * quality_flags: 1=enable bevel, 2=three dispersion wavelengths, 4=hide background
 * (incompatible with a background map). Other bits are rejected.
 * Geometry[12]: vertex_count,index_count,position_offset,index_offset,
 * normal_offset,uv_offset,uv1_offset,reserved[5]. Positions/normals: f32 XYZ;
 * UV: f32 XY; indices: u32 triangles. Optional attributes use offset 0.
 * Missing normals/tangents are generated; one material per mesh in v1.
 * v2/v3 geometry words7..9: color_offset[f32 RGB],tangent_offset[f32 XYZW],
 * material_index_offset[u32 local material index per vertex]; words10..11 reserved.
 * A triangle's vertices must select the same material (duplicate shared vertices
 * when neighboring triangles use different materials). Offset 0 omits an attribute.
 * Mesh[20]: geometry_index,material_index,reserved[2],world_matrix[f32*16].
 * v2/v3 mesh words2..3: material_table_offset,material_table_count. Zero count keeps
 * the single material_index; otherwise table entries are u32 material references.
 * A v2/v3 batch table has four words per mesh: count,local_matrix_offset,
 * color_offset,reserved. Count UINT32_MAX denotes an ordinary mesh and requires
 * zero offsets; count 0 is an empty batch and also requires zero offsets.
 * Other counts read count column-major local matrices and optional count RGB
 * multipliers. World matrix is applied outside the local instance transform.
 * Expanded instance count is limited to 65536 across all meshes.
 * Material[24]: base_rgb[f32*3],roughness,metalness,transmission,ior,
 * emission_rgb[f32*3],emission_luminance,coat_weight,coat_roughness,opacity
 * (all preceding scalar fields f32),thin_walled[u32],base_texture,
 * normal_texture,metallic_roughness_texture,emissive_texture,reserved[5] for v1.
 * v2/v3 material words19..20: extension_count,extension_offset; words21..23 reserved.
 * Each extension has four words {property_id,x,y,z}; see the included material
 * property enum for types and enum values. Extensions override basic values.
 * Displacement IDs 57..61 require v3. Only the first material of a mesh supplies
 * displacement inputs. Active displacement requires square power-of-two textures,
 * UVs for projection=none and a positive step size. Absolute projection scale and
 * position/UV components multiplied by it must not exceed 1,000,000.
 * Texture references use UINT32_MAX for absent; omitted material properties
 * retain MuTracer defaults. Texture storage/UV data are not prepacked atlases.
 * Texture[12]: width,height,encoding[0=RGBA8 sRGB,1=RGBA32F linear],pixel_offset,
 * flip_y[0/1],uv_channel[0/1],uv_scale[f32*2],uv_offset[f32*2],reserved[2].
 * Light[28]: type[0=rect,1=sphere,2=directional,3=spot],rgb[f32*3],intensity,
 * size_x_or_radius,size_y_or_inner_angle,spread_or_outer_angle (f32),
 * reserved[4],world_matrix[f32*16]. Rect sizes >0; spot angles in degrees,
 * 0 <= inner <= outer < 90, with outer > 0.
 * v3 light words8..10: rect_texture_plus_one,ies_offset,ies_byte_length;
 * word11 reserved. Zero texture reference disables it; only rectangular lights
 * accept a texture. IES is UTF-8 LM-63 Type C/TILT=NONE source, <=16 KiB, only
 * for spot lights. Offsets remain words, length is bytes, no NUL terminator.
 * Reusing the same IES offset/length shares one profile. Empty IES needs offset0.
 * Invalid photometric source returns a recoverable error.
 * Camera[32]: projection[0=perspective,1=orthographic],fov,near,far,
 * left,right,bottom,top,zoom,f_stop,focus_distance,sensor_height,meters_per_unit
 * (f32),reserved[3],world_matrix[f32*16]. Aspect follows width/height.
 * Matrices are invertible affine, column-major camera/local-to-world.
 *
 * Limits: nonempty scenes, <=4096 geometries, <=65536 meshes/materials,
 * <=64 lights, <=256 textures, <=64 MiB input, <=4M output/raw-texture pixels.
 * Each geometry has <=1M vertices/3M indices; preparation has a conservative
 * 64 MiB budget based on input vertex/index counts.
 * Texture atlas budget 64 MiB, max side 4096/layers 256; sources may be scaled.
 * v1 has no environment/background maps, material extensions or extra geometry/
 * instance inputs. V2 rejects displacement and light extension fields.
 * V3 adds those inputs. All versions currently use software BVH traversal.
 * Native replay retains its separate HWRT experiment.
 * Samples 1..4096, fixed seed 12345, bounces 6.
 * Result HDR/guides use the existing probe's bottom-row-first f32 RGBA layout.
 * output_directory receives render.png, HDR/guides and result.json.
 */
int32_t mt_probe_render_scene(const uint8_t *input, size_t length,
  const char *output_directory, uint32_t samples, char *error, size_t error_capacity);
#ifdef __cplusplus
}
#endif
#endif
