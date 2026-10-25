/* Scene handles: the minimal-host.c quad, checked against the descriptor builder.
 * Usage: scene-api-host [backend: 0 software, 1 HWRT] [sample.glb]. */
#include "mutracer-scene-api.h"
#include "mutracer-scene-builder.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define CHECK(call) do { int32_t status=(call); if(status!=MT_OK){fprintf(stderr,"%s: %d %s\n",#call,status,error);exit(1);} } while(0)
#define REQUIRE(test) do {if(!(test)){fprintf(stderr,"Failed: %s\n",#test);exit(1);}}while(0)
static char error[4096];
static const float positions[]={-1,0,-1,-1,0,1,1,0,-1,1,0,1};
static const uint32_t indices[]={0,1,2,2,1,3};

/* The retained viewer encoder spells out these defaults. The legacy descriptor
 * builder expresses the same defaults explicitly for an independent byte oracle. */
static void extensions(mt_material_extension_v4 e[36]) {
  const uint32_t ids[]={38,41,42,45,52,73,3,5,9,11,12,15,17,18,19,22,23,24,26,29,31,32,33,53,6,20,47,48,49,50,59,60,76,61,57,58};
  const float v[][3]={{0},{0},{.5f},{1,1},{0},{0},{0},{1},{0},{1,1,1},{0},{0},{0},{.8f,.8f,.8f},{1},{0},{1,1,1},{.5f},{1,1,1},{1.6f},{0},{.5f},{1.4f},{0},{1,1,1},{1,.5f,.25f},{0},{0},{0},{0},{0},{0},{0},{.01f},{0},{1}};
  for(unsigned i=0;i<36;i++) {
    e[i]=mt_extension_float(ids[i],v[i][0],v[i][1],v[i][2]);
    if(i==0||i==1||i==4||i==5||i==34) e[i].value.u[0]=0;
    if(i>=26&&i<=30) e[i].value.u[0]=MT_NO_TEXTURE;
  }
}
static size_t legacy(mt_scene_builder *b,mt_camera_v4 camera,mt_light_v4 light,int canonical,uint32_t object_id,uint32_t material_id) {
  mt_scene_header_v4 h={0};h.width=h.height=1;h.geometry_count=h.mesh_count=h.material_count=h.light_count=1;h.background_color[3]=1;
  mt_geometry_v4 g={0};g.vertex_count=4;g.index_count=6;
  mt_mesh_v4 m={0};mt_scene_identity(m.world_matrix);
  mt_material_v4 mat=mt_material_v4_default();mat.base_color[1]=mat.base_color[2]=.1f;
  mt_scene_builder_init(b);
  if(canonical) {
    h.geometry_offset=mt_scene_builder_append(b,NULL,sizeof g);
    h.mesh_offset=mt_scene_builder_append(b,&m,sizeof m);
    h.material_offset=mt_scene_builder_append(b,NULL,sizeof mat);
    h.texture_offset=(uint32_t)b->used;
    h.light_offset=mt_scene_builder_append(b,&light,sizeof light);
    h.camera_offset=mt_scene_builder_append(b,&camera,sizeof camera);
    g.position_offset=mt_scene_builder_append(b,positions,sizeof positions);
    g.index_offset=mt_scene_builder_append(b,indices,sizeof indices);
    mt_material_extension_v4 ext[36];extensions(ext);mat.extension_count=36;
    mat.extension_offset=mt_scene_builder_append(b,ext,sizeof ext);
    memcpy(b->words+h.geometry_offset,&g,sizeof g);memcpy(b->words+h.material_offset,&mat,sizeof mat);
    h.mesh_aov_ids_offset=mt_scene_builder_append(b,&object_id,sizeof object_id);
    h.material_aov_ids_offset=mt_scene_builder_append(b,&material_id,sizeof material_id);
  } else {
    /* Original minimal-host allocation order and omitted extension defaults. */
    g.position_offset=mt_scene_builder_append(b,positions,sizeof positions);
    g.index_offset=mt_scene_builder_append(b,indices,sizeof indices);
    h.geometry_offset=mt_scene_builder_append(b,&g,sizeof g);
    h.mesh_offset=mt_scene_builder_append(b,&m,sizeof m);
    h.material_offset=mt_scene_builder_append(b,&mat,sizeof mat);
    h.light_offset=mt_scene_builder_append(b,&light,sizeof light);
    h.camera_offset=mt_scene_builder_append(b,&camera,sizeof camera);
  }
  return mt_scene_builder_finish(b,&h);
}
/* Separate imports allocate distinct stable identities. Canonicalize only the
 * ID values, retaining their table layout and every scene/resource byte. */
