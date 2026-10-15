/* Compare partial camera commands with complete scene commits on real GPUs. */
#include "mutracer-context.h"
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static char error[4096];static unsigned checks;
#define REQUIRE(test) do{checks++;if(!(test)){fprintf(stderr,"line %d: %s; %s\n",__LINE__,#test,error);return 1;}}while(0)
#define OK(call) REQUIRE((call)==0)
#define BAD(call) REQUIRE((call)!=0)
static unsigned char *load(const char *path,size_t *size){
 FILE *f=fopen(path,"rb");if(!f||fseek(f,0,SEEK_END))return NULL;long n=ftell(f);if(n<0||fseek(f,0,SEEK_SET))return NULL;
 unsigned char *p=malloc(n?(size_t)n:1);if(!p||fread(p,1,(size_t)n,f)!=(size_t)n)return NULL;fclose(f);*size=(size_t)n;return p;
}
static int read_image(mt_context context,unsigned kind,unsigned char *output,size_t size){size_t written=0;
 return mt_context_read_pixels(context,kind,output,size,&written,error,sizeof(error))||written!=size;
}
struct thread_args {mt_context context;const unsigned char *camera;};
static void *wrong_thread(void *input){struct thread_args *args=input;char message[128];
 return (void*)(uintptr_t)(mt_context_update_camera(args->context,args->camera,128,message,sizeof(message))!=0);
}
int main(int argc,char **argv){
 if(argc!=4)return 2;size_t length=0;unsigned char *input=load(argv[1],&length);if(!input||length<128)return 2;
 uint32_t *words=(uint32_t*)input;size_t size=(size_t)words[2]*words[3]*16;unsigned char *source=input+words[14]*4;
 unsigned samples=(unsigned)strtoul(argv[3],NULL,10);if(samples<8||samples>4096)return 2;
 unsigned char camera[128],original[128];memcpy(original,source,128);memcpy(camera,original,128);
 unsigned char *a_pixels=malloc(size),*b_pixels=malloc(size),*initial=malloc(size*3);if(!a_pixels||!b_pixels||!initial)return 2;
 mt_context a=0,b=0;mt_render_job old=0,job=0;mt_context_info_v1 ci={.struct_size=sizeof(ci)};mt_job_info_v1 ji={.struct_size=sizeof(ji)};
 OK(mt_context_create(&a,error,sizeof(error)));OK(mt_context_create(&b,error,sizeof(error)));
 BAD(mt_context_update_camera(a,camera,128,error,sizeof(error)));
 OK(mt_context_commit(a,input,length,error,sizeof(error)));OK(mt_context_commit(b,input,length,error,sizeof(error)));
 OK(mt_context_render(a,samples,error,sizeof(error)));
 for(unsigned kind=0;kind<3;kind++)OK(read_image(a,kind,initial+kind*size,size));
 OK(mt_context_submit(a,1,&old,error,sizeof(error)));BAD(mt_context_update_camera(a,camera,128,error,sizeof(error)));
 OK(mt_job_cancel(old,error,sizeof(error)));BAD(mt_context_update_camera(a,NULL,128,error,sizeof(error)));
 BAD(mt_context_update_camera(a,camera,124,error,sizeof(error)));BAD(mt_context_update_camera(a,camera,132,error,sizeof(error)));
 /* Invalid lenses/projections, unknown fields, singular/non-affine transforms and NaNs. */
 const unsigned slots[]={0,1,2,3,8,9,10,11,12,13,16,19,31,28};
 const float values[]={0,NAN,0,0,0,-1,0,0,0,0,0,1,0,INFINITY};
 for(unsigned k=0;k<sizeof(slots)/sizeof(slots[0]);k++){
  memcpy(camera,original,128);if(k==0){uint32_t v=2;memcpy(camera,&v,4);}
  else if(k==9){uint32_t v=1;memcpy(camera+slots[k]*4,&v,4);}else memcpy(camera+slots[k]*4,&values[k],4);
  if(k==10)memset(camera+64,0,64);
  BAD(mt_context_update_camera(a,camera,128,error,sizeof(error)));
  OK(mt_context_info(a,&ci,error,sizeof(error)));REQUIRE(ci.samples==samples&&ci.state==1);
  OK(mt_job_info(old,&ji,error,sizeof(error)));REQUIRE(ji.state==3);
  OK(read_image(a,0,a_pixels,size));REQUIRE(memcmp(a_pixels,initial,size)==0);
 }
 for(unsigned variant=0;variant<6;variant++){
  memcpy(camera,original,128);float f[32];memcpy(f,camera,128);uint32_t projection;memcpy(&projection,camera,4);
  if(variant==0){f[28]+=.4f;f[29]+=.1f;}
  if(variant==1){projection=0;f[1]=63;f[2]=.02f;f[3]=200;f[8]=1.25f;f[9]=0;}
  if(variant==2){projection=0;f[9]=2.8f;f[10]=3;f[11]=36;f[12]=.3f;}
  if(variant==3){projection=1;f[2]=.01f;f[3]=100;f[4]=-3;f[5]=3;f[6]=-2;f[7]=2;f[8]=1.1f;}
  if(variant==4){f[20]+=.07f;f[28]-=.2f;}
  memcpy(camera,f,128);memcpy(camera,&projection,4);memcpy(source,camera,128);
  OK(mt_context_commit(b,input,length,error,sizeof(error)));
  OK(mt_context_update_camera(a,camera,128,error,sizeof(error)));memset(camera,0,128);
  OK(mt_context_info(a,&ci,error,sizeof(error)));REQUIRE(ci.samples==0&&ci.state==1);
  size_t written=0;BAD(mt_context_read_pixels(a,0,NULL,0,&written,error,sizeof(error)));
  BAD(mt_job_info(variant?job:old,&ji,error,sizeof(error)));
  OK(mt_context_submit(a,samples,&job,error,sizeof(error)));
  unsigned iteration=0;for(;iteration<60000;iteration++){
   OK(mt_job_poll(job,8,error,sizeof(error)));OK(mt_job_info(job,&ji,error,sizeof(error)));
   if(ji.state==2)break;REQUIRE(ji.state<=1);const struct timespec delay={0,1000000};nanosleep(&delay,NULL);
  }REQUIRE(iteration<60000&&ji.completed_samples==samples&&ji.base_samples==0);
  OK(mt_context_render(b,samples,error,sizeof(error)));
  for(unsigned kind=0;kind<3;kind++){
   OK(read_image(a,kind,a_pixels,size));OK(read_image(b,kind,b_pixels,size));REQUIRE(memcmp(a_pixels,b_pixels,size)==0);
   if(variant==5)REQUIRE(memcmp(a_pixels,initial+kind*size,size)==0);
   char path[4096];if(snprintf(path,sizeof(path),"%s/camera-%u-%u.rgba32f",argv[2],variant,kind)>=(int)sizeof(path))return 2;
   FILE *file=fopen(path,"wb");REQUIRE(file&&fwrite(a_pixels,1,size,file)==size);fclose(file);
  }
 }
 memcpy(camera,original,128);pthread_t thread;void *thread_result=NULL;struct thread_args args={a,camera};
 REQUIRE(pthread_create(&thread,NULL,wrong_thread,&args)==0);REQUIRE(pthread_join(thread,&thread_result)==0);REQUIRE((uintptr_t)thread_result==1);
 OK(read_image(a,0,a_pixels,size));REQUIRE(memcmp(a_pixels,initial,size)==0);
 OK(mt_context_update_camera(a,camera,128,error,sizeof(error)));OK(mt_context_info(a,&ci,error,sizeof(error)));REQUIRE(ci.samples==0);
 OK(mt_context_destroy(a,error,sizeof(error)));BAD(mt_context_update_camera(a,camera,128,error,sizeof(error)));OK(mt_context_destroy(b,error,sizeof(error)));
 free(input);free(initial);free(a_pixels);free(b_pixels);printf("PASS %u camera checks\n",checks);return 0;
}
