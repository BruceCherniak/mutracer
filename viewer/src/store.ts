import { create } from 'zustand';
import type { BVHBuilder, OIDNModel, SamplingPattern, ToneMapping, RenderOutput } from 'mutracer';
import type { MaterialValues } from './engine/materialParams';

export type EnvResolution = '1k' | '2k' | '4k';

export interface Settings {
  envId: string;
  envIntensity: number;
  envRotation: number;
  envResolution: EnvResolution;
  background: 'environment' | 'grounded' | 'color' | 'transparent';
  /** Grounded skybox capture height and dome radius, in model radii. */
  groundedHeight: number;
  groundedRadius: number;
  backgroundColor: string;
  groundShadow: boolean;
  groundOpacity: number;

  maxSamples: number;
  bounces: number;
  resolutionScale: number;
  samplingPattern: SamplingPattern;
  bvhBuilder: BVHBuilder;
  clamping: number;
  denoise: boolean;
  denoiseModel: OIDNModel;
  denoiseWhileConverging: boolean;
  toneMapping: ToneMapping;
  exposure: number;
  autoExposure: boolean;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  bloomIntensity: number;
  bloomThreshold: number;
  bloomRadius: number;
  vignette: number;
  output: RenderOutput;
  interactivePreview: boolean;
  previewResolutionScale: number;

  /** `-1` is the orbit camera; otherwise an index into the model's cameras. */
  cameraIndex: number;
  fov: number;
  aperture: number;
  focusDistance: number;
  autoRotate: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  envId: 'studio_small_09',
  envIntensity: 1,
  envRotation: 0,
  envResolution: '1k',
  background: 'environment',
  backgroundColor: '#2a2b30',
  groundedHeight: 1,
  groundedRadius: 20,
  groundShadow: true,
  groundOpacity: 0.8,
  maxSamples: 64,
  bounces: 6,
  resolutionScale: 0.5,
  samplingPattern: 'sobol',
  // Dropped models can be large; TinyBVH's WebAssembly builder is faster.
  bvhBuilder: 'tinybvh',
  clamping: 0,
  denoise: true,
  denoiseModel: 'standard',
  denoiseWhileConverging: false,
  toneMapping: 'agx',
  exposure: 1,
  autoExposure: false,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
  bloomIntensity: 0,
  bloomThreshold: 1,
  bloomRadius: 0.6,
  vignette: 0,
  output: 'final',
  interactivePreview: true,
  previewResolutionScale: 1,
  cameraIndex: -1,
  fov: 35,
  aperture: 0,
  focusDistance: 5,
  autoRotate: false
};

export type RenderPhase = 'starting' | 'preparing' | 'compiling' | 'rendering' | 'denoising' | 'finished' | 'paused' | 'error';

export interface Stats {
  phase: RenderPhase;
  samples: number;
  elapsed: number;
  msPerSample: number;
  width: number;
  height: number;
}

export interface TreeNode {
  id: string;
  name: string;
  kind: 'group' | 'mesh' | 'light' | 'camera';
  visible: boolean;
  triangles: number;
  children: TreeNode[];
  materials: { id: string; name: string; color: string }[];
}

/** Environment map download, shown in the Lighting panel. */
export interface EnvLoadingState {
  id: string;
  name: string;
  loaded: number;
  total: number;
}

export interface LoadingState {
  name: string;
  stage: 'download' | 'parse' | 'bvh' | 'shaders';
  loaded: number;
  total: number;
}

export interface AnimationState {
  clips: string[];
  clip: number;
  playing: boolean;
  time: number;
  duration: number;
  speed: number;
  loop: boolean;
}

export interface SelectedMaterial {
  id: string;
  name: string;
  meshName: string;
  users: number;
  values: MaterialValues;
  textures: string[];
}

export type InspectorTab = 'environment' | 'material' | 'camera' | 'render';

export interface ViewerState {
  settings: Settings;
  stats: Stats;
  backend: { name: 'WebGPU' | 'WebGL 2' | null; adapter: string };
  model: { name: string; presetId: string | null; credit: string | null; sourceUrl: string | null } | null;
  tree: TreeNode[];
  sceneInfo: { meshes: number; triangles: number; materials: number };
  cameras: string[];
  loading: LoadingState | null;
  envLoading: EnvLoadingState | null;
  error: string | null;
  toast: { id: number; message: string; tone: 'info' | 'error' } | null;
  animation: AnimationState | null;
  selection: { objectId: string | null; materialId: string | null };
  material: SelectedMaterial | null;
  selectionRect: { x: number; y: number; w: number; h: number; label: string } | null;
  pickingFocus: boolean;
  paused: boolean;
  ui: { tab: InspectorTab; left: boolean; right: boolean; hidden: boolean; exportOpen: boolean; helpOpen: boolean; mobileTab: InspectorTab | 'scene' };
  export: { stage: 'pilot' | 'final' | 'denoising'; samples: number; target: number } | null;
}