static void canonical_ids(void *bytes,size_t size) {
  REQUIRE(size>=sizeof(mt_scene_header_v4));
  uint32_t *words=(uint32_t *)bytes;
  const mt_scene_header_v4 *h=(const mt_scene_header_v4 *)bytes;
  const uint32_t offsets[]={h->mesh_aov_ids_offset,h->material_aov_ids_offset};
  const uint32_t counts[]={h->mesh_count,h->material_count};
  for(unsigned table=0;table<2;table++) {
    REQUIRE(offsets[table]!=0 && (uint64_t)offsets[table]+counts[table]<=size/sizeof(uint32_t));
    for(uint32_t i=0;i<counts[table];i++) {
      REQUIRE(words[offsets[table]+i]!=UINT32_MAX);
      words[offsets[table]+i]=i;
    }
  }
}
typedef struct AovExpected {uint32_t width,height;float *depth;uint32_t *ids;} AovExpected;
static int32_t copy_aov_filter(const mt_denoise_input *input,float *output,char *message,size_t capacity,void *user) {
  (void)message;(void)capacity;
  const AovExpected *expected=(const AovExpected *)user;
  REQUIRE(input->struct_size==sizeof *input && input->width==expected->width && input->height==expected->height);
  REQUIRE(input->count==(size_t)input->width*input->height*4);
  REQUIRE(input->aovs==(MT_AOV_DEPTH|MT_AOV_ID));
  for(unsigned slot=0;slot<7;slot++) REQUIRE((input->aov_data[slot]!=NULL)==(slot==0||slot==5));
  /* Engine readback is top-row-first; C filter snapshots are bottom-row-first.
   * Compare raw ID bits, including UINT32_MAX, without a float conversion. */
  size_t row=(size_t)input->width*4;
  for(uint32_t y=0;y<input->height;y++) {
    size_t previous=(size_t)(input->height-1-y)*row,current=(size_t)y*row;
    REQUIRE(memcmp((const uint32_t *)input->aov_data[5]+current,expected->ids+previous,row*sizeof(uint32_t))==0);
    REQUIRE(memcmp((const float *)input->aov_data[0]+current,expected->depth+previous,row*sizeof(float))==0);
  }
  memcpy(output,input->color,input->count*sizeof(float));
  return MT_OK;
}
static void release_aov_filter(void *user) {
  AovExpected *expected=(AovExpected *)user;free(expected->depth);free(expected->ids);free(expected);
}
static float *render(uint32_t backend,mt_scene scene,const void *bytes,size_t len,uint32_t object_id,uint32_t material_id) {
  mt_engine_options eo;CHECK(mt_engine_options_default(&eo));eo.backend=backend;
  mt_engine engine;CHECK(mt_engine_create(&eo,&engine,error,sizeof error));
  mt_render_options ro;CHECK(mt_render_options_default(&ro));ro.width=64;ro.height=48;ro.max_samples=8;ro.bevel=0;ro.dispersion_wavelengths=1;
  mt_render r;CHECK(mt_render_create(engine,&ro,&r,error,sizeof error));
  if(scene) CHECK(mt_engine_set_scene_object(engine,scene,error,sizeof error));
  else CHECK(mt_engine_set_scene(engine,bytes,len,error,sizeof error));
  uint32_t changed=0;CHECK(mt_engine_update(engine,&changed,error,sizeof error));REQUIRE(changed==1);
  mt_converge_options co;CHECK(mt_converge_options_default(8,&co));uint32_t samples=0;
  CHECK(mt_render_converge(r,&co,&samples,error,sizeof error));REQUIRE(samples==8);
  mt_engine_snapshot info={.struct_size=sizeof info};CHECK(mt_engine_info(engine,&info,error,sizeof error));REQUIRE(info.backend==backend);
  mt_render_snapshot active={.struct_size=sizeof active};CHECK(mt_render_info(r,&active,error,sizeof error));REQUIRE(active.backend==backend);
  size_t written=0,count=64*48*16;float *pixels=malloc(count);REQUIRE(pixels);
  CHECK(mt_render_read_pixels(r,MT_IMAGE_HDR,pixels,count,&written,error,sizeof error));REQUIRE(written==count);
  ro.aovs=MT_AOV_DEPTH|MT_AOV_ID;
  CHECK(mt_render_set_options(r,&ro,error,sizeof error));
  CHECK(mt_render_converge(r,&co,&samples,error,sizeof error));
  AovExpected *expected=(AovExpected *)calloc(1,sizeof *expected);REQUIRE(expected);
  expected->width=64;expected->height=48;expected->depth=(float *)malloc(count);expected->ids=(uint32_t *)malloc(count);REQUIRE(expected->depth&&expected->ids);
  CHECK(mt_render_read_pixels(r,MT_IMAGE_DEPTH,expected->depth,count,&written,error,sizeof error));REQUIRE(written==count);
  CHECK(mt_render_read_pixels(r,MT_IMAGE_ID,expected->ids,count,&written,error,sizeof error));REQUIRE(written==count);
  unsigned hits=0;for(size_t i=0;i<64*48;i++) if(expected->ids[i*4]!=UINT32_MAX) {
    REQUIRE(expected->ids[i*4]==object_id && expected->ids[i*4+2]==material_id && expected->ids[i*4+3]<2);hits++;
  }
  REQUIRE(hits>0);
  mt_custom_denoiser filter={0};filter.struct_size=sizeof filter;filter.schedule=MT_DENOISE_CONVERGED;
  filter.callback=copy_aov_filter;filter.release=release_aov_filter;filter.user=expected;filter.aovs=MT_AOV_DEPTH|MT_AOV_ID;
  CHECK(mt_render_set_custom_denoiser(r,&filter,error,sizeof error));
  CHECK(mt_render_converge(r,&co,&samples,error,sizeof error));
  float *after=(float *)malloc(count);REQUIRE(after);
  CHECK(mt_render_read_pixels(r,MT_IMAGE_HDR,after,count,&written,error,sizeof error));REQUIRE(memcmp(pixels,after,count)==0);free(after);
  CHECK(mt_engine_destroy(engine,error,sizeof error));return pixels;
}
int main(int argc,char **argv) {
  uint32_t backend=argc>1?(uint32_t)atoi(argv[1]):0;REQUIRE(mt_abi_version()==MT_ABI_VERSION);
  mt_scene s;CHECK(mt_scene_create(&s,error,sizeof error));
  mt_scene_geometry_desc gd;CHECK(mt_scene_geometry_desc_default(&gd));gd.vertex_count=4;gd.index_count=6;gd.positions=positions;gd.indices=indices;
  mt_scene_geometry_id g;CHECK(mt_scene_add_geometry(s,&gd,&g,error,sizeof error));
  mt_scene_material_desc md;CHECK(mt_scene_material_desc_default(&md));md.color[1]=md.color[2]=.1f;
  mt_scene_material_id m;CHECK(mt_scene_add_material(s,&md,&m,error,sizeof error));
  mt_scene_mesh_desc mesh;CHECK(mt_scene_mesh_desc_default(&mesh));mesh.geometry=g;mesh.material=m;
  mt_scene_mesh_id mi;CHECK(mt_scene_add_mesh(s,&mesh,&mi,error,sizeof error));
  mt_scene_light_desc ld;CHECK(mt_scene_light_desc_default(&ld));ld.intensity=10;
  const float at[]={0,2,0},target[]={0,0,.001f};mt_scene_look_at(ld.world_matrix,at,target);
  mt_scene_light_id li;CHECK(mt_scene_add_light(s,&ld,&li,error,sizeof error));
  mt_camera_v4 camera=mt_camera_v4_default();const float eye[]={0,2,3},origin[]={0,0,0};mt_scene_look_at(camera.world_matrix,eye,origin);
  CHECK(mt_scene_set_default_camera(s,&camera,error,sizeof error));
  size_t len=0;CHECK(mt_scene_encode(s,NULL,0,&len,error,sizeof error));void *encoded=malloc(len);REQUIRE(encoded);CHECK(mt_scene_encode(s,encoded,len,&len,error,sizeof error));
  mt_light_v4 light={0};light.type=0;for(unsigned i=0;i<3;i++)light.color[i]=1;light.intensity=10;light.size_or_radius=light.height_or_inner_angle=light.spread_or_outer_angle=1;memcpy(light.world_matrix,ld.world_matrix,sizeof ld.world_matrix);
  mt_scene_builder canonical,original;size_t clen=legacy(&canonical,camera,light,1,(uint32_t)mi,(uint32_t)m),olen=legacy(&original,camera,light,0,0,0);
  REQUIRE(len==clen);REQUIRE(memcmp(encoded,mt_scene_builder_bytes(&canonical),len)==0);
  float *a=render(backend,s,NULL,0,(uint32_t)mi,(uint32_t)m),*b=render(backend,0,mt_scene_builder_bytes(&canonical),clen,(uint32_t)mi,(uint32_t)m),*c=render(backend,0,mt_scene_builder_bytes(&original),olen,0,0);
  REQUIRE(memcmp(a,b,64*48*16)==0);REQUIRE(memcmp(a,c,64*48*16)==0);free(a);free(b);free(c);
  CHECK(mt_scene_material_set_float(s,m,MT_MAT_SPECULAR_ROUGHNESS,.6f,0,0,error,sizeof error));uint32_t kind=0;CHECK(mt_scene_pending_commit_kind(s,&kind,error,sizeof error));REQUIRE(kind==MT_COMMIT_INCREMENTAL);
  CHECK(mt_scene_remove_mesh(s,mi,error,sizeof error));REQUIRE(mt_scene_set_mesh_transform(s,mi,mesh.world_matrix,error,sizeof error)==MT_ERROR_INVALID_HANDLE);
  CHECK(mt_scene_destroy(s,error,sizeof error));REQUIRE(mt_scene_destroy(s,error,sizeof error)==MT_ERROR_INVALID_HANDLE);
  if(argc>2){
    mt_scene imported,from_bytes;CHECK(mt_scene_import_gltf(argv[2],&imported,error,sizeof error));
    uint64_t named=0;CHECK(mt_scene_find(imported,2,"Default",0,&named,error,sizeof error));REQUIRE(named!=0);
    FILE *file=fopen(argv[2],"rb");REQUIRE(file);REQUIRE(fseek(file,0,SEEK_END)==0);long count=ftell(file);REQUIRE(count>0);rewind(file);void *data=malloc((size_t)count);REQUIRE(data);REQUIRE(fread(data,1,(size_t)count,file)==(size_t)count);fclose(file);
    CHECK(mt_scene_import_gltf_bytes(data,(size_t)count,NULL,&from_bytes,error,sizeof error));free(data);
    size_t na=0,nb=0;CHECK(mt_scene_encode(imported,NULL,0,&na,error,sizeof error));CHECK(mt_scene_encode(from_bytes,NULL,0,&nb,error,sizeof error));REQUIRE(na==nb);void *aa=malloc(na),*bb=malloc(nb);REQUIRE(aa&&bb);CHECK(mt_scene_encode(imported,aa,na,&na,error,sizeof error));CHECK(mt_scene_encode(from_bytes,bb,nb,&nb,error,sizeof error));canonical_ids(aa,na);canonical_ids(bb,nb);REQUIRE(memcmp(aa,bb,na)==0);free(aa);free(bb);
    CHECK(mt_scene_destroy(imported,error,sizeof error));CHECK(mt_scene_destroy(from_bytes,error,sizeof error));
  }
  free(encoded);mt_scene_builder_free(&canonical);mt_scene_builder_free(&original);
  printf("PASS scene API: descriptor bytes, original minimal HDR, ABI 8 AOV snapshots, handles, properties, import (backend %u)\n",backend);return 0;
}
