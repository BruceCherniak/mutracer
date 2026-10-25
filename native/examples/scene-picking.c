/* CPU-only C consumer: immutable snapshots and imported scene handles. */
#include "mutracer-scene-api.h"
#include "mutracer-scene.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static char error[4096];
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"line %d: %s (%s)\n",__LINE__,#x,error);exit(1); } } while(0)
#define OK(x) CHECK((x)==MT_OK)
int main(int argc,char **argv) {
  mt_scene scene=0;mt_scene_geometry_id geometry=0;mt_scene_material_id material=0;mt_scene_mesh_id mesh=0;
  mt_scene_geometry_desc g;mt_scene_material_desc m;mt_scene_mesh_desc object;
  const float positions[]={-1,-1,-2,1,-1,-2,0,1,-2};const uint32_t indices[]={0,1,2};
  OK(mt_scene_create(&scene,error,sizeof(error)));
  OK(mt_scene_geometry_desc_default(&g));g.vertex_count=3;g.index_count=3;g.positions=positions;g.indices=indices;
  OK(mt_scene_add_geometry(scene,&g,&geometry,error,sizeof(error)));
  OK(mt_scene_material_desc_default(&m));OK(mt_scene_add_material(scene,&m,&material,error,sizeof(error)));
  OK(mt_scene_mesh_desc_default(&object));object.geometry=geometry;object.material=material;
  OK(mt_scene_add_mesh(scene,&object,&mesh,error,sizeof(error)));
  mt_scene_picker before=0,after=0;mt_scene_ray ray;mt_scene_pick_hit hit;mt_scene_raycast_options options;uint32_t found=99;
  OK(mt_scene_ray_default(&ray));OK(mt_scene_pick_hit_default(&hit));OK(mt_scene_raycast_options_default(&options));
  size_t encoded_bytes=0;
  OK(mt_scene_encode(scene,NULL,0,&encoded_bytes,error,sizeof(error)));
  uint32_t *encoded=(uint32_t *)malloc(encoded_bytes);CHECK(encoded);
  OK(mt_scene_encode(scene,encoded,encoded_bytes,&encoded_bytes,error,sizeof(error)));
  const mt_scene_header_v4 *header=(const mt_scene_header_v4 *)encoded;
  CHECK(header->mesh_aov_ids_offset && header->material_aov_ids_offset);
  CHECK(encoded[header->mesh_aov_ids_offset]==(uint32_t)mesh);
  CHECK(encoded[header->material_aov_ids_offset]==(uint32_t)material);
  free(encoded);
  OK(mt_scene_picker_create(scene,&before,error,sizeof(error)));
  object.world_matrix[12]=10;
  OK(mt_scene_set_mesh(scene,mesh,&object,error,sizeof(error)));
  OK(mt_scene_picker_create(scene,&after,error,sizeof(error)));
  OK(mt_scene_destroy(scene,error,sizeof(error)));
  OK(mt_scene_picker_raycast(before,&ray,NULL,&hit,&found,error,sizeof(error)));
  CHECK(found==1 && hit.mesh==mesh && hit.geometry==geometry && hit.material==material);
  CHECK(hit.instance==UINT32_MAX && hit.primitive==0 && fabsf(hit.distance-2)<1e-6f);
  CHECK(fabsf(hit.barycentric[0]-.25f)<1e-6f && fabsf(hit.barycentric[2]-.5f)<1e-6f && hit.normal[2]==1);
  options.min_distance=2;options.max_distance=3;
  OK(mt_scene_picker_raycast(before,&ray,&options,&hit,&found,error,sizeof(error)));
  CHECK(found==1 && hit.distance==2);
  options.min_distance=0;
  mt_scene_pick_hit previous=hit;
  OK(mt_scene_picker_raycast(after,&ray,NULL,&hit,&found,error,sizeof(error)));CHECK(found==0 && memcmp(&hit,&previous,sizeof(hit))==0);
  options.max_distance=1;
  OK(mt_scene_picker_raycast(before,&ray,&options,&hit,&found,error,sizeof(error)));CHECK(found==0);
  ray.direction[2]=0;found=99;
  CHECK(mt_scene_picker_raycast(before,&ray,NULL,&hit,&found,error,sizeof(error))==MT_ERROR_INVALID_ARGUMENT);
  CHECK(found==99 && memcmp(&hit,&previous,sizeof(hit))==0);
  OK(mt_scene_picker_destroy(before,error,sizeof(error)));OK(mt_scene_picker_destroy(after,error,sizeof(error)));
  OK(mt_scene_ray_default(&ray));
  CHECK(mt_scene_picker_raycast(before,&ray,NULL,&hit,&found,error,sizeof(error))==MT_ERROR_INVALID_HANDLE);
  if(argc>1) {
    OK(mt_scene_import_gltf(argv[1],&scene,error,sizeof(error)));
    OK(mt_scene_picker_create(scene,&before,error,sizeof(error)));
    OK(mt_scene_destroy(scene,error,sizeof(error)));
    OK(mt_scene_picker_raycast(before,&ray,NULL,&hit,&found,error,sizeof(error)));
    CHECK(found==1 && hit.mesh!=0 && hit.geometry!=0 && hit.material!=0);
    OK(mt_scene_picker_destroy(before,error,sizeof(error)));
  }
  puts("PASS scene picking: handles, distance, barycentrics, edits, misses, errors and lifetime");
  return 0;
}
