import type { ModelPreset } from './presets';

export const RESEARCH_SCENES_SOURCE = 'https://github.com/ErfanMo77/gltf-research-scenes';
const RAW = 'https://raw.githubusercontent.com/ErfanMo77/gltf-research-scenes/main/scenes';
const MEDIA = 'https://media.githubusercontent.com/media/ErfanMo77/gltf-research-scenes/main/scenes';

// Reviewed against the upstream scene READMEs and source licenses. Use the
// extended material variants; Git LFS resources are resolved by the downloader.
// Sizes include the glTF and its external buffer and available environment map (decimal MB).
const SCENES: [string, string, string, ModelPreset['license'], string, number][] = [
  ["breakfast-room", "Breakfast Room", "Textured interior", "CC-BY 3.0", "Wig42", 15.56],
  ["bathroom", "Bathroom", "Glass · emissive lighting", "CC0", "Mareck", 57.51],
  ["bathroom2", "Bathroom 2", "Coated wood · rough glass", "CC-BY 3.0", "nacimus", 43.06],
  ["bmw-m6", "BMW M6", "Car paint · glass · metal", "CC0", "tyrant monkey", 66.56],
  ["classroom", "Classroom", "Textured interior", "CC-BY 3.0", "NovaZeeke", 14.55],
  ["classroom2", "Classroom 2", "Blender interior", "CC0", "Christophe Seux", 96.12],
  ["coffee-maker", "Coffee Maker", "Plastic · glass · metal", "CC-BY 3.0", "cekuhnen", 5.8],
  ["cornell-box", "Cornell Box", "Diffuse global illumination", "CC0", "Benedikt Bitterli", 0.02],
  ["cornell-caustic", "Cornell Caustic", "Water · caustics", "CC0", "Benedikt Bitterli", 2.7],
  ["dragon", "Dragon", "Dense geometry", "CC-BY 3.0", "Delatronic", 23.2],
  ["glass-of-water", "Glass of Water", "Glass · water · ice", "CC0", "aXel", 13.86],
  ["house", "House", "Large textured scene", "CC0", "Benedikt Bitterli", 53.16],
  ["kitchen", "Kitchen", "Textures · emissive lighting", "CC-BY 3.0", "Jay-Artist", 45.9],
  ["lamp", "Lamp", "Glass · emissive lighting", "CC0", "UP3D", 31.13],
  ["living-room", "Living Room", "Textures · mirrors · glass", "CC-BY 3.0", "Wig42", 64.13],
  ["living-room-2", "Living Room 2", "Textures · clearcoat", "CC-BY 3.0", "Jay-Artist", 35.49],
  ["material-testball", "Material Testball", "Clearcoat", "Mixed (see source)", "Benedikt Bitterli", 5.97],
  ["modern-hall", "Modern Hall", "Glass · emissive lighting", "CC-BY 3.0", "NewSee2l035", 6.31],
  ["pontiac-gto", "Pontiac GTO", "Car paint · glass · chrome", "CC0", "thecali", 31.74],
  ["spaceship", "Spaceship", "Metal · emissive lighting", "CC0", "thecali", 16.48],
  ["staircase", "Staircase", "Wood · portrait camera", "CC-BY 3.0", "Wig42", 44.05],
  ["teapot", "Teapot", "Clearcoat", "Mixed (see source)", "Benedikt Bitterli", 2.78],
  ["teapot-full", "Teapot Full", "Glass · liquid", "Mixed (see source)", "Benedikt Bitterli", 2.82],
  ["veach-ajar", "Veach Ajar", "Indirect lighting", "CC0", "Eric Veach / Benedikt Bitterli", 25.99],
  ["veach-bidir", "Veach Bidir", "Glass · emissive lighting", "CC0", "Eric Veach / Benedikt Bitterli", 0.32],
  ["veach-mis", "Veach MIS", "Glossy metal · light sampling", "CC0", "Eric Veach / Benedikt Bitterli", 0.1],
  ["vintage-car", "Vintage Car", "Car paint · chrome", "Mixed (see source)", "piopis", 26.8],
];

export const RESEARCH_MODEL_PRESETS: ModelPreset[] = SCENES.map(([slug, name, tag, license, author, sizeMB]) => {
  const stem = slug.replaceAll('-', '_');
  const sourceUrl = `${RESEARCH_SCENES_SOURCE}/tree/main/scenes/${slug}`;
  return {
    id: `research-${slug}`, name, tag, license, sizeMB, category: 'research',
    url: `${RAW}/${slug}/gltf/${stem}${slug === 'classroom2' ? '.glb' : '_extended.gltf'}`,
    thumbnail: `${MEDIA}/${slug}/${stem}_thumbnail.png`,
    credit: `${author} · glTF conversion: ErfanMo77`,
    sourceUrl,
    licenseUrl: `${RESEARCH_SCENES_SOURCE}/blob/main/scenes/${slug}/source/${slug === 'bmw-m6' ? 'BLENDSWAP_LICENSE.txt' : 'LICENSE.txt'}`
  };
});
