/* Real Vulkan C consumer: compile against the SDK headers and negotiate all
 * MuTracer requirements before creating the host-owned device. */
#define VK_NO_PROTOTYPES
#include "mutracer-vulkan.h"
#include "mutracer-scene-api.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "host-atomic.h"
#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif
static char message[4096];
#define REQUIRE(x) do {if(!(x)){fprintf(stderr,"FAIL line %d: %s; %s\n",__LINE__,#x,message);exit(1);}}while(0)
#define OK(x) REQUIRE((x)==MT_OK)
#define VK_OK(x) REQUIRE((x)==VK_SUCCESS)
#define INSTANCE_PROC(name) PFN_##name name=(PFN_##name)get_proc(instance,#name);REQUIRE(name)
#define DEVICE_PROC(name) PFN_##name name=(PFN_##name)vkGetDeviceProcAddr(device,#name);REQUIRE(name)
static mt_host_atomic instance_retired, device_retired, pass_calls;
static PFN_vkCmdClearColorImage clear_image;
static mt_host_atomic fail_pass;
static void retired(void *user) {mt_host_atomic_increment((mt_host_atomic *)user);}
static int32_t post_process(const mt_vk_pass_context *ctx,void *user) {
  (void)user;REQUIRE(ctx->struct_size==sizeof *ctx);
  REQUIRE(ctx->format==VK_FORMAT_R8G8B8A8_UNORM);
  mt_host_atomic_increment(&pass_calls);
  if(mt_host_atomic_load(&fail_pass)) return MT_ERROR;
  /* Use byte-center values: Vulkan's normalized fixed-point conversion permits
   * either adjacent integer at a rounding boundary such as 0.5 * 255. */
  VkClearColorValue color={.float32={64.f/255.f,128.f/255.f,191.f/255.f,1.f}};
  VkImageSubresourceRange range={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1};
  clear_image(ctx->commands,ctx->output,VK_IMAGE_LAYOUT_GENERAL,&color,1,&range);
  return MT_OK;
}
int main(int argc,char **argv) {
  uint32_t traversal=argc>1?(uint32_t)atoi(argv[1]):0;
  REQUIRE(traversal<=1 && mt_abi_version()==8);
#if defined(_WIN32)
  HMODULE driver=LoadLibraryA("vulkan-1.dll");REQUIRE(driver);
  PFN_vkGetInstanceProcAddr get_proc=(PFN_vkGetInstanceProcAddr)GetProcAddress(driver,"vkGetInstanceProcAddr");
#else
  void *driver=dlopen("libvulkan.so.1",RTLD_NOW);REQUIRE(driver);
  PFN_vkGetInstanceProcAddr get_proc=(PFN_vkGetInstanceProcAddr)dlsym(driver,"vkGetInstanceProcAddr");
#endif
  REQUIRE(get_proc);
  PFN_vkCreateInstance create_instance=(PFN_vkCreateInstance)get_proc(VK_NULL_HANDLE,"vkCreateInstance");REQUIRE(create_instance);
  size_t count=0;OK(mt_vk_instance_extensions(get_proc,VK_API_VERSION_1_2,NULL,0,&count,message,sizeof message));
  const char **extensions=(const char **)calloc(count?count:1,sizeof *extensions);REQUIRE(extensions);
  OK(mt_vk_instance_extensions(get_proc,VK_API_VERSION_1_2,extensions,count,&count,message,sizeof message));
  VkApplicationInfo app={.sType=VK_STRUCTURE_TYPE_APPLICATION_INFO,.apiVersion=VK_API_VERSION_1_2};
  VkInstanceCreateInfo ici={.sType=VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,.pApplicationInfo=&app,.enabledExtensionCount=(uint32_t)count,.ppEnabledExtensionNames=extensions};
  VkInstance instance=VK_NULL_HANDLE;VK_OK(create_instance(&ici,NULL,&instance));
  INSTANCE_PROC(vkDestroyInstance);INSTANCE_PROC(vkEnumeratePhysicalDevices);INSTANCE_PROC(vkGetPhysicalDeviceProperties);
  INSTANCE_PROC(vkGetPhysicalDeviceQueueFamilyProperties);INSTANCE_PROC(vkCreateDevice);INSTANCE_PROC(vkGetDeviceProcAddr);
  INSTANCE_PROC(vkGetPhysicalDeviceMemoryProperties);
  uint32_t physical_count=0;VK_OK(vkEnumeratePhysicalDevices(instance,&physical_count,NULL));REQUIRE(physical_count);
  VkPhysicalDevice *physical_devices=(VkPhysicalDevice *)calloc(physical_count,sizeof *physical_devices);REQUIRE(physical_devices);
  VK_OK(vkEnumeratePhysicalDevices(instance,&physical_count,physical_devices));
  VkPhysicalDevice physical=VK_NULL_HANDLE;VkPhysicalDeviceProperties properties={0};
  for(uint32_t i=0;i<physical_count;i++) {
    VkPhysicalDeviceProperties p;vkGetPhysicalDeviceProperties(physical_devices[i],&p);
    if(p.deviceType==VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU){physical=physical_devices[i];properties=p;break;}
  }
  REQUIRE(physical);free(physical_devices);
  printf("Vulkan C host: %s; Vulkan %u.%u.%u; requested traversal %u\n",properties.deviceName,VK_API_VERSION_MAJOR(properties.apiVersion),VK_API_VERSION_MINOR(properties.apiVersion),VK_API_VERSION_PATCH(properties.apiVersion),traversal);
  uint32_t family_count=0;vkGetPhysicalDeviceQueueFamilyProperties(physical,&family_count,NULL);
  VkQueueFamilyProperties *families=(VkQueueFamilyProperties *)calloc(family_count,sizeof *families);REQUIRE(families);
  vkGetPhysicalDeviceQueueFamilyProperties(physical,&family_count,families);
  uint32_t family=UINT32_MAX;for(uint32_t i=0;i<family_count;i++)if((families[i].queueFlags&(VK_QUEUE_GRAPHICS_BIT|VK_QUEUE_COMPUTE_BIT))==(VK_QUEUE_GRAPHICS_BIT|VK_QUEUE_COMPUTE_BIT)){family=i;break;}
  REQUIRE(family!=UINT32_MAX);free(families);
  mt_vk_host_desc host={.struct_size=sizeof host,.api_version=VK_API_VERSION_1_2,.instance=instance,.physical_device=physical,.get_proc=get_proc,.instance_extensions=extensions,.instance_extension_count=count,.retired=retired,.retired_user=(void *)&instance_retired};
  mt_engine_options options;OK(mt_engine_options_default(&options));options.backend=traversal;
  mt_vk_device_plan plan=0;mt_vk_device_requirements requirements;
  OK(mt_vk_device_plan_create(&host,&options,&plan,&requirements,message,sizeof message));
  if(traversal)REQUIRE(requirements.hardware_ray_query);
  float priority=1;VkDeviceQueueCreateInfo qci={.sType=VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,.queueFamilyIndex=family,.queueCount=1,.pQueuePriorities=&priority};
  VkDeviceCreateInfo dci={.sType=VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,.pNext=requirements.features_next,.queueCreateInfoCount=1,.pQueueCreateInfos=&qci,.enabledExtensionCount=(uint32_t)requirements.extension_count,.ppEnabledExtensionNames=requirements.extensions,.pEnabledFeatures=requirements.features};
  VkDevice device=VK_NULL_HANDLE;VK_OK(vkCreateDevice(physical,&dci,NULL,&device));
  DEVICE_PROC(vkDestroyDevice);DEVICE_PROC(vkDeviceWaitIdle);DEVICE_PROC(vkCreateImage);DEVICE_PROC(vkDestroyImage);
  DEVICE_PROC(vkGetImageMemoryRequirements);DEVICE_PROC(vkAllocateMemory);DEVICE_PROC(vkFreeMemory);DEVICE_PROC(vkBindImageMemory);
  DEVICE_PROC(vkCreateCommandPool);DEVICE_PROC(vkDestroyCommandPool);DEVICE_PROC(vkAllocateCommandBuffers);
  DEVICE_PROC(vkBeginCommandBuffer);DEVICE_PROC(vkEndCommandBuffer);DEVICE_PROC(vkCmdPipelineBarrier);DEVICE_PROC(vkCmdCopyImage);
  DEVICE_PROC(vkQueueSubmit);DEVICE_PROC(vkQueueWaitIdle);
  DEVICE_PROC(vkCreateBuffer);DEVICE_PROC(vkDestroyBuffer);DEVICE_PROC(vkGetBufferMemoryRequirements);DEVICE_PROC(vkBindBufferMemory);
  DEVICE_PROC(vkMapMemory);DEVICE_PROC(vkUnmapMemory);DEVICE_PROC(vkCmdCopyImageToBuffer);
  clear_image=(PFN_vkCmdClearColorImage)vkGetDeviceProcAddr(device,"vkCmdClearColorImage");REQUIRE(clear_image);
  mt_vk_device_desc imported={.struct_size=sizeof imported,.queue_family=family,.queue_index=0,.device=device,.retired=retired,.retired_user=(void *)&device_retired};
  mt_engine engine=0;OK(mt_engine_create_vulkan(plan,&imported,&engine,message,sizeof message));
  OK(mt_vk_device_plan_destroy(plan,message,sizeof message));
  mt_vk_device_info info;OK(mt_engine_vulkan_info(engine,&info,message,sizeof message));
  REQUIRE(info.instance==instance && info.physical_device==physical && info.device==device && info.queue_family==family && info.queue_index==0);
  mt_vk_lease early=0;OK(mt_engine_vulkan_acquire_queue(engine,&early,message,sizeof message));OK(mt_vk_lease_release(early,message,sizeof message));
  mt_scene scene=0;OK(mt_scene_create(&scene,message,sizeof message));
  float positions[]={99,0,-2,100,0,-2,99,1,-2};uint32_t indices[]={0,1,2};
  mt_scene_geometry_desc geometry;OK(mt_scene_geometry_desc_default(&geometry));geometry.positions=positions;geometry.vertex_count=3;geometry.indices=indices;geometry.index_count=3;
  mt_scene_geometry_id g;OK(mt_scene_add_geometry(scene,&geometry,&g,message,sizeof message));
  mt_scene_material_desc material;OK(mt_scene_material_desc_default(&material));mt_scene_material_id m;OK(mt_scene_add_material(scene,&material,&m,message,sizeof message));
  mt_scene_mesh_desc mesh;OK(mt_scene_mesh_desc_default(&mesh));mesh.geometry=g;mesh.material=m;mt_scene_mesh_id mesh_id;OK(mt_scene_add_mesh(scene,&mesh,&mesh_id,message,sizeof message));
  float background[]={.25f,.5f,1.f,1.f};mt_scene_texture_desc td;OK(mt_scene_texture_desc_default(&td));td.storage=1;td.width=td.height=1;td.pixels=background;td.pixel_bytes=sizeof background;
  mt_scene_texture_id environment;OK(mt_scene_add_texture(scene,&td,&environment,message,sizeof message));
  mt_scene_environment_desc env;OK(mt_scene_environment_desc_default(&env));env.environment=env.background=environment;
  OK(mt_scene_set_environment(scene,&env,message,sizeof message));
  mt_render_options ro;OK(mt_render_options_default(&ro));ro.width=8;ro.height=6;ro.max_samples=1;ro.bounces=1;ro.bevel=0;ro.aovs=MT_AOV_DEPTH|MT_AOV_ID;
  mt_render render=0;OK(mt_render_create(engine,&ro,&render,message,sizeof message));
  OK(mt_engine_set_scene_object(engine,scene,message,sizeof message));OK(mt_engine_update(engine,NULL,message,sizeof message));
  mt_converge_options co;OK(mt_converge_options_default(1,&co));OK(mt_render_converge(render,&co,NULL,message,sizeof message));
  mt_render_snapshot active={.struct_size=sizeof active};OK(mt_render_info(render,&active,message,sizeof message));REQUIRE(active.backend==traversal);
  mt_vk_image_info image;OK(mt_render_vulkan_acquire_image(render,0,&image,message,sizeof message));
  REQUIRE(image.width==8 && image.height==6 && image.format==VK_FORMAT_R32G32B32A32_SFLOAT);
  size_t written=0;uint32_t ids[8*6*4];
  REQUIRE(mt_render_read_pixels(render,MT_IMAGE_ID,ids,sizeof ids,&written,message,sizeof message)==MT_ERROR_INVALID_STATE);
  REQUIRE(mt_engine_destroy(engine,message,sizeof message)==MT_ERROR_INVALID_STATE);
  VkImageCreateInfo image_create={.sType=VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO,.imageType=VK_IMAGE_TYPE_2D,.format=VK_FORMAT_R32G32B32A32_SFLOAT,.extent={8,6,1},.mipLevels=1,.arrayLayers=1,.samples=VK_SAMPLE_COUNT_1_BIT,.tiling=VK_IMAGE_TILING_OPTIMAL,.usage=VK_IMAGE_USAGE_TRANSFER_DST_BIT|VK_IMAGE_USAGE_SAMPLED_BIT,.sharingMode=VK_SHARING_MODE_EXCLUSIVE,.initialLayout=VK_IMAGE_LAYOUT_UNDEFINED};
  VkImage copied;VK_OK(vkCreateImage(device,&image_create,NULL,&copied));VkMemoryRequirements mem;vkGetImageMemoryRequirements(device,copied,&mem);
  VkPhysicalDeviceMemoryProperties memory_properties;vkGetPhysicalDeviceMemoryProperties(physical,&memory_properties);uint32_t memory_type=UINT32_MAX;
  for(uint32_t i=0;i<memory_properties.memoryTypeCount;i++)if((mem.memoryTypeBits&(1u<<i))&&(memory_properties.memoryTypes[i].propertyFlags&VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)){memory_type=i;break;}
  REQUIRE(memory_type!=UINT32_MAX);VkMemoryAllocateInfo alloc={.sType=VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,.allocationSize=mem.size,.memoryTypeIndex=memory_type};
  VkDeviceMemory allocation;VK_OK(vkAllocateMemory(device,&alloc,NULL,&allocation));VK_OK(vkBindImageMemory(device,copied,allocation,0));
  VkBufferCreateInfo buffer_info={.sType=VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,.size=8*6*16,.usage=VK_BUFFER_USAGE_TRANSFER_DST_BIT,.sharingMode=VK_SHARING_MODE_EXCLUSIVE};
  VkBuffer readback;VK_OK(vkCreateBuffer(device,&buffer_info,NULL,&readback));vkGetBufferMemoryRequirements(device,readback,&mem);
  memory_type=UINT32_MAX;for(uint32_t i=0;i<memory_properties.memoryTypeCount;i++)if((mem.memoryTypeBits&(1u<<i))&&(memory_properties.memoryTypes[i].propertyFlags&(VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT|VK_MEMORY_PROPERTY_HOST_COHERENT_BIT))==(VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT|VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)){memory_type=i;break;}
  REQUIRE(memory_type!=UINT32_MAX);alloc.allocationSize=mem.size;alloc.memoryTypeIndex=memory_type;
  VkDeviceMemory readback_memory;VK_OK(vkAllocateMemory(device,&alloc,NULL,&readback_memory));VK_OK(vkBindBufferMemory(device,readback,readback_memory,0));
  VkCommandPoolCreateInfo pool_info={.sType=VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,.queueFamilyIndex=family};VkCommandPool pool;VK_OK(vkCreateCommandPool(device,&pool_info,NULL,&pool));
  VkCommandBufferAllocateInfo command_info={.sType=VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,.commandPool=pool,.level=VK_COMMAND_BUFFER_LEVEL_PRIMARY,.commandBufferCount=1};VkCommandBuffer command;VK_OK(vkAllocateCommandBuffers(device,&command_info,&command));
  VkCommandBufferBeginInfo begin={.sType=VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,.flags=VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};VK_OK(vkBeginCommandBuffer(command,&begin));
  VkImageSubresourceRange range={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1};
  VkImageMemoryBarrier barriers[2]={
    {.sType=VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,.srcAccessMask=VK_ACCESS_SHADER_READ_BIT,.dstAccessMask=VK_ACCESS_TRANSFER_READ_BIT,.oldLayout=(VkImageLayout)image.layout,.newLayout=VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,.srcQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED,.dstQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED,.image=image.image,.subresourceRange=range},
    {.sType=VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,.dstAccessMask=VK_ACCESS_TRANSFER_WRITE_BIT,.oldLayout=VK_IMAGE_LAYOUT_UNDEFINED,.newLayout=VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,.srcQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED,.dstQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED,.image=copied,.subresourceRange=range}};
  vkCmdPipelineBarrier(command,VK_PIPELINE_STAGE_ALL_COMMANDS_BIT,VK_PIPELINE_STAGE_TRANSFER_BIT,0,0,NULL,0,NULL,2,barriers);
  VkImageCopy copy={.srcSubresource={VK_IMAGE_ASPECT_COLOR_BIT,0,0,1},.dstSubresource={VK_IMAGE_ASPECT_COLOR_BIT,0,0,1},.extent={8,6,1}};
  vkCmdCopyImage(command,image.image,VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,copied,VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,1,&copy);
  VkImageMemoryBarrier copied_barrier={.sType=VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,.srcAccessMask=VK_ACCESS_TRANSFER_WRITE_BIT,.dstAccessMask=VK_ACCESS_TRANSFER_READ_BIT,.oldLayout=VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,.newLayout=VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,.srcQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED,.dstQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED,.image=copied,.subresourceRange=range};
  vkCmdPipelineBarrier(command,VK_PIPELINE_STAGE_TRANSFER_BIT,VK_PIPELINE_STAGE_TRANSFER_BIT,0,0,NULL,0,NULL,1,&copied_barrier);
  VkBufferImageCopy buffer_copy={.imageSubresource={VK_IMAGE_ASPECT_COLOR_BIT,0,0,1},.imageExtent={8,6,1}};
  vkCmdCopyImageToBuffer(command,copied,VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,readback,1,&buffer_copy);
  barriers[0].srcAccessMask=VK_ACCESS_TRANSFER_READ_BIT;barriers[0].dstAccessMask=VK_ACCESS_SHADER_READ_BIT;barriers[0].oldLayout=VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;barriers[0].newLayout=(VkImageLayout)image.layout;
  vkCmdPipelineBarrier(command,VK_PIPELINE_STAGE_TRANSFER_BIT,VK_PIPELINE_STAGE_ALL_COMMANDS_BIT,0,0,NULL,0,NULL,1,barriers);
  VK_OK(vkEndCommandBuffer(command));VkSubmitInfo submit={.sType=VK_STRUCTURE_TYPE_SUBMIT_INFO,.commandBufferCount=1,.pCommandBuffers=&command};VK_OK(vkQueueSubmit(info.queue,1,&submit,VK_NULL_HANDLE));
  OK(mt_vk_lease_release(image.lease,message,sizeof message));
  OK(mt_render_read_pixels(render,MT_IMAGE_ID,ids,sizeof ids,&written,message,sizeof message));REQUIRE(written==sizeof ids);
  for(size_t i=0;i<sizeof ids/sizeof *ids;i++)REQUIRE(ids[i]==UINT32_MAX);
  mt_vk_lease queue_lease;OK(mt_engine_vulkan_acquire_queue(engine,&queue_lease,message,sizeof message));VK_OK(vkQueueWaitIdle(info.queue));OK(mt_vk_lease_release(queue_lease,message,sizeof message));
  float *mapped=NULL;VK_OK(vkMapMemory(device,readback_memory,0,VK_WHOLE_SIZE,0,(void **)&mapped));
  for(size_t i=0;i<8*6;i++)REQUIRE(memcmp(mapped+i*4,background,sizeof background)==0);
  vkUnmapMemory(device,readback_memory);vkDestroyBuffer(device,readback,NULL);vkFreeMemory(device,readback_memory,NULL);
  vkDestroyCommandPool(device,pool,NULL);vkDestroyImage(device,copied,NULL);vkFreeMemory(device,allocation,NULL);
  mt_display display;OK(mt_engine_display(engine,&display,message,sizeof message));mt_vk_post_process pass;
  OK(mt_display_set_size(display,8,6,message,sizeof message));
  OK(mt_display_add_vulkan_post_process(display,0,post_process,NULL,&pass,message,sizeof message));
  OK(mt_display_present(display,render,NULL,NULL,message,sizeof message));REQUIRE(mt_host_atomic_load(&pass_calls)>0);
  unsigned char rgba[8*6*4];OK(mt_display_read_pixels(display,render,MT_DISPLAY_RGBA8,rgba,sizeof rgba,&written,NULL,NULL,message,sizeof message));
  REQUIRE(written==sizeof rgba);printf("postprocess calls=%u first RGBA=%u,%u,%u,%u bytes=%zu\n",mt_host_atomic_load(&pass_calls),rgba[0],rgba[1],rgba[2],rgba[3],written);
  for(size_t i=0;i<8*6;i++) {if(rgba[i*4]!=64||rgba[i*4+1]!=128||rgba[i*4+2]!=191||rgba[i*4+3]!=255)fprintf(stderr,"pixel %zu: %u,%u,%u,%u\n",i,rgba[i*4],rgba[i*4+1],rgba[i*4+2],rgba[i*4+3]);REQUIRE(rgba[i*4]==64&&rgba[i*4+1]==128&&rgba[i*4+2]==191&&rgba[i*4+3]==255);}
  mt_host_atomic_store(&fail_pass,1);OK(mt_display_present(display,render,NULL,NULL,message,sizeof message));
  unsigned char fallback[sizeof rgba];OK(mt_display_read_pixels(display,render,MT_DISPLAY_RGBA8,fallback,sizeof fallback,&written,NULL,NULL,message,sizeof message));REQUIRE(memcmp(rgba,fallback,sizeof rgba)!=0);
  mt_host_atomic_store(&fail_pass,0);OK(mt_display_present(display,render,NULL,NULL,message,sizeof message));OK(mt_vk_post_process_remove(pass,message,sizeof message));
  ro.width=16;ro.height=12;OK(mt_render_set_options(render,&ro,message,sizeof message));OK(mt_render_converge(render,&co,NULL,message,sizeof message));
  OK(mt_render_vulkan_acquire_image(render,0,&image,message,sizeof message));REQUIRE(image.width==16&&image.height==12);OK(mt_vk_lease_release(image.lease,message,sizeof message));
  OK(mt_scene_destroy(scene,message,sizeof message));OK(mt_engine_destroy(engine,message,sizeof message));
  REQUIRE(mt_host_atomic_load(&device_retired)==1&&mt_host_atomic_load(&instance_retired)==1);
  VK_OK(vkDeviceWaitIdle(device));vkDestroyDevice(device,NULL);vkDestroyInstance(instance,NULL);free(extensions);
#if defined(_WIN32)
  REQUIRE(FreeLibrary(driver));
#else
  REQUIRE(dlclose(driver)==0);
#endif
  printf("PASS Vulkan C ABI 8: actual backend %u; negotiated import, queue/image leases, AOV exclusion, host texture copy, native postprocess, rollback, resize, retirement and immediate destruction\n",traversal);
  return 0;
}
