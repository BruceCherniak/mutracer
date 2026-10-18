/* C lifecycle/ownership consumer. Inputs are raw descriptors, never GPU captures. */
#include "mutracer-context.h"
#include "mutracer-scene.h"
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
_Static_assert(sizeof(mt_context_info_v1)==32,"context info ABI");
static char error[4096];
static unsigned checks;
#define REQUIRE(test) do {checks++;if(!(test)){fprintf(stderr,"line %d: %s; %s\n",__LINE__,#test,error);return 1;}}while(0)
#define OK(call) REQUIRE((call)==0)
#define BAD(call) REQUIRE((call)!=0)
static unsigned char *load(const char *path,size_t *length) {
  FILE *file=fopen(path,"rb");if(!file||fseek(file,0,SEEK_END))return NULL;
  long size=ftell(file);if(size<0||fseek(file,0,SEEK_SET))return NULL;
  unsigned char *data=malloc(size?(size_t)size:1);if(!data||fread(data,1,(size_t)size,file)!=(size_t)size)return NULL;
  fclose(file);*length=(size_t)size;return data;
}
static int save(const char *directory,const char *name,const unsigned char *data,size_t size) {
  char path[4096];if(snprintf(path,sizeof(path),"%s/%s.rgba32f",directory,name)>=(int)sizeof(path))return 1;
  FILE *file=fopen(path,"wb");if(!file)return 1;int failed=fwrite(data,1,size,file)!=size;fclose(file);return failed;
}
static int read_image(mt_context handle,uint32_t kind,unsigned char *pixels,size_t size) {
  size_t written=0;int code=mt_context_read_pixels(handle,kind,pixels,size,&written,error,sizeof(error));
  if(code||written!=size)return 1;
  for(size_t i=0;i<size;i+=4){float value;memcpy(&value,pixels+i,4);if(!isfinite(value))return 1;}
  return 0;
}
struct thread_input { mt_context context; const unsigned char *input; size_t length; };
static void *wrong_thread(void *argument) {
  const struct thread_input *args=argument;
  mt_context_info_v1 info={.struct_size=sizeof(info)};char message[128];
  int code=mt_context_info(args->context,&info,message,sizeof(message));
  int rejected=code!=0&&strstr(message,"owner")!=NULL;
  code=mt_probe_render_scene(args->input,args->length,"/dev/null/wrong-thread",1,message,sizeof(message));
  return (void*)(uintptr_t)(rejected&&code!=0&&strstr(message,"owner")!=NULL);
}
int main(int argc,char **argv) {
  if(argc!=5)return 2;
  size_t length=0;unsigned char *input=load(argv[1],&length);if(!input||length<128)return 2;
  unsigned samples=(unsigned)strtoul(argv[4],NULL,10);if(samples<8||samples>4096)return 2;
  uint32_t *words=(uint32_t*)input;size_t size=(size_t)words[2]*words[3]*16;
  unsigned char *pixels=malloc(size),*other=malloc(size),*reference=malloc(size);if(!pixels||!other||!reference)return 2;
  mt_context a=0,b=0,c=0;mt_context_info_v1 info={.struct_size=sizeof(info)};
  BAD(mt_context_create_with_backend(2,&c,error,sizeof(error)));REQUIRE(c==0);
  BAD(mt_context_create_with_backend(3,&c,error,sizeof(error)));REQUIRE(c==0);
  OK(mt_context_create(&c,error,sizeof(error)));OK(mt_context_commit(c,input,length,error,sizeof(error)));
  uint32_t actual=99;char reason[256];OK(mt_context_backend(c,&actual,reason,sizeof(reason),error,sizeof(error)));
  REQUIRE(actual<=1);REQUIRE(reason[0]!=0); /* HWRT reports software-BVH count; fallback reports cause. */
  OK(mt_context_destroy(c,error,sizeof(error)));c=0;
  BAD(mt_context_info(0,&info,error,sizeof(error)));
  BAD(mt_context_create_with_backend(0,NULL,error,sizeof(error)));
  OK(mt_context_create_with_backend(0,&a,error,sizeof(error)));OK(mt_context_create_with_backend(0,&b,error,sizeof(error)));REQUIRE(a!=b&&a&&b);
  OK(mt_context_info(a,&info,error,sizeof(error)));REQUIRE(info.state==0&&info.samples==0&&info.version==1);
  BAD(mt_context_render(a,1,error,sizeof(error)));BAD(mt_context_reset(a,error,sizeof(error)));BAD(mt_context_wait(a,error,sizeof(error)));
  size_t written=999;BAD(mt_context_read_pixels(a,0,NULL,0,&written,error,sizeof(error)));REQUIRE(written==0);
  info.struct_size=0;BAD(mt_context_info(a,&info,error,sizeof(error)));info.struct_size=sizeof(info);
  OK(mt_context_commit(a,input,length,error,sizeof(error)));
  OK(mt_context_commit(b,input,length,error,sizeof(error)));
  OK(mt_context_info(a,&info,error,sizeof(error)));REQUIRE(info.state==1&&info.samples==0&&info.width==words[2]&&info.height==words[3]);
  BAD(mt_context_render(a,0,error,sizeof(error)));BAD(mt_context_render(a,4097,error,sizeof(error)));
  OK(mt_context_render(a,samples/4,error,sizeof(error)));
  OK(mt_context_render(b,samples/4,error,sizeof(error)));
  OK(mt_context_wait(a,error,sizeof(error)));OK(mt_context_info(a,&info,error,sizeof(error)));REQUIRE(info.samples==samples/4);
  for(uint32_t kind=0;kind<3;kind++){OK(read_image(a,kind,pixels,size));OK(read_image(b,kind,other,size));REQUIRE(memcmp(pixels,other,size)==0);}
  OK(mt_context_render(b,1,error,sizeof(error)));
  OK(mt_context_info(a,&info,error,sizeof(error)));REQUIRE(info.samples==samples/4);
  OK(mt_context_render(a,samples-samples/4,error,sizeof(error)));
  const char *names[]={"render","normal","albedo"};
  for(uint32_t kind=0;kind<3;kind++){
    char path[4096];if(snprintf(path,sizeof(path),"%s/%s.rgba32f",argv[2],names[kind])>=(int)sizeof(path))return 2;
    size_t expected_size=0;unsigned char *expected=load(path,&expected_size);REQUIRE(expected&&expected_size==size);
    OK(read_image(a,kind,pixels,size));REQUIRE(memcmp(pixels,expected,size)==0);free(expected);
    OK(save(argv[3],names[kind],pixels,size));
  }
  /* Reusing a retired buffer generation must reset accumulation and guides. */
  for(unsigned repeat=0;repeat<2;repeat++)OK(mt_context_commit(a,input,length,error,sizeof(error)));
  OK(mt_context_info(a,&info,error,sizeof(error)));REQUIRE(info.samples==0);
  OK(mt_context_render(a,samples,error,sizeof(error)));
  for(uint32_t kind=0;kind<3;kind++){
    char path[4096];if(snprintf(path,sizeof(path),"%s/%s.rgba32f",argv[2],names[kind])>=(int)sizeof(path))return 2;
    size_t expected_size=0;unsigned char *expected=load(path,&expected_size);REQUIRE(expected&&expected_size==size);
    OK(read_image(a,kind,pixels,size));REQUIRE(memcmp(pixels,expected,size)==0);free(expected);
  }
  OK(mt_context_read_pixels(a,0,NULL,0,&written,error,sizeof(error)));REQUIRE(written==size);
  unsigned char short_buffer[8];memset(short_buffer,0xa5,sizeof(short_buffer));
  BAD(mt_context_read_pixels(a,0,short_buffer,sizeof(short_buffer),&written,error,sizeof(error)));
  REQUIRE(written==size);for(size_t i=0;i<sizeof(short_buffer);i++)REQUIRE(short_buffer[i]==0xa5);
  BAD(mt_context_read_pixels(a,3,NULL,0,&written,error,sizeof(error)));
  BAD(mt_context_read_pixels(a,0,NULL,size,&written,error,sizeof(error)));
  OK(read_image(a,0,reference,size));
  uint32_t version=words[0];words[0]=99;BAD(mt_context_commit(a,input,length,error,sizeof(error)));words[0]=version;
  if(words[words[12]+10]){
    uint32_t offset=words[words[12]+9],saved=words[offset];words[offset]=0;
    BAD(mt_context_commit(a,input,length,error,sizeof(error)));words[offset]=saved;
  }
  OK(mt_context_info(a,&info,error,sizeof(error)));REQUIRE(info.state==1&&info.samples==samples);
  OK(read_image(a,0,pixels,size));REQUIRE(memcmp(pixels,reference,size)==0);
  OK(mt_context_reset(a,error,sizeof(error)));OK(mt_context_info(a,&info,error,sizeof(error)));REQUIRE(info.samples==0);
  BAD(mt_context_read_pixels(a,0,NULL,0,&written,error,sizeof(error)));
  OK(mt_context_render(a,1,error,sizeof(error)));OK(mt_context_render(a,samples-1,error,sizeof(error)));
  OK(read_image(a,0,pixels,size));REQUIRE(memcmp(pixels,reference,size)==0);
  /* A complete camera edit commits on B while A retains its accumulation. */
  uint32_t camera_x=words[14]+16+12,saved_x=words[camera_x];float x;memcpy(&x,words+camera_x,4);x+=.4f;memcpy(words+camera_x,&x,4);
  OK(mt_context_commit(b,input,length,error,sizeof(error)));words[camera_x]=saved_x;
  OK(mt_context_info(b,&info,error,sizeof(error)));REQUIRE(info.samples==0);
  OK(mt_context_render(b,samples,error,sizeof(error)));OK(read_image(b,0,other,size));
  int empty=words[23]!=0;
  if(empty)for(uint32_t i=0;i<words[5];i++)if(words[words[23]+i*4]!=0)empty=0;
  if(!empty)REQUIRE(memcmp(other,reference,size)!=0);
  OK(read_image(a,0,pixels,size));REQUIRE(memcmp(pixels,reference,size)==0);
  pthread_t thread;void *thread_result=NULL;struct thread_input thread_args={b,input,length};
  REQUIRE(pthread_create(&thread,NULL,wrong_thread,&thread_args)==0);
  REQUIRE(pthread_join(thread,&thread_result)==0);REQUIRE((uintptr_t)thread_result==1);
  OK(read_image(b,0,pixels,size));REQUIRE(memcmp(pixels,other,size)==0);
  OK(mt_context_destroy(a,error,sizeof(error)));BAD(mt_context_destroy(a,error,sizeof(error)));
  BAD(mt_context_info(a,&info,error,sizeof(error)));OK(mt_context_create_with_backend(0,&c,error,sizeof(error)));REQUIRE(c!=a&&c!=b);
  BAD(mt_context_info(a,&info,error,sizeof(error)));OK(mt_context_destroy(c,error,sizeof(error)));
  OK(read_image(b,0,pixels,size));REQUIRE(memcmp(pixels,other,size)==0);OK(mt_context_destroy(b,error,sizeof(error)));
  free(input);free(pixels);free(other);free(reference);printf("PASS %u context checks\n",checks);return 0;
}
