/* C SDK consumer. Platform glue owns/pumps a real window; no offscreen substitute.
 * Build/run instructions live in native/CONTRIBUTING.md. */
#include "mutracer-engine.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "host-atomic.h"
#include "host-thread.h"
#if defined(_WIN32)
#define MT_EXAMPLE_WINDOW_KIND MT_WINDOW_WIN32
#else
#define MT_EXAMPLE_WINDOW_KIND MT_WINDOW_APPKIT
#endif

void *mt_example_window_create(void);
void mt_example_window_pump(void);
void mt_example_window_destroy(void *window);
#if defined(_WIN32)
int mt_example_window_minimize(void *window);
int mt_example_window_restore(void *window,unsigned width,unsigned height);
#endif
static char message[1024];
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"FAIL %s: %s\n",#x,message); exit(1); } } while(0)
#define OK(x) CHECK((x)==MT_OK)
static mt_host_atomic calls, releases, compilation;
static int32_t identity(const mt_denoise_input *input, float *output, char *error, size_t capacity, void *user) {
  (void)error; (void)capacity; (void)user;
  CHECK(input->count == (size_t)input->width * input->height * 4);
  CHECK(!mt_denoise_cancelled(input->cancel));
  memcpy(output,input->color,input->count*sizeof(float));
  mt_host_atomic_increment(&calls);
  return 0;
}
static void released(void *user) { (void)user; mt_host_atomic_increment(&releases); }
static void event(const mt_engine_event *e, void *user) {
  (void)user;
  if (e->kind==MT_ENGINE_EVENT_COMPILATION) mt_host_atomic_increment(&compilation);
}
static void *wrong_thread(void *argument) {
  const uint64_t *handles=argument;
  mt_engine engine=handles[0];
  mt_engine_snapshot info={.struct_size=sizeof info};
  char error[256];
  CHECK(mt_engine_info(engine,&info,error,sizeof error)==MT_ERROR_INVALID_STATE);
  mt_display display;
  CHECK(mt_engine_display(engine,&display,error,sizeof error)==MT_ERROR_INVALID_STATE);
  CHECK(mt_render_destroy(handles[1],error,sizeof error)==MT_ERROR_INVALID_STATE);
  CHECK(mt_render_cancel(handles[1],error,sizeof error)==MT_OK);
  CHECK(mt_engine_destroy(engine,error,sizeof error)==MT_ERROR_INVALID_STATE);
  return NULL;
}
static void present(mt_display display, mt_render render) {
  uint32_t shown=0;
  mt_surface_info info={.struct_size=sizeof info};
  for (int i=0;i<120;i++) {
    mt_example_window_pump();
    OK(mt_display_present(display,render,&shown,NULL,message,sizeof message));
    OK(mt_display_surface_info(display,&info,message,sizeof message));
    if (info.status==MT_SURFACE_PRESENTED) { CHECK(shown); return; }
  }
  CHECK(0 && "window never presented");
}
int main(int argc, char **argv) {
  CHECK(argc==2);
  FILE *f=fopen(argv[1],"rb"); CHECK(f);
  CHECK(fseek(f,0,SEEK_END)==0); long length=ftell(f); CHECK(length>0); rewind(f);
  uint8_t *scene=malloc((size_t)length); CHECK(scene);
  CHECK(fread(scene,1,(size_t)length,f)==(size_t)length); fclose(f);
  void *window=mt_example_window_create(); CHECK(window);
  mt_native_window native={.struct_size=sizeof native,.kind=MT_EXAMPLE_WINDOW_KIND,.width=160,.height=120,.window=window};
  mt_engine_options options; OK(mt_engine_options_default(&options)); options.backend=MT_BACKEND_SOFTWARE;
  mt_engine engine=0; mt_display display=0; mt_render render=0;
  OK(mt_engine_create_for_window(&options,&native,&engine,message,sizeof message));
  OK(mt_engine_display(engine,&display,message,sizeof message));
  OK(mt_engine_set_callback(engine,event,NULL,message,sizeof message));
  mt_render_options render_options; OK(mt_render_options_default(&render_options)); render_options.max_samples=2;
  OK(mt_render_create(engine,&render_options,&render,message,sizeof message));
  uint64_t handles[2]={engine,render};
  mt_host_thread thread; CHECK(mt_host_thread_start(&thread,wrong_thread,handles)==0); CHECK(mt_host_thread_join(&thread,NULL)==0);
  mt_custom_denoiser custom={.struct_size=sizeof custom,.schedule=MT_DENOISE_CONVERGED,.callback=identity,.release=released};
  OK(mt_render_set_custom_denoiser(render,&custom,message,sizeof message));
  OK(mt_engine_set_scene(engine,scene,(size_t)length,message,sizeof message));
  OK(mt_engine_update(engine,NULL,message,sizeof message));
  mt_converge_options converge; OK(mt_converge_options_default(2,&converge));
  OK(mt_render_converge(render,&converge,NULL,message,sizeof message));
  present(display,render);
  mt_engine_diagnostics_info diagnostics={.struct_size=sizeof diagnostics};
  OK(mt_engine_diagnostics(engine,&diagnostics,message,sizeof message));
  CHECK(diagnostics.has_scene && diagnostics.compilations_started && diagnostics.renders==1);
  CHECK(diagnostics.compilations_started==diagnostics.compilations_completed);
  CHECK(mt_host_atomic_load(&calls)==1 && mt_host_atomic_load(&compilation)>=2);
  #if defined(_WIN32)
  CHECK(mt_example_window_minimize(window));mt_example_window_pump();
  #endif
  OK(mt_display_resize_window(display,0,0,message,sizeof message));
  mt_surface_info info={.struct_size=sizeof info};
  OK(mt_display_present(display,render,NULL,NULL,message,sizeof message));
  OK(mt_display_surface_info(display,&info,message,sizeof message)); CHECK(info.status==MT_SURFACE_SUSPENDED);
  #if defined(_WIN32)
  CHECK(mt_example_window_restore(window,96,64));mt_example_window_pump();
  #endif
  OK(mt_display_resize_window(display,96,64,message,sizeof message));
  OK(mt_render_converge(render,&converge,NULL,message,sizeof message)); present(display,render);
  OK(mt_display_detach_window(display,message,sizeof message));
  OK(mt_display_surface_info(display,&info,message,sizeof message)); CHECK(!info.attached);
  native.width=0xffffffffu;
  CHECK(mt_display_attach_window(display,&native,message,sizeof message)==MT_ERROR_INVALID_ARGUMENT);
  native.width=96; native.height=64;
  OK(mt_display_attach_window(display,&native,message,sizeof message)); present(display,render);
  mt_display_settings settings; OK(mt_display_settings_default(&settings)); settings.hdr_output_enabled=1;
  OK(mt_display_set_settings(display,&settings,message,sizeof message)); present(display,render);
  OK(mt_display_surface_info(display,&info,message,sizeof message)); CHECK(info.hdr_requested);
  CHECK(info.hdr_active || info.hdr_unavailable_reason[0]);
  printf("C window HDR: requested=%u active=%u format=%s fallback=%s\n",info.hdr_requested,info.hdr_active,info.format,info.hdr_unavailable_reason);
  OK(mt_display_resize_window(display,96,64,message,sizeof message));
  OK(mt_engine_clear_scene(engine,message,sizeof message)); OK(mt_engine_update(engine,NULL,message,sizeof message));
  uint32_t status=0;
  OK(mt_render_refine(render,&status,message,sizeof message)); CHECK(status==MT_RENDER_IDLE);
  uint32_t shown=99; OK(mt_display_present(display,render,&shown,NULL,message,sizeof message)); CHECK(!shown);
  OK(mt_display_surface_info(display,&info,message,sizeof message)); CHECK(info.status==MT_SURFACE_PRESENTED);
  OK(mt_engine_set_scene(engine,scene,(size_t)length,message,sizeof message)); OK(mt_engine_update(engine,NULL,message,sizeof message));
  OK(mt_render_converge(render,&converge,NULL,message,sizeof message)); present(display,render);
  OK(mt_render_set_custom_denoiser(render,NULL,message,sizeof message)); for (int i=0;i<1000 && !mt_host_atomic_load(&releases);i++) { mt_example_window_pump(); } CHECK(mt_host_atomic_load(&releases)==1);
  OK(mt_engine_destroy(engine,message,sizeof message)); mt_example_window_destroy(window); free(scene);
  puts("PASS C window presentation, suspension, resize, detach/reattach, clear/reload, diagnostics and custom denoising");
  return 0;
}
