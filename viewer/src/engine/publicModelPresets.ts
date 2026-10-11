import type { ModelPreset } from './presets';

// From mutracer-assets/presets.json. Publish resources and the immutable tag together.
export const PUBLIC_MODEL_PRESETS = [
  {
    "id": "spheres",
    "name": "Material spheres",
    "tag": "OpenPBR layers",
    "url": null,
    "thumbnail": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/spheres/thumbnail.webp",
    "license": "CC0",
    "credit": "Procedural scene by Yi Shen",
    "sourceUrl": "https://github.com/pissang/mutracer",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "attributionUrl": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/spheres/attribution.json",
    "camera": {
      "position": [
        2.3694893932125187,
        1.9787714684587185,
        3.986024380121064
      ],
      "target": [
        0.16,
        0.31999998688697817,
        0
      ],
      "fov": 35,
      "space": "grounded"
    }
  },
  {
    "id": "toycar",
    "name": "Toy Car",
    "tag": "Coat · transmission",
    "url": "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/ToyCar/glTF-Binary/ToyCar.glb",
    "thumbnail": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/toycar/thumbnail.webp",
    "license": "CC0",
    "credit": "Khronos glTF Sample Assets",
    "sourceUrl": "https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ToyCar",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "attributionUrl": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/toycar/attribution.json",
    "sizeMB": 5.17,
    "camera": {
      "position": [
        0.025324038537407917,
        0.033701709525349795,
        0.050293870388360626
      ],
      "target": [
        -0.002,
        0.0186,
        0.001
      ],
      "fov": 35,
      "space": "grounded"
    }
  },
  {
    "id": "sheenchair",
    "name": "Sheen Chair",
    "tag": "Fuzz",
    "url": "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/SheenChair/glTF-Binary/SheenChair.glb",
    "thumbnail": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/sheenchair/thumbnail.webp",
    "license": "CC0",
    "credit": "Khronos glTF Sample Assets",
    "sourceUrl": "https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SheenChair",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "attributionUrl": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/sheenchair/attribution.json",
    "sizeMB": 3.93,
    "camera": {
      "position": [
        0.6784507811122752,
        0.8774696398007454,
        1.223957608727744
      ],
      "target": [
        0,
        0.36812353892499994,
        0
      ],
      "fov": 35,
      "space": "grounded"
    }
  },
  {
    "id": "wooden-chess",
    "name": "Wooden Chess Set",
    "tag": "Wood",
    "url": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/wooden-chess/model.glb",
    "thumbnail": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/wooden-chess/thumbnail.webp",
    "license": "CC-BY 4.0",
    "credit": "cmzw",
    "sourceUrl": "https://sketchfab.com/3d-models/wooden-chess-set-90151fb0fb294e56b45e52b001a884db",
    "licenseUrl": "http://creativecommons.org/licenses/by/4.0/",
    "attributionUrl": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/wooden-chess/attribution.json",
    "sizeMB": 2.41,
    "camera": {
      "position": [
        0.4362827570944088,
        0.4014387941195868,
        0.3054884753084208
      ],
      "target": [
        0.010344009697356922,
        0.03734823996380911,
        0.007242953565403658
      ],
      "fov": 35,
      "space": "grounded"
    }
  },
  {
    "id": "yamaha-mt-09",
    "name": "2025 Yamaha MT-09 SP V4",
    "tag": "Motorcycle / metal",
    "url": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/yamaha-mt-09/model.glb",
    "thumbnail": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/yamaha-mt-09/thumbnail.webp",
    "license": "CC-BY-NC-SA 4.0",
    "credit": "VTX",
    "sourceUrl": "https://sketchfab.com/3d-models/2025-yamaha-mt-09-sp-v4-cb5878baf5974167806eb8524d57f0b0",
    "licenseUrl": "http://creativecommons.org/licenses/by-nc-sa/4.0/",
    "attributionUrl": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/yamaha-mt-09/attribution.json",
    "sizeMB": 10.94,
    "nonCommercial": true,
    "camera": {
      "position": [
        1.6960501485157866,
        1.0406658365292198,
        -0.7908811728678338
      ],
      "target": [
        0,
        0.7106902961051821,
        0
      ],
      "fov": 35,
      "space": "grounded"
    }
  },
  {
    "id": "super-human",
    "name": "Super Human",
    "tag": "Character / skin",
    "url": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/super-human/model.glb",
    "thumbnail": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/super-human/thumbnail.webp",
    "license": "CC-BY 4.0",
    "credit": "Davyd Vidiger",
    "sourceUrl": "https://sketchfab.com/3d-models/super-human-7aa58e978b9f4357b8e73d8e0440c896",
    "licenseUrl": "http://creativecommons.org/licenses/by/4.0/",
    "attributionUrl": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/super-human/attribution.json",
    "sizeMB": 3.67,
    "camera": {
      "position": [
        -105.87534825725147,
        166.70388650621666,
        227.0504170490354
      ],
      "target": [
        0,
        153.57456298828126,
        0
      ],
      "fov": 35,
      "space": "grounded"
    }
  },
  {
    "id": "sci-fi-box",
    "name": "Sci-fi Box",
    "tag": "Sci-fi / metal",
    "url": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/sci-fi-box/model.glb",
    "thumbnail": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/sci-fi-box/thumbnail.webp",
    "license": "CC-BY 4.0",
    "credit": "Martin Trafas",
    "sourceUrl": "https://sketchfab.com/3d-models/sci-fi-box-c42695379c814cbcb0469c41b14f0259",
    "licenseUrl": "http://creativecommons.org/licenses/by/4.0/",
    "attributionUrl": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/sci-fi-box/attribution.json",
    "sizeMB": 5.63,
    "camera": {
      "position": [
        -3.156733574317115,
        2.2358894476563917,
        4.508282761976899
      ],
      "target": [
        0,
        0.8636885905228607,
        0
      ],
      "fov": 35,
      "space": "grounded"
    }
  },
  {
    "id": "gelatinous-cube",
    "name": "Gelatinous Cube",
    "tag": "Glass / transmission",
    "url": "https://mutracer-assets.meimu-studio.com/models/gelatinous-cube/66cf10385995c18900cb9072/model.glb",
    "thumbnail": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/gelatinous-cube/thumbnail.webp",
    "license": "CC-BY-NC 4.0",
    "credit": "glenatron",
    "sourceUrl": "https://sketchfab.com/3d-models/gelatinous-cube-e08385238f4d4b59b012233a9fbdca21",
    "licenseUrl": "http://creativecommons.org/licenses/by-nc/4.0/",
    "attributionUrl": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/gelatinous-cube/attribution.json",
    "sizeMB": 19.2,
    "nonCommercial": true,
    "camera": {
      "position": [
        -9.46307275803329,
        8.475911174419261,
        14.914383127377091
      ],
      "target": [
        0.5009901433206276,
        4.1446315995416025,
        0.6842265557554421
      ],
      "fov": 35,
      "space": "grounded"
    }
  },
  {
    "id": "blender-cover-remix",
    "name": "Blender Cover Remix",
    "tag": "Characters / scene",
    "url": "https://mutracer-assets.meimu-studio.com/models/blender-cover-remix/4c918299ecc8ef28fee4e5ac/model.glb",
    "thumbnail": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/blender-cover-remix/thumbnail.webp",
    "license": "CC-BY 4.0",
    "credit": "bandinopla",
    "sourceUrl": "https://sketchfab.com/3d-models/blender-cover-remix-a38f11890ff141c88fcdac6b637fdaf8",
    "licenseUrl": "http://creativecommons.org/licenses/by/4.0/",
    "attributionUrl": "https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@v0.1.0/assets/blender-cover-remix/attribution.json",
    "sizeMB": 26.77,
    "camera": {
      "position": [
        -7.966102731369936,
        6.955486121047712,
        11.376773737308895
      ],
      "target": [
        -4.440892098500626e-16,
        3.492700067471975,
        0
      ],
      "fov": 35,
      "space": "grounded"
    }
  }
] satisfies ModelPreset[];