const UI_KEY = 'mutracer-viewer:ui';
const RENDER_KEY = 'mutracer-viewer:render:v5';
const RENDER_FIELDS: (keyof Settings)[] = [
  'envResolution', 'maxSamples', 'bounces', 'resolutionScale', 'samplingPattern', 'bvhBuilder', 'denoise', 'denoiseModel', 'denoiseWhileConverging',
  'toneMapping', 'interactivePreview', 'previewResolutionScale'
];

function readStorage<T>(key: string): Partial<T> {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') as Partial<T>;
  } catch {
    return {};
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode); preferences are optional.
  }
}

/** Shareable settings in the URL hash. */
const HASH_FIELDS: (keyof Settings)[] = ['envId', 'envResolution', 'envIntensity', 'envRotation', 'exposure', 'toneMapping', 'background'];

function readHash(): Partial<Settings> {
  const params = new URLSearchParams(location.hash.slice(1));
  const out: Record<string, unknown> = {};
  for (const key of HASH_FIELDS) {
    const raw = params.get(key);
    if (raw === null) continue;
    out[key] = typeof DEFAULT_SETTINGS[key] === 'number' ? Number(raw) : raw;
  }
  return out as Partial<Settings>;
}

export function writeHash(settings: Settings, modelPreset: string | null) {
  const params = new URLSearchParams();
  if (modelPreset) params.set('model', modelPreset);
  for (const key of HASH_FIELDS) {
    if (settings[key] !== DEFAULT_SETTINGS[key]) params.set(key, String(settings[key]));
  }
  const hash = params.toString();
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

export const hashModelPreset = () => new URLSearchParams(location.hash.slice(1)).get('model');

function validateSettings(settings: Settings): Settings {
  const allowed: ToneMapping[] = ['agx', 'aces', 'cineon', 'reinhard', 'linear'];
  return {
    ...settings,
    toneMapping: allowed.includes(settings.toneMapping) ? settings.toneMapping : 'agx',
    bvhBuilder: settings.bvhBuilder === 'builtin' ? 'builtin' : 'tinybvh'
  };
}

const storedUi = readStorage<ViewerState['ui']>(UI_KEY);

export const useViewer = create<ViewerState>(() => ({
  settings: validateSettings({ ...DEFAULT_SETTINGS, ...readStorage<Settings>(RENDER_KEY), ...readHash() }),
  stats: { phase: 'starting', samples: 0, elapsed: 0, msPerSample: 0, width: 0, height: 0 },
  backend: { name: null, adapter: '' },
  model: null,
  tree: [],
  sceneInfo: { meshes: 0, triangles: 0, materials: 0 },
  cameras: [],
  loading: null,
  envLoading: null,
  error: null,
  toast: null,
  animation: null,
  selection: { objectId: null, materialId: null },
  material: null,
  selectionRect: null,
  pickingFocus: false,
  paused: false,
  ui: {
    tab: storedUi.tab ?? 'material',
    left: storedUi.left ?? true,
    right: storedUi.right ?? true,
    hidden: false,
    exportOpen: false,
    helpOpen: false,
    mobileTab: storedUi.tab ?? 'material'
  },
  export: null
}));

export function setSettings(patch: Partial<Settings>) {
  useViewer.setState((s) => ({ settings: { ...s.settings, ...patch } }));
}

export function setUi(patch: Partial<ViewerState['ui']>) {
  useViewer.setState((s) => ({ ui: { ...s.ui, ...patch } }));
}

let toastId = 0;
export function showToast(message: string, tone: 'info' | 'error' = 'info') {
  useViewer.setState({ toast: { id: ++toastId, message, tone } });
}

useViewer.subscribe((state, prev) => {
  if (state.ui !== prev.ui) {
    const { tab, left, right } = state.ui;
    writeStorage(UI_KEY, { tab, left, right });
  }
  if (state.settings !== prev.settings) {
    writeStorage(RENDER_KEY, Object.fromEntries(RENDER_FIELDS.map((key) => [key, state.settings[key]])));
  }
});
