/* Real asynchronous GPU jobs: any-thread polling, draining cancellation and resume. */
#include "mutracer-context.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
_Static_assert(sizeof(mt_job_snapshot)==24,"job snapshot ABI");
static char error[4096];static unsigned checks;
#define REQUIRE(test) do{checks++;if(!(test)){fprintf(stderr,"line %d: %s; %s\n",__LINE__,#test,error);return 1;}}while(0)
#define OK(call) REQUIRE((call)==0)
#define FAILS(status,call) REQUIRE((call)==(status))
static int backend_is(mt_context context,uint32_t expected) {
 uint32_t actual=99;char reason[512];
 return mt_context_backend(context,&actual,reason,sizeof(reason),error,sizeof(error)) || actual!=expected;
}
static unsigned char *load(const char *path,size_t *size){
 FILE *f=fopen(path,"rb");if(!f||fseek(f,0,SEEK_END))return NULL;long n=ftell(f);if(n<0||fseek(f,0,SEEK_SET))return NULL;
 unsigned char *p=malloc(n?(size_t)n:1);if(!p||fread(p,1,(size_t)n,f)!=(size_t)n)return NULL;fclose(f);*size=(size_t)n;return p;
}
static int read_image(mt_context context,unsigned kind,unsigned char *output,size_t size){size_t written=0;
 return mt_context_read_pixels(context,kind,output,size,&written,error,sizeof(error))||written!=size;
}
static void pause_poll(void){const struct timespec delay={0,1000000};nanosleep(&delay,NULL);}
static void *other_thread(void *input){char message[128];mt_render_job id=*(mt_render_job*)input;
 mt_job_snapshot info={.struct_size=sizeof(info)};
 return (void*)(uintptr_t)(mt_job_info(id,&info,message,sizeof(message))==0);

}
int main(int argc,char **argv){
 if(argc!=5)return 2;size_t length=0;unsigned char *input=load(argv[1],&length);if(!input||length<128)return 2;
 uint32_t *words=(uint32_t*)input;size_t size=(size_t)words[2]*words[3]*16;
 unsigned samples=(unsigned)strtoul(argv[4],NULL,10);if(samples<8||samples>4096)return 2;
 unsigned char *a_pixels=malloc(size),*b_pixels=malloc(size);if(!a_pixels||!b_pixels)return 2;
 mt_context a=0,b=0;mt_render_job old=0,job_a=0,job_b=0;
 mt_job_snapshot info={.struct_size=sizeof(info)};mt_context_snapshot context_info={.struct_size=sizeof(context_info)};
 OK(mt_context_create_with_backend(MT_BACKEND_SOFTWARE,&a,error,sizeof(error)));OK(mt_context_create_with_backend(MT_BACKEND_SOFTWARE,&b,error,sizeof(error)));
 OK(mt_context_commit(a,input,length,error,sizeof(error)));OK(backend_is(a,MT_BACKEND_SOFTWARE));OK(mt_context_commit(b,input,length,error,sizeof(error)));OK(backend_is(b,MT_BACKEND_SOFTWARE));
 FAILS(MT_ERROR_INVALID_HANDLE,mt_job_info(0,&info,error,sizeof(error)));FAILS(MT_ERROR_INVALID_ARGUMENT,mt_context_submit(a,1,NULL,error,sizeof(error)));
 FAILS(MT_ERROR_INVALID_ARGUMENT,mt_context_submit(a,0,&old,error,sizeof(error)));FAILS(MT_ERROR_INVALID_ARGUMENT,mt_context_submit(a,4097,&old,error,sizeof(error)));
 OK(mt_context_submit(a,samples,&old,error,sizeof(error)));OK(mt_job_info(old,&info,error,sizeof(error)));
 REQUIRE(info.state==MT_JOB_QUEUED&&info.submitted_samples==0&&info.completed_samples==0&&info.base_samples==0);
 OK(mt_context_info(a,&context_info,error,sizeof(error)));REQUIRE(context_info.state==MT_CONTEXT_JOB_ACTIVE&&context_info.samples==0);
 FAILS(MT_ERROR_INVALID_STATE,mt_context_render(a,1,error,sizeof(error)));
 FAILS(MT_ERROR_INVALID_STATE,mt_context_reset(a,error,sizeof(error)));FAILS(MT_ERROR_INVALID_STATE,mt_context_destroy(a,error,sizeof(error)));
 size_t written=0;FAILS(MT_ERROR_INVALID_STATE,mt_context_read_pixels(a,MT_IMAGE_HDR,NULL,0,&written,error,sizeof(error)));
 FAILS(MT_ERROR_INVALID_STATE,mt_context_submit(a,1,&job_a,error,sizeof(error)));FAILS(MT_ERROR_INVALID_ARGUMENT,mt_job_poll(old,65,error,sizeof(error)));
 OK(mt_job_poll(old,0,error,sizeof(error)));OK(mt_job_info(old,&info,error,sizeof(error)));REQUIRE(info.submitted_samples==0);
 pthread_t thread;void *thread_result=NULL;REQUIRE(pthread_create(&thread,NULL,other_thread,&old)==0);
 REQUIRE(pthread_join(thread,&thread_result)==0);REQUIRE((uintptr_t)thread_result==1);
 OK(mt_job_cancel(old,error,sizeof(error)));OK(mt_job_cancel(old,error,sizeof(error)));
 OK(mt_job_info(old,&info,error,sizeof(error)));REQUIRE(info.state==MT_JOB_CANCELLED&&info.completed_samples==0);
 OK(mt_context_submit(a,samples,&job_a,error,sizeof(error)));REQUIRE(job_a!=old);FAILS(MT_ERROR_INVALID_HANDLE,mt_job_info(old,&info,error,sizeof(error)));
 OK(mt_job_poll(job_a,3,error,sizeof(error)));OK(mt_job_info(job_a,&info,error,sizeof(error)));
 REQUIRE(info.state==MT_JOB_RUNNING&&info.submitted_samples==3&&info.completed_samples==0);
 OK(mt_context_info(a,&context_info,error,sizeof(error)));REQUIRE(context_info.samples==0);
 OK(mt_job_cancel(job_a,error,sizeof(error)));OK(mt_job_info(job_a,&info,error,sizeof(error)));REQUIRE(info.state==MT_JOB_CANCELLING);
 unsigned iteration=0;
 for(;iteration<60000;iteration++){OK(mt_job_poll(job_a,0,error,sizeof(error)));OK(mt_job_info(job_a,&info,error,sizeof(error)));
  if(info.state==MT_JOB_CANCELLED)break;REQUIRE(info.state==MT_JOB_CANCELLING&&info.submitted_samples==3);pause_poll();}
 REQUIRE(iteration<60000&&info.completed_samples==3&&info.submitted_samples==3);
 OK(mt_context_info(a,&context_info,error,sizeof(error)));REQUIRE(context_info.state==MT_CONTEXT_COMMITTED&&context_info.samples==3);
 OK(mt_context_render(b,3,error,sizeof(error)));
 for(unsigned kind=0;kind<3;kind++){OK(read_image(a,kind,a_pixels,size));OK(read_image(b,kind,b_pixels,size));REQUIRE(memcmp(a_pixels,b_pixels,size)==0);}
 old=job_a;OK(mt_context_submit(a,samples-3,&job_a,error,sizeof(error)));FAILS(MT_ERROR_INVALID_HANDLE,mt_job_info(old,&info,error,sizeof(error)));
 OK(mt_context_submit(b,samples-3,&job_b,error,sizeof(error)));
 for(iteration=0;iteration<60000;iteration++){
  OK(mt_job_poll(job_a,8,error,sizeof(error)));OK(mt_job_poll(job_b,5,error,sizeof(error)));
  mt_job_snapshot other={.struct_size=sizeof(other)};OK(mt_job_info(job_a,&info,error,sizeof(error)));OK(mt_job_info(job_b,&other,error,sizeof(error)));
  REQUIRE(info.base_samples==3&&info.completed_samples<=info.submitted_samples&&info.submitted_samples<=samples-3);
  REQUIRE(other.base_samples==3&&other.completed_samples<=other.submitted_samples&&other.submitted_samples<=samples-3);
  if(info.state==MT_JOB_COMPLETE&&other.state==MT_JOB_COMPLETE)break;REQUIRE(info.state<=MT_JOB_COMPLETE&&other.state<=MT_JOB_COMPLETE);pause_poll();
 }
 REQUIRE(iteration<60000&&info.completed_samples==samples-3);
 const char *names[]={"render","normal","albedo"};
 for(unsigned kind=0;kind<3;kind++){
  OK(read_image(a,kind,a_pixels,size));OK(read_image(b,kind,b_pixels,size));REQUIRE(memcmp(a_pixels,b_pixels,size)==0);
  char path[4096];if(snprintf(path,sizeof(path),"%s/%s.rgba32f",argv[2],names[kind])>=(int)sizeof(path))return 2;
  size_t n=0;unsigned char *expected=load(path,&n);REQUIRE(expected&&n==size&&memcmp(a_pixels,expected,size)==0);free(expected);
  if(snprintf(path,sizeof(path),"%s/%s.rgba32f",argv[3],names[kind])>=(int)sizeof(path))return 2;
  FILE *f=fopen(path,"wb");REQUIRE(f&&fwrite(a_pixels,1,size,f)==size);fclose(f);
 }
 OK(mt_job_cancel(job_a,error,sizeof(error)));OK(mt_job_poll(job_a,64,error,sizeof(error)));
 OK(mt_job_info(job_a,&info,error,sizeof(error)));REQUIRE(info.state==MT_JOB_COMPLETE&&info.completed_samples==samples-3);
 uint32_t version=words[0];words[0]=99;FAILS(MT_ERROR_INVALID_ARGUMENT,mt_context_commit(b,input,length,error,sizeof(error)));words[0]=version;
 OK(mt_job_info(job_b,&info,error,sizeof(error)));REQUIRE(info.state==MT_JOB_COMPLETE);
 OK(mt_context_reset(a,error,sizeof(error)));FAILS(MT_ERROR_INVALID_HANDLE,mt_job_info(job_a,&info,error,sizeof(error)));
 OK(mt_context_commit(b,input,length,error,sizeof(error)));OK(backend_is(b,MT_BACKEND_SOFTWARE));FAILS(MT_ERROR_INVALID_HANDLE,mt_job_info(job_b,&info,error,sizeof(error)));
 /* Cancelling the final submitted batch still reaches complete, never partial cancellation. */
 OK(mt_context_submit(a,8,&job_a,error,sizeof(error)));OK(mt_job_poll(job_a,64,error,sizeof(error)));
 OK(mt_job_cancel(job_a,error,sizeof(error)));
 for(iteration=0;iteration<60000;iteration++){OK(mt_job_poll(job_a,0,error,sizeof(error)));OK(mt_job_info(job_a,&info,error,sizeof(error)));
  if(info.state==MT_JOB_COMPLETE)break;REQUIRE(info.state==MT_JOB_CANCELLING);pause_poll();}
 REQUIRE(iteration<60000&&info.requested_samples==8&&info.submitted_samples==8&&info.completed_samples==8);
 OK(mt_context_render(b,8,error,sizeof(error)));
 for(unsigned kind=0;kind<3;kind++){OK(read_image(a,kind,a_pixels,size));OK(read_image(b,kind,b_pixels,size));REQUIRE(memcmp(a_pixels,b_pixels,size)==0);}
 OK(mt_context_render(a,1,error,sizeof(error)));FAILS(MT_ERROR_INVALID_HANDLE,mt_job_info(job_a,&info,error,sizeof(error)));
 OK(mt_context_submit(b,8,&job_b,error,sizeof(error)));FAILS(MT_ERROR_INVALID_STATE,mt_context_destroy(b,error,sizeof(error)));
 OK(mt_job_cancel(job_b,error,sizeof(error)));OK(mt_context_destroy(b,error,sizeof(error)));FAILS(MT_ERROR_INVALID_HANDLE,mt_job_info(job_b,&info,error,sizeof(error)));
 OK(mt_context_destroy(a,error,sizeof(error)));free(input);free(a_pixels);free(b_pixels);
 printf("PASS %u job checks\n",checks);return 0;
}
