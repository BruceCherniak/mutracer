// GLSL port of the shared 256-proposal WGSL AOV quadrature.
export default /* glsl */ `
vec3 aovEvalLobe(OpenPbrPreparedBsdf prepared, vec3 direction, int lobe, out float pdf) {
  if(lobe<0)return openpbr_eval_prepared(prepared,direction,pdf);
  OpenPbrPreparedBsdf isolated=prepared;
  for(int i=0;i<7;i++) if(i!=lobe)isolated.weights[i]=0.0;
  isolated.dielectricMsProbability=0.0;
  return openpbr_eval_prepared(isolated,direction,pdf);
}
void aovReflectance(OpenPbrPreparedBsdf prepared, out vec3 diffuse, out vec3 specular) {
  diffuse=vec3(0.0);specular=vec3(0.0);
  vec3 view=prepared.viewLocal;if(view.z<=1e-6)return;
  vec2 alpha=vec2(prepared.material.alphaX,prepared.material.alphaY);
  for(int i=0;i<NO_UNROLL(256);i++) {
    uint pair=uint(i)/2u;
    vec2 u=vec2((float(pair)+.5)/128.0,fract(float(reverseBits(pair))*2.3283064365386963e-10+.37));
    vec3 light=sampling_cosine_hemisphere(u);
    if((i&1)!=0){vec3 halfVector=sampling_ggx_visible_normal(view,alpha,u);light=reflect(-view,halfVector);}
    if(light.z<=0.0)continue;
    vec3 halfVector=normalize(view+light);
    float specularPdf=sampling_ggx_smith_g1(view,alpha)*sampling_ggx_ndf(halfVector,alpha)/(4.0*view.z);
    float pdf=.5*(light.z*INVPI+specularPdf);
    vec3 direction=openpbr_to_world(prepared.basis,light);
    vec3 values[2];
    for(int layer=0;layer<NO_UNROLL(2);layer++){
      float unusedPdf=0.0;int lobe=layer==0?OPENPBR_LOBE_DIFFUSE:-1;
      values[layer]=aovEvalLobe(prepared,direction,lobe,unusedPdf);
    }
    float scale=1.0/(pdf*256.0);
    diffuse+=values[0]*scale;specular+=(values[1]-values[0])*scale;
  }
}
`;
