/* A real native caller constructs raw geometry and editable scene descriptors.
 * No capture files, JavaScript-generated resources, or embedded GPU shaders. */
#include "mutracer-scene.h"
#include "mutracer-material-properties.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t words[65536];
static uint32_t used = 32;
static uint32_t reserve(uint32_t count) {
  uint32_t off=used; if (count>65536-used) exit(2); used+=count; return off;
}
static void value(uint32_t off,double x) {float f=(float)x;memcpy(words+off,&f,4);}
static void vector(uint32_t off,double x,double y,double z) {value(off,x);value(off+1,y);value(off+2,z);}
static void matrix(uint32_t off,double scale,double x,double y,double z) {
  value(off,scale);value(off+5,scale);value(off+10,scale);value(off+15,1);vector(off+12,x,y,z);
}
static void camera(uint32_t off) {
  const double eye[3]={0,2.4,6},target[3]={0,.4,-.3};
  double z[3],x[3],y[3],n=0;
  for(int k=0;k<3;k++){z[k]=eye[k]-target[k];n+=z[k]*z[k];} n=sqrt(n);
  for(int k=0;k<3;k++)z[k]/=n;
  x[0]=z[2];x[1]=0;x[2]=-z[0];n=sqrt(x[0]*x[0]+x[2]*x[2]);
  for(int k=0;k<3;k++)x[k]/=n;
  y[0]=z[1]*x[2]-z[2]*x[1];y[1]=z[2]*x[0]-z[0]*x[2];y[2]=z[0]*x[1]-z[1]*x[0];
  for(int k=0;k<3;k++){value(off+k,x[k]);value(off+4+k,y[k]);value(off+8+k,z[k]);value(off+12+k,eye[k]);}
  value(off+15,1);
}
static size_t make_scene(const char *variant) {
  memset(words,0,sizeof(words));used=32;
  int floating=!strcmp(variant,"float-textures"),textured=!strcmp(variant,"textures")||floating,affine=!strcmp(variant,"transforms"),emissive=!strcmp(variant,"emissive");
  int v3=!strncmp(variant,"v3-",3),v2=!strncmp(variant,"v2-",3)||v3;
  uint32_t light_count=!strcmp(variant,"v3-ies-shared")?2:1;
  uint32_t texture_count=v2?4:(uint32_t)textured;
  uint32_t geos=reserve(24),meshes=reserve(80),materials=reserve(96),lights=reserve(light_count*28),textures=reserve(texture_count*12),cam=reserve(32);
  words[0]=v3?3:v2?2:1;words[2]=480;words[3]=320;words[4]=2;words[5]=4;words[6]=4;words[7]=light_count;words[8]=texture_count;
  words[9]=geos;words[10]=meshes;words[11]=materials;words[12]=lights;words[13]=textures;words[14]=cam;
  vector(16,.055,.075,.11);value(19,1);
  const uint32_t phi=32,theta=20,vc=(phi+1)*(theta+1),ic=phi*theta*6;
  uint32_t pos=reserve(12),idx=reserve(6),norm=reserve(12),uv=reserve(8);
  words[geos]=4;words[geos+1]=6;words[geos+2]=pos;words[geos+3]=idx;words[geos+4]=norm;words[geos+5]=uv;
  for(uint32_t y=0;y<2;y++)for(uint32_t x=0;x<2;x++){uint32_t v=y*2+x;vector(pos+v*3,2*(double)y-1,0,2*(double)x-1);vector(norm+v*3,0,1,0);value(uv+v*2,x);value(uv+v*2+1,y);}
  const uint32_t floor_indices[]={0,1,2,2,1,3};memcpy(words+idx,floor_indices,sizeof(floor_indices));
  pos=reserve(vc*3);idx=reserve(ic);norm=reserve(vc*3);uv=reserve(vc*2);
  uint32_t g=geos+12;words[g]=vc;words[g+1]=ic;words[g+2]=pos;words[g+3]=idx;words[g+4]=norm;words[g+5]=uv;
  const double pi=acos(-1.0);
  for(uint32_t j=0;j<=theta;j++)for(uint32_t i=0;i<=phi;i++){
    uint32_t v=j*(phi+1)+i;double u=(double)i/phi,t=(double)j/theta;
    double x=-cos(u*pi*2)*sin(t*pi),y=cos(t*pi),z=sin(u*pi*2)*sin(t*pi);
    vector(pos+v*3,x,y,z);vector(norm+v*3,x,y,z);value(uv+v*2,u);value(uv+v*2+1,t);
  }
  uint32_t n=0;
  for(uint32_t j=0;j<theta;j++)for(uint32_t i=0;i<phi;i++){
    uint32_t a=j*(phi+1)+i+1,b=a-1,d=(j+1)*(phi+1)+i+1,c=d-1;
    words[idx+n++]=a;words[idx+n++]=b;words[idx+n++]=d;words[idx+n++]=b;words[idx+n++]=c;words[idx+n++]=d;
  }
  const double colors[4][3]={{.55,.57,.6},{.8,.08,.04},{.95,.7,.25},{.85,.95,1}};
  for(uint32_t i=0;i<4;i++){
    uint32_t m=materials+i*24;vector(m,colors[i][0],colors[i][1],colors[i][2]);value(m+3,i==0?.65:i==1?.35:i==2?.2:.05);value(m+4,i==2?1:0);value(m+5,i==3?1:0);value(m+6,1.5);vector(m+7,1,1,1);value(m+13,1);
    for(int k=15;k<19;k++)words[m+k]=UINT32_MAX;
    uint32_t mo=meshes+i*20;words[mo]=i?1:0;words[mo+1]=i;matrix(mo+4,i?.55:5,i?((double)i-2)*1.2:0,i?.55:0,0);
    if(affine&&i){value(mo+4,i==2?-.6:.6);value(mo+9,.85);value(mo+14,.38);value(mo+8,.12);}
    if(emissive&&i==1){value(m+10,2);value(m+11,.7);value(m+12,.25);}
  }
  if(textured){
    uint32_t pixels=reserve(floating?64:16);words[textures]=4;words[textures+1]=4;words[textures+3]=pixels;words[textures+2]=(uint32_t)floating;value(textures+6,3);value(textures+7,3);
    for(uint32_t i=0;i<16;i++){if(floating){vector(pixels+i*4,(i%4+i/4)%2?2:.1,.3,.7);value(pixels+i*4+3,1);}else words[pixels+i]=((i%4+i/4)%2)?0xff5080e0u:0xffe0d090u;}
    words[materials+15]=0;value(materials+24+11,.7);value(materials+24+12,.2);
  }
  words[lights]=0;vector(lights+1,1,.9,.78);value(lights+4,7);value(lights+5,2.5);value(lights+6,2.5);value(lights+7,1);
  uint32_t lm=lights+12;matrix(lm,1,-1.5,3,1.5);value(lm+5,cos(-pi/2));value(lm+6,sin(-pi/2));value(lm+9,-sin(-pi/2));value(lm+10,cos(-pi/2));
  if(!strcmp(variant,"sphere-light")){words[lights]=1;value(lights+5,.35);value(lights+4,30);}
  if(!strcmp(variant,"directional-light")){words[lights]=2;value(lights+4,3);}
  if(!strcmp(variant,"spot-light")){words[lights]=3;value(lights+5,.2);value(lights+6,20);value(lights+7,35);value(lights+4,200);}
  if(!strcmp(variant,"alpha"))value(materials+24+13,.4);
  words[cam]=!strcmp(variant,"orthographic")?1:0;value(cam+1,40);value(cam+2,.1);value(cam+3,100);value(cam+4,-2.6);value(cam+5,2.6);value(cam+6,-1.75);value(cam+7,1.75);value(cam+8,1);value(cam+10,10);value(cam+11,24);value(cam+12,1);camera(cam+16);
  if(!strcmp(variant,"missing-normals")){words[geos+4]=0;words[geos+12+4]=0;}
  if(v2){
    for(uint32_t t=0;t<4;t++){
      uint32_t o=textures+t*12,w=t==0?32:4,h=t==0?16:4,pixels=reserve(w*h*4);
      words[o]=w;words[o+1]=h;words[o+2]=1;words[o+3]=pixels;value(o+6,1);value(o+7,1);
      for(uint32_t y=0;y<h;y++)for(uint32_t x=0;x<w;x++){
        uint32_t k=pixels+(y*w+x)*4; double hot=(x>6&&x<10&&y>2&&y<6)?8:.1;
        if(t==0)vector(k,hot,hot*.75,hot*.4);
        else if(t==1)vector(k,((x+y)%2)?.2:1,((x+y)%2)?.25:.75,.85);
        else if(t==2)vector(k,.5+.1*(x%2),.5,1);
        else vector(k,1,.25,.7);
        value(k+3,(x+y)%2?.35:1);
      }
    }
    words[20]=1;
    if(!strcmp(variant,"v2-background"))words[21]=2;
    if(!strcmp(variant,"v2-hidden-background"))words[22]=4;
    if(!strcmp(variant,"v2-environment-only"))words[7]=0;
    /* Material extensions use explicit wire IDs, including deliberate default
       overrides and values that enable shader variants absent in the base. */
    uint32_t m=materials+24,e=reserve(12*4);words[m+19]=12;words[m+20]=e;
    const uint32_t ids[]={MT_MAT_SPECULAR_ANISOTROPY,MT_MAT_SPECULAR_ANISOTROPY_ROTATION,
      MT_MAT_COAT_WEIGHT,MT_MAT_COAT_COLOR,MT_MAT_COAT_NORMAL_MAP,MT_MAT_COAT_NORMAL_SCALE,
      MT_MAT_FUZZ_WEIGHT,MT_MAT_FUZZ_COLOR,MT_MAT_FUZZ_COLOR_MAP,MT_MAT_SPECULAR_WEIGHT_MAP,
      MT_MAT_MAP,MT_MAT_UV_PROJECTION_SCALE};
    for(uint32_t i=0;i<12;i++)words[e+i*4]=ids[i];
    value(e+1,.65);value(e+5,.2);value(e+9,.75);vector(e+13,.6,.8,1);
    words[e+17]=2;value(e+21,.5);value(e+22,.8);value(e+25,.25);vector(e+29,1,.2,.1);
    words[e+33]=1;words[e+37]=3;words[e+41]=1;value(e+45,1.2);value(e+46,.8);
    if(!strcmp(variant,"v2-film")){
      e=reserve(4*4);m=materials+48;words[m+19]=4;words[m+20]=e;
      words[e]=MT_MAT_THIN_FILM_WEIGHT;value(e+1,1);words[e+4]=MT_MAT_THIN_FILM_THICKNESS;value(e+5,.45);
      words[e+8]=MT_MAT_THIN_FILM_MAP;words[e+9]=1;words[e+12]=MT_MAT_THIN_FILM_MAP_CHANNEL;words[e+13]=2;
    }
    if(!strcmp(variant,"v2-medium")){
      e=reserve(6*4);m=materials+72;words[m+19]=6;words[m+20]=e;
      words[e]=MT_MAT_TRANSMISSION_DEPTH;value(e+1,.5);words[e+4]=MT_MAT_TRANSMISSION_COLOR;vector(e+5,.6,.85,1);
      words[e+8]=MT_MAT_TRANSMISSION_SCATTER;vector(e+9,.2,.1,.05);words[e+12]=MT_MAT_TRANSMISSION_SCATTER_ANISOTROPY;value(e+13,.3);
      words[e+16]=MT_MAT_TRANSMISSION_DISPERSION_SCALE;value(e+17,.2);words[e+20]=MT_MAT_TRANSMISSION_DISPERSION_ABBE_NUMBER;value(e+21,30);words[22]=2;
    }
    if(!strcmp(variant,"v2-alpha")){
      e=reserve(4*4);m=materials+24;words[m+19]=4;words[m+20]=e;
      words[e]=MT_MAT_ALPHA_MODE;words[e+1]=2;words[e+4]=MT_MAT_ALPHA_CUTOFF;value(e+5,.5);
      words[e+8]=MT_MAT_ALPHA_MAP;words[e+9]=1;words[e+12]=MT_MAT_DOUBLE_SIDED;words[e+13]=1;
    }
    if(!strcmp(variant,"v2-bevel")){
      e=reserve(4);m=materials+24;words[m+19]=1;words[m+20]=e;words[e]=MT_MAT_BEVEL_SIZE;value(e+1,.03);words[22]=1;
    }
  }
  if(!strcmp(variant,"v2-vertices")||!strcmp(variant,"v2-multimaterial")){
    uint32_t oldp=words[geos+2],oldn=words[geos+4],olduv=words[geos+5];
    uint32_t p=reserve(18),nn=reserve(18),uu=reserve(12),ii=reserve(6),cc=reserve(18),tt=reserve(24),mm=reserve(6);
    for(uint32_t i=0;i<6;i++){
      uint32_t source=floor_indices[i];memcpy(words+p+i*3,words+oldp+source*3,12);memcpy(words+nn+i*3,words+oldn+source*3,12);memcpy(words+uu+i*2,words+olduv+source*2,8);
      words[ii+i]=i;words[mm+i]=i<3?0:1;vector(cc+i*3,.4+.1*i,1,.5);value(tt+i*4,1);value(tt+i*4+3,1);
    }
    words[geos]=6;words[geos+2]=p;words[geos+3]=ii;words[geos+4]=nn;words[geos+5]=uu;words[geos+6]=uu;words[geos+7]=cc;words[geos+8]=tt;words[geos+9]=mm;
    uint32_t table=reserve(2);words[table]=0;words[table+1]=1;words[meshes+2]=table;words[meshes+3]=2;
    if(!strcmp(variant,"v2-multimaterial")){
      uint32_t other=reserve(2);words[other]=2;words[other+1]=3;words[meshes+20]=0;words[meshes+22]=other;words[meshes+23]=2;
    }
  }
  if(!strcmp(variant,"v2-instances")||!strcmp(variant,"v2-empty-batch")){
    uint32_t descriptors=reserve(16);words[23]=descriptors;
    if(!strcmp(variant,"v2-instances")){
      for(uint32_t i=0;i<4;i++)words[descriptors+i*4]=UINT32_MAX;
      uint32_t transforms=reserve(48),colors=reserve(9),io=descriptors+4;
      words[io]=3;words[io+1]=transforms;words[io+2]=colors;
      for(uint32_t i=0;i<3;i++){matrix(transforms+i*16,.7,i*.9,i*.9,-(double)i*.3);vector(colors+i*3,i==0?1:.3,i==1?1:.3,i==2?1:.3);}
    }
  }
  if(v3 && !strncmp(variant,"v3-displacement-",16)) {
    int projected=!strcmp(variant,"v3-displacement-triplanar")||!strcmp(variant,"v3-displacement-spherical")||!strcmp(variant,"v3-displacement-cylindrical");
    uint32_t m=materials+(projected?24:0),e=reserve(5*4);words[m+19]=5;words[m+20]=e;
    words[e]=MT_MAT_DISPLACEMENT_MAP;words[e+1]=1;
    words[e+4]=MT_MAT_DISPLACEMENT_SCALE;value(e+5,!strcmp(variant,"v3-displacement-negative")?-.35:!strcmp(variant,"v3-displacement-zero")?0:.35);
    words[e+8]=MT_MAT_DISPLACEMENT_STEP_SIZE;value(e+9,.02);
    words[e+12]=MT_MAT_DISPLACEMENT_UV_PROJECTION;words[e+13]=!strcmp(variant,"v3-displacement-triplanar")?1:!strcmp(variant,"v3-displacement-spherical")?2:!strcmp(variant,"v3-displacement-cylindrical")?3:0;
    words[e+16]=MT_MAT_DISPLACEMENT_UV_PROJECTION_SCALE;value(e+17,1);
    if(projected)words[geos+12+5]=0; /* exercise projective displacement without UVs */
    if(!strcmp(variant,"v3-displacement-bytes")) {
      uint32_t o=textures+12,pixels=reserve(16);words[o+2]=0;words[o+3]=pixels;
      for(uint32_t i=0;i<16;i++)words[pixels+i]=(i%2)?0xffc06020u:0xff20c0e0u;
    }
  }
  if(v3 && (!strcmp(variant,"v3-ies")||!strcmp(variant,"v3-ies-shared"))) {
    const char *ies="IESNA:LM-63-2002\nTILT=NONE\n1 1000 1 5 3 1 2 0 0 0 1 1 20\n0 20 45 70 90\n0 90 180\n100 90 40 5 0 80 60 15 0 0 50 30 5 0 0\n";
    size_t len=strlen(ies);uint32_t text=reserve((uint32_t)((len+3)/4));memcpy(words+text,ies,len);
    words[lights]=3;value(lights+4,200);value(lights+5,.15);value(lights+6,20);value(lights+7,70);words[lights+9]=text;words[lights+10]=(uint32_t)len;
    if(light_count==2){memcpy(words+lights+28,words+lights,28*4);value(lights+28+24,1.5);}
  }
  if(!strcmp(variant,"v3-rect-texture"))words[lights+8]=2;
  words[1]=used;return used*4;
}
int main(int argc,char **argv) {
  if(argc<3||argc>5)return 2;
  const char *variant=argc>=4?argv[3]:"baseline";
  const char *variants[]={"baseline","textures","transforms","orthographic","emissive","missing-normals","float-textures","sphere-light","directional-light","spot-light","alpha","v2-environment","v2-environment-only","v2-background","v2-hidden-background","v2-film","v2-medium","v2-alpha","v2-bevel","v2-vertices","v2-multimaterial","v2-instances","v2-empty-batch","v3-displacement-uv","v3-displacement-triplanar","v3-displacement-spherical","v3-displacement-cylindrical","v3-displacement-negative","v3-displacement-bytes","v3-displacement-zero","v3-ies","v3-ies-shared","v3-rect-texture"};
  int known=0;for(size_t i=0;i<sizeof(variants)/sizeof(variants[0]);i++)if(!strcmp(variant,variants[i]))known=1;
  if(!known)return 2;
  if(argc==5&&strcmp(argv[4],"repeat"))return 2;
  unsigned long samples=strtoul(argv[2],NULL,10);if(samples>4096)return 2;
  size_t size=make_scene(variant);char error[4096]={0};
  if(!samples){FILE *file=fopen(argv[1],"wb");if(!file||fwrite(words,1,size,file)!=size)return 4;fclose(file);return 0;}
  uint32_t old=words[0];words[0]=99;
  if(mt_probe_render_scene((uint8_t*)words,size,argv[1],(uint32_t)samples,error,sizeof(error))==0)return 3;
  words[0]=old;
  old=words[words[10]];words[words[10]]=999999;
  if(mt_probe_render_scene((uint8_t*)words,size,argv[1],(uint32_t)samples,error,sizeof(error))==0)return 3;
  words[words[10]]=old;
  if(mt_probe_render_scene((uint8_t*)words,size-4,argv[1],(uint32_t)samples,error,sizeof(error))==0)return 3;
  if(words[0]==3 && words[words[12]+10]){
    uint32_t off=words[words[12]+9],saved=words[off];words[off]=0;
    if(mt_probe_render_scene((uint8_t*)words,size,argv[1],(uint32_t)samples,error,sizeof(error))==0)return 3;
    words[off]=saved;
  }
  if(mt_probe_render_scene((uint8_t*)words,size,argv[1],(uint32_t)samples,error,sizeof(error))){fprintf(stderr,"%s\n",error);return 1;}
  char path[4096];if(snprintf(path,sizeof(path),"%s/scene-input.bin",argv[1])>=(int)sizeof(path))return 2;
  FILE *file=fopen(path,"wb");if(!file||fwrite(words,1,size,file)!=size)return 4;fclose(file);
  if(argc==5){
    if(snprintf(path,sizeof(path),"%s/repeat",argv[1])>=(int)sizeof(path))return 2;
    if(mt_probe_render_scene((uint8_t*)words,size,path,(uint32_t)samples,error,sizeof(error))){fprintf(stderr,"%s\n",error);return 1;}
  }
  return 0;
}
