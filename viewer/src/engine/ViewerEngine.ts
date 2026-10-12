import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  Camera,
  Renderer,
  THREESceneSync,
  fromTHREECamera,
  RENDER_STATUS_COMPILING_SHADER,
  RENDER_STATUS_DENOISING,
  RENDER_STATUS_ERROR,
  RENDER_STATUS_FINISHED,
  RENDER_STATUS_PREPARING,
  type RenderStatus
} from '@meimu/mutracer';
import { autoGroundedSkybox, resetSettings, setSettings, useViewer, showToast, writeHash, type RenderPhase, type Settings, type TreeNode } from '../store';
import { Environment, createSky, loadHDR, parseHDR } from './environment';
import { ENVIRONMENT_PRESETS, MODEL_PRESETS, environmentUrl } from './presets';
import {
  createMaterialSpheres, isHDRFile, loadModelFromFiles, loadModelFromURL, loadModelFromSource,
  type LoadedModel, type PathedFile
} from './loadModel';
import type { MaterialValues, TextureKey } from './materialParams';
import { clearMaterialEdits, clearModelCache, readModelCache, saveModelCache, type CachedModel } from './modelCache';
import { MaterialEditor, readPendingEdits, type PendingEdits } from './materialEditor';
import { cameraSettings, readCameraState, writeCameraState } from './cameraState';
import { readModelCamera } from './modelCamera';
import { pushHistory, recordGroup } from '../history';
import { groundModel } from './modelGrounding';
import { DENOISER_FIELDS, getDenoiserOptions } from './denoiserSettings';
import { buildStudioRig, createStudioAmbient, findStudioPreset } from './studio';
import { FOCUS_AREA_SIZE, focusPull, guessMetersPerUnit, pickFocusDepth } from './areaFocus';

export interface ExportOptions {
  width: number;
  height: number;
  samples: number;
  transparent: boolean;
}

// The weights live at the server root: development serves the repository's
// copy there, `build:viewer` emits them at the root of dist-viewer/, and the
// site build (viewer under /viewer/) shares one copy with the examples.
const OIDN_WEIGHTS = new URL('/oidn/weights/', document.baseURI).href;
const get = useViewer.getState;
const set = useViewer.setState;

type ViewCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
const isOrthographic = (camera: THREE.Object3D): camera is THREE.OrthographicCamera =>
  (camera as THREE.OrthographicCamera).isOrthographicCamera === true;

/** f-number used when depth of field is turned on from a focus pick. */
export const DEFAULT_F_STOP = 2.8;
/** Autofocus waits this long after the view or the focus area last changed. */
const AUTOFOCUS_SETTLE_MS = 160;
/** Interval of continuous autofocus while the scene or the view keeps moving. */
const AUTOFOCUS_TRACK_MS = 280;

/**
 * Owns the MuTracer renderer, the Three.js source scene and the render loop.
 * Reads settings from the store and publishes stats, tree and selection to it;
 * it does not depend on React.
 */
export class ViewerEngine {
  readonly renderer: Renderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly perspectiveCamera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  private readonly orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly ground: THREE.Mesh;
  private readonly modelGroup = new THREE.Group();
  private readonly environment = new Environment(createSky());
  private readonly studioAmbient = new Environment(createStudioAmbient());
  private readonly studioRig = new THREE.Group();
  private sync: THREESceneSync;
  private model: LoadedModel | null = null;
  private modelCameras: ViewCamera[] = [];
  /** Objects hidden in the loaded file, restored by {@link resetAll}. */
  private hiddenAtLoad = new Set<string>();
  private readonly materials = new MaterialEditor((materialId) => {
    // Show the material an undo or redo changed.
    if (get().selection.materialId === materialId) return;
    const meshId = this.materials.firstMesh(materialId);
    if (meshId) this.select(meshId, materialId);
  });
  private mixer: THREE.AnimationMixer | null = null;
  private action: THREE.AnimationAction | null = null;
  private settings: Settings;
  private raf = 0;
  private lastTime = 0;
  private lastPublish = 0;
  private sampleStart = 0;
  private lastSamples = 0;
  private lastSampleTime = 0;
  private needsResize = true;
  private loadToken = 0;
  private modelId: string | null = null;
  private cameraSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private envToken = 0;
  private dragging = false;
  private readonly lastCameraPosition = new THREE.Vector3();
  private lastCameraZoom = 1;
  private awaitingFirstSample = false;
  private exporting = false;
  private exportAbort: AbortController | null = null;
  private denoiserKey = '';
  private denoiserUpdateTimer?: ReturnType<typeof setTimeout>;
  private pointerDown: { x: number; y: number } | null = null;
  /** Focus pull in progress; the settings hold its target only once it ends. */
  private pull: { from: number; to: number; start: number } | null = null;
  /** The current focus pull writes its target to the settings. */
  private writingFocus = false;
  private autofocusPending = true;
  private lastViewChange = 0;
  private lastAutofocus = 0;
  private focusQueryInFlight = false;
  private focusQueryVersion = 0;
  private manualFocus: { x: number; y: number } | null = null;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.settings = get().settings;
    this.renderer = new Renderer({ canvas, preferWebGPU: !new URLSearchParams(location.search).has('webgl') });

    this.scene.add(this.modelGroup);
    this.studioRig.name = 'Studio lights';
    this.scene.add(this.studioRig);
    this.scene.environment = this.environment.texture;
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1 });
    groundMaterial.userData.mutracerShadowCatcher = true;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), groundMaterial);
    this.ground.name = 'Ground';
    this.scene.add(this.ground);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('start', () => {
      this.dragging = true;
      if (get().paused) set({ paused: false });
    });
    this.controls.addEventListener('end', () => { this.dragging = false; });
    this.controls.addEventListener('change', this.scheduleCameraSave);
    this.controls.addEventListener('change', this.requestAutofocus);
    this.camera.position.set(3, 2, 5);

    this.sync = this.createSync();
    this.applySettings(this.settings, null);
    void this.renderer.init().then(info => {
      if (this.disposed) return;
      set({ backend: { name: info.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2', adapter: shortAdapterName(info.adapterName) } });
      return this.updateDenoiser();
    }).catch(error => showToast(`Renderer initialization failed: ${error instanceof Error ? error.message : String(error)}`, 'error'));
    this.unsubscribe = useViewer.subscribe((state, prev) => {
      if (state.settings !== prev.settings) {
        const before = this.settings;
        this.settings = state.settings;
        this.applySettings(state.settings, before);
        this.scheduleCameraSave();
      }
      if (state.focusArea.x !== prev.focusArea.x || state.focusArea.y !== prev.focusArea.y) this.requestAutofocus();
    });

    this.resizeObserver = new ResizeObserver(() => { this.needsResize = true; });
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pagehide', this.saveCamera);
    window.addEventListener('pagehide', this.flushMaterials);

    this.raf = requestAnimationFrame(this.frame);
  }

  dispose() {
    this.disposed = true;
    ++this.focusQueryVersion;
    clearTimeout(this.denoiserUpdateTimer);
    this.saveCamera();
    ++this.loadToken;
    ++this.envToken;
    window.removeEventListener('pagehide', this.saveCamera);
    window.removeEventListener('pagehide', this.flushMaterials);
    this.materials.flush();
    cancelAnimationFrame(this.raf);
    this.unsubscribe();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    this.clearModel();
    this.sync.dispose();
    this.environment.dispose();
    this.studioAmbient.dispose();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------- loading

  /** Explicit links win; otherwise reopen the sole cached model. */
  async loadInitialModel(presetId: string | null) {
    const token = ++this.loadToken;
    const cached = await readModelCache();
    if (token !== this.loadToken) return;
    if (cached && (!presetId || cached.meta.presetId === presetId)) {
      const { meta } = cached;
      const loaded = await this.load(meta.name, (progress) => cached.source
        ? loadModelFromSource(cached.source, progress)
        : Promise.resolve(createMaterialSpheres()), meta, cached, false);
      if (loaded || token + 1 !== this.loadToken) return;
      await clearModelCache();
      if (token + 1 !== this.loadToken) return;
      if (!meta.presetId && meta.sourceUrl) {
        return this.load(meta.name, (progress) => loadModelFromURL(meta.sourceUrl!, progress), meta, cached);
      }
    }
    return this.loadPreset(presetId ?? 'spheres', true);
  }

  async loadPreset(id: string, restoreCamera = false) {
    const preset = MODEL_PRESETS.find((p) => p.id === id) ?? MODEL_PRESETS[0];
    // CC-BY models are credited in the viewport; CC0 ones only in the Examples menu.
    const meta = { presetId: preset.id, credit: preset.license !== 'CC0' ? `${preset.name} · ${preset.credit}` : null, sourceUrl: preset.sourceUrl };
    const restored = restoreCamera ? { id: `preset:${preset.id}`, meta: { name: preset.name, ...meta } } : undefined;
    return this.load(preset.name, async (progress) => {
      const model = preset.url ? await loadModelFromURL(preset.url, progress) : createMaterialSpheres();
      if (preset.camera) model.root.userData.mutracerCamera = preset.camera;
      return model;
    }, meta, restored);
  }

  /** Shows a model built in code (used by the thumbnail generator). */
  loadModel(model: LoadedModel) {
    return this.load(model.name, async () => model, { presetId: null, credit: null, sourceUrl: null });
  }

  loadUrl(url: string) {
    if (isHDRFile(url.split('?')[0])) return this.loadEnvironmentFromURL(url);
    return this.load(url.split('/').pop() || url, (progress) => loadModelFromURL(url, progress),
      { presetId: null, credit: null, sourceUrl: url });
  }

  async loadFiles(files: PathedFile[]) {
    const hdr = files.find((f) => isHDRFile(f.path));
    const models = files.filter((f) => !isHDRFile(f.path));
    if (hdr) {
      try {
        this.setEnvironmentData(parseHDR(await hdr.file.arrayBuffer()), 'custom');
      } catch (error) {
        showToast(`Could not read ${hdr.file.name}: ${(error as Error).message}`, 'error');
      }
    }
    if (!models.some((f) => /\.(glb|gltf)$/i.test(f.path))) {
      if (!hdr) showToast('Drop a .glb, a .gltf with its files, or an .hdr environment', 'error');
      return;
    }
    const main = models.find((f) => /\.(glb|gltf)$/i.test(f.path))!;
    return this.load(main.file.name, (progress) => loadModelFromFiles(models, progress),
      { presetId: null, credit: null, sourceUrl: null });
  }

  private async load(
    name: string,
    loader: (progress: (stage: 'download' | 'parse', loaded?: number, total?: number) => void) => Promise<LoadedModel>,
    meta: { presetId: string | null; credit: string | null; sourceUrl: string | null },
    restored?: CachedModel,
    persist = true
  ) {
    const token = ++this.loadToken;
    this.awaitingFirstSample = false;
    set({ loading: { name, stage: 'download', loaded: 0, total: 0 } });
    let model: LoadedModel;
    try {
      model = await loader((stage, loaded = 0, total = 0) => {
        if (token === this.loadToken) set({ loading: { name, stage, loaded, total } });
      });
    } catch (error) {
      if (token !== this.loadToken) return;
      set({ loading: null });
      showToast(`Could not load ${name}: ${(error as Error).message}`, 'error');
      return false;
    }
    const id = restored?.id ?? (meta.presetId ? `preset:${meta.presetId}` : crypto.randomUUID());
    // Material edits survive reloads of the cached model; any other load replaces them.
    const edits = restored && token === this.loadToken ? await readPendingEdits(id) : null;
    if (token !== this.loadToken) {
      model.revoke();
      return false;
    }
    model.name = name;
    this.saveCamera();
    this.materials.flush();
    this.modelId = null; // Fit must not overwrite the saved view before restoration.
    this.setModel(model, edits);
    if (restored) this.restoreCamera(id);
    this.modelId = id;
    this.materials.modelId = id;
    if (!edits) void clearMaterialEdits();
    set({
      model: { name, ...meta },
      loading: { name, stage: 'bvh', loaded: 0, total: 0 }
    });
    this.awaitingFirstSample = true;
    writeHash(this.settings, meta.presetId);
    this.saveCamera();
    if (persist) {
      if (model.source || meta.presetId) await saveModelCache({ id, meta: { name, ...meta }, source: model.source });
      else await clearModelCache();
    }
    return true;
  }

  private setModel(model: LoadedModel, edits: PendingEdits | null = null) {
    this.clearModel();
    this.model = model;
    const root = model.root;
    this.materials.setModel(root, edits);
    // Stand the model on the ground at the origin; keep its units.
    groundModel(root);
    this.modelGroup.add(root);
    root.updateMatrixWorld(true);
    this.hiddenAtLoad.clear();
    root.traverse((object) => { if (!object.visible) this.hiddenAtLoad.add(object.uuid); });

    const bounds = this.modelBounds();
    const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
    this.ground.scale.setScalar(radius * 12);
    const extent = bounds.getSize(new THREE.Vector3());
    set({ modelRadius: radius, lens: { ...get().lens, guessedMetersPerUnit: guessMetersPerUnit(Math.max(extent.x, extent.y, extent.z)) } });
    this.pull = null;
    this.requestAutofocus();
    this.applyStudioRig();
    this.applyBackground();

    this.modelCameras = [];
    root.traverse((object) => {
      if ((object as THREE.PerspectiveCamera).isPerspectiveCamera || isOrthographic(object)) this.modelCameras.push(object as ViewCamera);
    });

    if (model.animations.length) {
      this.mixer = new THREE.AnimationMixer(root);
      this.selectClip(0);
    } else {
      set({ animation: null });
    }

    this.sync.dispose();
    this.sync = this.createSync();
    this.resetView();
    const tree = [this.buildTree(root, model.name)];
    let triangles = 0;
    let meshes = 0;
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) { meshes++; triangles += triangleCount(o as THREE.Mesh); }
    });
    const materialIds = new Set<string>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) for (const m of toArray(mesh.material)) materialIds.add(m.uuid);
    });
    set({
      tree,
      sceneInfo: { meshes, triangles, materials: materialIds.size },
      cameras: this.modelCameras.map((c, i) => c.name || `Camera ${i + 1}`),
      selection: { objectId: null, materialId: null },
      material: null,
      selectionRect: null
    });
    if (this.settings.cameraIndex >= this.modelCameras.length) useViewer.setState((s) => ({ settings: { ...s.settings, cameraIndex: -1 } }));
  }

  /** Frames the model, or uses the view stored with it. */
  private resetView() {
    this.fit();
    const defaultCamera = this.model && readModelCamera(this.model.root.userData.mutracerCamera);
    if (defaultCamera) {
      useViewer.setState((s) => ({ settings: { ...s.settings, projection: 'perspective', fov: defaultCamera.fov, cameraIndex: -1 } }));
      this.perspectiveCamera.fov = defaultCamera.fov;
      this.perspectiveCamera.updateProjectionMatrix();
      this.lookAt(new THREE.Vector3(...defaultCamera.position), new THREE.Vector3(...defaultCamera.target));
    }
  }

  /**
   * Restores default lighting, render and camera settings, the loaded
   * materials and object visibility, and the initial view. Everything but
   * the camera is one undo step.
   */
  resetAll() {
    recordGroup('Reset all', () => {
      resetSettings();
      this.materials.resetAll();
      this.resetVisibility();
    });
    this.resetView();
  }

  private resetVisibility() {
    const changed: { id: string; visible: boolean }[] = [];
    this.model?.root.traverse((object) => {
      const visible = !this.hiddenAtLoad.has(object.uuid);
      if (object.visible !== visible) changed.push({ id: object.uuid, visible });
    });
    if (!changed.length) return;
    const apply = (show: boolean) => { for (const { id, visible } of changed) this.setVisible(id, show ? visible : !visible); };
    apply(true);
    pushHistory({ label: 'Visibility', scope: 'material', undo: () => apply(false), redo: () => apply(true) });
  }

  private clearModel() {
    if (!this.model) return;
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.action = null;
    this.modelGroup.remove(this.model.root);
    const disposed = new Set<unknown>();
    this.model.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const material of toArray(mesh.material)) {
        if (disposed.has(material)) continue;
        disposed.add(material);
        for (const value of Object.values(material)) {
          if ((value as THREE.Texture)?.isTexture) (value as THREE.Texture).dispose();
        }
        material.dispose();
      }
    });
    this.model.revoke();
    this.model = null;
    this.materials.setModel(null, null);
  }

  private createSync() {
    this.materials.clearConversions();
    return new THREESceneSync(this.scene, {
      onMeshConverted: (mesh, source, group) => {
        if (source === this.ground) return;
        const material = toArray(source.material)[group.materialIndex ?? 0];
        if (material) this.materials.onConverted(material, mesh.materials[0], source.uuid);
      }
    });
  }

  // ------------------------------------------------------------ environment

  private async applyEnvironmentPreset(id: string) {
    const preset = ENVIRONMENT_PRESETS.find((p) => p.id === id);
    if (!preset) return; // 'custom': pixels were set directly
    const url = environmentUrl(preset, this.settings.envResolution);
    if (!url) {
      this.setEnvironmentData(createSky(), id);
      return;
    }
    const name = `${preset.name} ${this.settings.envResolution.toUpperCase()}`;
    try {
      await this.downloadEnvironment(url, id, name);
    } catch (error) {
      showToast(`Could not load ${preset.name}: ${(error as Error).message}. Using the procedural sky.`, 'error');
      useViewer.setState((s) => ({ settings: { ...s.settings, envId: 'sky' } }));
    }
  }

  private async loadEnvironmentFromURL(url: string) {
    try {
      await this.downloadEnvironment(url, 'custom', url.split('?')[0].split('/').pop() || 'Environment');
    } catch (error) {
      showToast(`Could not load environment: ${(error as Error).message}`, 'error');
    }
  }

  /** Downloads an .hdr with progress. Resolves quietly when a newer request supersedes it. */
  private async downloadEnvironment(url: string, id: string, name: string) {
    const token = ++this.envToken;
    const current = () => token === this.envToken;
    set({ envLoading: { id, name, loaded: 0, total: 0 } });
    try {
      const data = await loadHDR(url, (loaded, total) => {
        if (current()) set({ envLoading: { id, name, loaded, total } });
      });
      if (current()) this.setEnvironmentData(data, id);
    } catch (error) {
      if (current()) {
        set({ envLoading: null });
        throw error;
      }
    }
  }

  private setEnvironmentData(data: ReturnType<typeof createSky>, id: string) {
    this.envToken++;
    set({ envLoading: null });
    this.environment.setSource(data);
    this.applyBackground();
    if (get().settings.envId !== id) useViewer.setState((s) => ({ settings: { ...s.settings, envId: id } }));
  }

  /** Also selects the lighting: studio mode swaps the HDRI for a dim ambient fill. */
  private applyBackground() {
    const { background, backgroundColor, groundedHeight, groundedRadius, lighting } = this.settings;
    const studio = lighting === 'studio';
    const environment = studio ? this.studioAmbient.texture : this.environment.texture;
    this.scene.environment = environment;
    this.studioRig.visible = studio;
    this.scene.userData.mutracerHiddenBackground = background === 'transparent';
    // Projects the environment onto a ground disc and dome around the model.
    // The studio ambient is a plain gradient, so it is shown as a backdrop.
    const grounded = autoGroundedSkybox(get().modelRadius, groundedHeight);
    this.scene.userData.mutracerGroundedSkybox = background === 'grounded' && !studio ? {
      texture: environment,
      height: grounded.height,
      radius: groundedRadius ?? grounded.radius,
      groundHeight: 0
    } : undefined;
    this.scene.background = background === 'environment' || background === 'grounded' ? environment
      : background === 'color' ? new THREE.Color(backgroundColor) : null;
  }

  /** Rebuilds the studio rect lights around the current model. */
  private applyStudioRig() {
    const { studioPreset, studioIntensity, studioRotation, studioSize } = this.settings;
    const sphere = this.modelBounds().getBoundingSphere(new THREE.Sphere());
    for (const light of [...this.studioRig.children]) {
      this.studioRig.remove(light);
      (light as THREE.RectAreaLight).dispose();
    }
    const lights = buildStudioRig(findStudioPreset(studioPreset), sphere, studioIntensity, studioRotation, studioSize);
    if (lights.length) this.studioRig.add(...lights);
  }

  // ---------------------------------------------------------------- settings

  private applySettings(s: Settings, prev: Settings | null) {
    const changed = (key: keyof Settings) => !prev || prev[key] !== s[key];
    const r = this.renderer;
    r.bvhBuilder = s.bvhBuilder;
    if (prev && changed('bvhBuilder')) {
      void r.prepareScene(this.sync.scene, { rebuild: true }).then(() => r.restartSamples());
    }
    r.maxSamples = s.maxSamples;
    r.bounces = s.bounces;
    r.samplingPattern = s.samplingPattern;
    r.clamping = s.clamping;
    r.toneMapping = s.toneMapping;
    r.toneMappingExposure = s.exposure;
    r.contrast = s.contrast;
    r.saturation = s.saturation;
    r.temperature = s.temperature;
    r.tint = s.tint;
    r.bloomIntensity = s.bloomIntensity;
    r.bloomThreshold = s.bloomThreshold;
    r.bloomRadius = s.bloomRadius;
    r.vignette = s.vignette;
    r.output = s.output;
    // While-converging OIDN denoises preview frames with the small network and lowers
    // their resolution to keep up, so it always previews while interacting.
    r.interactivePreview = s.interactivePreview || (s.denoise && s.denoiseWhileConverging);
    r.previewResolutionScale = s.previewResolutionScale;
    r.shadowCatcherAlpha = s.groundOpacity;
    this.ground.visible = s.groundShadow;
    this.controls.autoRotate = s.autoRotate;
    this.controls.enabled = s.cameraIndex < 0;

    if ((changed('envId') || changed('envResolution')) && s.envId !== 'custom') void this.applyEnvironmentPreset(s.envId);
    if (changed('envIntensity') || changed('envRotation')) this.environment.set(s.envIntensity, s.envRotation);
    if (changed('studioPreset') || changed('studioIntensity') || changed('studioRotation') || changed('studioSize')) this.applyStudioRig();
    if (changed('studioAmbient') || changed('studioAmbientColor')) {
      // THREE.Color converts the sRGB hex to linear RGB.
      const tint = new THREE.Color(s.studioAmbientColor);
      this.studioAmbient.set(s.studioAmbient, 0, [tint.r, tint.g, tint.b]);
    }
    if (changed('lighting') || changed('background') || changed('backgroundColor') || changed('groundedHeight') ||
      changed('groundedRadius')) this.applyBackground();
    if (changed('resolutionScale') || changed('cameraIndex')) this.needsResize = true;
    // A focus distance set elsewhere (the slider, fitting) ends a running pull.
    if (prev && changed('focusDistance') && !this.writingFocus) {
      this.pull = null;
      this.manualFocus = null;
      ++this.focusQueryVersion;
    }
    // End manual picking when its controls disappear, so the next scene click
    // selects the object. Autofocus is positioned by dragging its center handle.
    if ((!(s.fStop > 0) || s.autoFocus) && get().pickingFocus) set({ pickingFocus: false });
    // Aperture changes blur, but do not change the subject's depth. Only
    // enabling the lens needs a new measurement; scrubbing f-number does not.
    if ((!prev || (prev.fStop <= 0 && s.fStop > 0)) || changed('autoFocus') || changed('fov') || changed('cameraIndex') || changed('projection')) {
      ++this.focusQueryVersion;
      this.requestAutofocus();
    }
    if (changed('fov')) {
      this.perspectiveCamera.fov = s.fov;
      this.perspectiveCamera.updateProjectionMatrix();
    }
    if (prev && changed('projection')) {
      this.switchProjection(prev.projection === 'orthographic' ? this.orthographicCamera : this.perspectiveCamera);
    }
    if (DENOISER_FIELDS.some(changed)) {
      clearTimeout(this.denoiserUpdateTimer);
      // Shape changes compile a filter shader. Apply the settled slider value.
      if (prev && !changed('denoise') && !changed('denoiseModel')) {
        this.denoiserUpdateTimer = setTimeout(() => void this.updateDenoiser(), 180);
      } else {
        void this.updateDenoiser();
      }
    }
    if (prev && (changed('lighting') || changed('studioPreset') || changed('studioIntensity') || changed('studioRotation') ||
      changed('studioSize') || changed('studioAmbient') || changed('studioAmbientColor') || changed('envId') || changed('envResolution') || changed('envIntensity') || changed('envRotation') || changed('exposure') ||
      changed('toneMapping') || changed('background'))) {
      writeHash(s, get().model?.presetId ?? null);
    }
  }

  private async updateDenoiser() {
    if (!this.renderer.backend) return;
    const options = getDenoiserOptions(this.settings, this.renderer.backend === 'webgpu', OIDN_WEIGHTS);
    const key = JSON.stringify(options);
    if (key === this.denoiserKey) return;
    this.denoiserKey = key;
    try {
      await this.renderer.setDenoiser(options);
    } catch (error) {
      if (this.denoiserKey !== key) return;
      this.denoiserKey = '';
      showToast(`Denoiser unavailable: ${(error as Error).message}`, 'error');
    }
  }

  // ----------------------------------------------------------------- camera

  /** The orbit camera for the current projection. */
  private get camera(): ViewCamera {
    return this.settings.projection === 'orthographic' ? this.orthographicCamera : this.perspectiveCamera;
  }

  /**
   * Hands the orbit controls from `from` to the camera of the current
   * projection. The orthographic view keeps the size of the perspective
   * view's focus plane at the orbit target, and back.
   */
  private switchProjection(from: ViewCamera) {
    const to = this.camera;
    if (from === to) return;
    // Settle damping on the old camera first.
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;

    const target = this.controls.target;
    const direction = from.position.clone().sub(target);
    const distance = direction.length();
    direction.divideScalar(distance || 1);
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(this.perspectiveCamera.fov) / 2);
    let toDistance: number;
    if (isOrthographic(to)) {
      to.top = (distance * tanHalfFov) / from.zoom;
      to.bottom = -to.top;
      // Zooming does not dolly an orthographic camera, so keep it outside the model.
      const bounds = this.modelBounds().getBoundingSphere(new THREE.Sphere());
      toDistance = Math.max(distance, target.distanceTo(bounds.center) + bounds.radius * 1.1);
    } else {
      toDistance = (from as THREE.OrthographicCamera).top / from.zoom / tanHalfFov;
    }
    const scale = toDistance / Math.max(distance, 1e-6);
    to.position.copy(target).addScaledVector(direction, toDistance);
    to.up.copy(from.up);
    to.zoom = 1;
    to.near = from.near * scale;
    to.far = from.far * scale;
    setAspect(to, this.viewAspect());
    this.controls.object = to;
    this.controls.update();
    this.needsResize = true;
  }

  private viewAspect() {
    return this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
  }

  private scheduleCameraSave = () => {
    if (this.modelId && this.cameraSaveTimer === undefined) this.cameraSaveTimer = setTimeout(this.saveCamera, 200);
  };

  private saveCamera = () => {
    clearTimeout(this.cameraSaveTimer);
    this.cameraSaveTimer = undefined;
    if (!this.modelId) return;
    writeCameraState({
      modelId: this.modelId,
      position: this.camera.position.toArray(), target: this.controls.target.toArray(), up: this.camera.up.toArray(),
      near: this.camera.near, far: this.camera.far, zoom: this.camera.zoom,
      orthoHalfHeight: this.orthographicCamera.top,
      settings: cameraSettings(this.settings)
    });
  };

  private restoreCamera(modelId: string) {
    const saved = readCameraState(modelId);
    if (!saved) return;
    // Flush any damping from fitting without rotating the saved view.
    this.controls.autoRotate = false;
    this.controls.enableDamping = false;
    this.controls.update();
    // Applying the settings switches the controls to the saved projection.
    useViewer.setState((s) => ({ settings: {
      ...s.settings, ...saved.settings,
      cameraIndex: saved.settings.cameraIndex < this.modelCameras.length ? saved.settings.cameraIndex : -1
    } }));
    const camera = this.camera;
    camera.position.fromArray(saved.position);
    camera.up.fromArray(saved.up);
    this.controls.target.fromArray(saved.target);
    camera.near = saved.near;
    camera.far = saved.far;
    camera.zoom = saved.zoom;
    if (saved.orthoHalfHeight) {
      this.orthographicCamera.top = saved.orthoHalfHeight;
      this.orthographicCamera.bottom = -saved.orthoHalfHeight;
    }
    setAspect(camera, this.viewAspect());
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
    this.controls.autoRotate = this.settings.autoRotate;
    this.needsResize = true;
  }

  private activeCamera(): ViewCamera {
    return this.modelCameras[this.settings.cameraIndex] ?? this.camera;
  }

  private modelBounds() {
    const box = new THREE.Box3();
    this.modelGroup.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) box.expandByObject(o, false);
    });
    return box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1)) : box;
  }

  /**
   * Frames the visible model's bounding box from a three-quarter view.
   * `aspect` overrides the viewport's, e.g. for a render at another size;
   * `margin` is the fraction of the frame the model may fill.
   */
  fit(aspect?: number, margin = 0.85) {
    if (this.needsResize) this.resize();
    const box = this.modelBounds();
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    const direction = new THREE.Vector3(0.55, 0.38, 1).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    const frameAspect = aspect ?? (this.viewAspect() || 1);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.perspectiveCamera.fov) / 2) * margin;
    const tanH = tanV * frameAspect;
    // Closest distance at which every box corner projects inside the frame,
    // and the orthographic half height that holds every corner.
    let distance = 0;
    let halfHeight = 0;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      const depth = corner.dot(direction);
      distance = Math.max(distance, depth + Math.abs(corner.dot(right)) / tanH, depth + Math.abs(corner.dot(up)) / tanV);
      halfHeight = Math.max(halfHeight, Math.abs(corner.dot(right)) / frameAspect / margin, Math.abs(corner.dot(up)) / margin);
    }
    const camera = this.camera;
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max((distance - radius) / 20, distance / 1000, 1e-4);
    camera.far = (distance + radius) * 100;
    camera.zoom = 1;
    if (isOrthographic(camera)) {
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
    }
    setAspect(camera, this.viewAspect());
    this.controls.target.copy(center);
    this.controls.update();
    useViewer.setState((s) => ({ settings: { ...s.settings, focusDistance: Number(distance.toFixed(3)) } }));
  }

  /** Places the orbit camera explicitly. */
  lookAt(position: THREE.Vector3, target: THREE.Vector3) {
    this.camera.position.copy(position);
    this.controls.target.copy(target);
    this.controls.update();
    const distance = position.distanceTo(target);
    useViewer.setState((s) => ({ settings: { ...s.settings, cameraIndex: -1, focusDistance: Number(distance.toFixed(3)) } }));
  }

  // ------------------------------------------------------------------ focus

  /** The MuTracer camera for a view, with the lens settings applied. */
  private lensCamera(camera: ViewCamera, focusDistance: number) {
    return fromTHREECamera(camera, {
      fStop: this.settings.fStop,
      focusDistance,
      metersPerUnit: this.settings.metersPerUnit ?? get().lens.guessedMetersPerUnit
    });
  }

  private publishLens(camera: Camera) {
    const focalLength = camera.focalLength;
    const lens = get().lens;
    if (Math.abs(focalLength - lens.focalLength) > 0.05) set({ lens: { ...lens, focalLength } });
  }

  private requestAutofocus = () => {
    this.autofocusPending = true;
    this.lastViewChange = performance.now();
  };

  /**
   * Focuses on the point under viewport coordinates `x`, `y` (0..1 from the
   * top left), turning depth of field on. With autofocus the focus area
   * moves there; otherwise the focus pulls to that point once.
   */
  pickFocus(x: number, y: number) {
    const camera = this.activeCamera();
    if (isOrthographic(camera)) return;
    if (!(this.settings.fStop > 0)) setSettings({ fStop: DEFAULT_F_STOP });
    if (this.settings.autoFocus) {
      set({ focusArea: { ...get().focusArea, x, y } });
      this.requestAutofocus();
      this.lastViewChange = 0;
      return;
    }
    this.manualFocus = { x, y };
    ++this.focusQueryVersion;
  }

  /**
   * Measures the focus area once the view settles, or periodically while
   * the view or the animation keeps moving, and pulls focus to it.
   */
  private updateAutofocus(now: number) {
    const camera = this.activeCamera();
    if (this.disposed || this.focusQueryInFlight || !(this.settings.fStop > 0) || isOrthographic(camera)) return;
    if (!this.settings.autoFocus) {
      if (this.manualFocus) this.queryFocus(this.manualFocus, now, false, false);
      return;
    }
    this.manualFocus = null;
    const tracking = (this.settings.autoRotate && this.settings.cameraIndex < 0) || get().animation?.playing;
    if (tracking ? now - this.lastAutofocus < AUTOFOCUS_TRACK_MS
      : !this.autofocusPending || this.dragging || now - this.lastViewChange < AUTOFOCUS_SETTLE_MS) return;
    const area = get().focusArea;
    this.queryFocus(area, now, true, !!tracking);
  }

  /** One compact asynchronous GPU query; late results never replace a new target. */
  private queryFocus(area: { x: number; y: number }, now: number, automatic: boolean, tracking: boolean) {
    const version = this.focusQueryVersion;
    const loadToken = this.loadToken;
    const viewChange = this.lastViewChange;
    const camera = this.activeCamera();
    const projection = camera.projectionMatrix.clone();
    this.focusQueryInFlight = true;
    void this.renderer.readDepthSamples({ x: area.x, y: area.y, size: automatic ? FOCUS_AREA_SIZE : 0.004 })
      .then((samples) => {
        if (this.disposed || version !== this.focusQueryVersion || loadToken !== this.loadToken ||
          !(this.settings.fStop > 0) || automatic !== this.settings.autoFocus ||
          camera !== this.activeCamera() || !projection.equals(camera.projectionMatrix)) return;
        const currentArea = get().focusArea;
        if (automatic ? currentArea.x !== area.x || currentArea.y !== area.y ||
          (!tracking && viewChange !== this.lastViewChange) : this.manualFocus !== area) return;
        // Preparation/compilation or a busy renderer: retry on a later frame.
        if (!samples) return;
        if (automatic) {
          this.autofocusPending = false;
          this.lastAutofocus = now;
        } else {
          this.manualFocus = null;
        }
        const depth = pickFocusDepth(Array.from(samples).filter(d => Number.isFinite(d) && d > 0), samples.length);
        if (depth === null) {
          if (automatic) set({ focusArea: { ...currentArea, status: 'missed', attempt: currentArea.attempt + 1 } });
          return;
        }
        // Start the pull on completion, so readback latency cannot skip it.
        this.startPull(depth, performance.now(), !tracking);
      })
      .catch((error) => {
        if (this.disposed || loadToken !== this.loadToken) return;
        // Retry at the tracking interval without flooding the GPU on failure.
        this.lastAutofocus = performance.now();
        this.lastViewChange = this.lastAutofocus;
        console.warn('Focus depth query failed.', error);
      })
      .finally(() => { this.focusQueryInFlight = false; });
  }

  private startPull(target: number, now: number, announce = true) {
    const current = this.advanceFocus(now);
    const area = get().focusArea;
    if (Math.abs(Math.log(target / current)) < 0.004) {
      this.pull = null;
      this.commitFocus(target);
      if (announce || area.status !== 'locked') set({ focusArea: { ...area, status: 'locked', attempt: area.attempt + 1 } });
      return;
    }
    this.pull = { from: current, to: target, start: now };
    if (announce || area.status !== 'focusing') set({ focusArea: { ...area, status: 'focusing', attempt: area.attempt + (announce ? 1 : 0) } });
  }

  /** Focus distance of this frame; ends a finished pull. */
  private advanceFocus(now: number) {
    if (!this.pull) return this.settings.focusDistance;
    const { from, to, start } = this.pull;
    const { distance, done } = focusPull(from, to, now - start);
    if (done) {
      this.pull = null;
      this.commitFocus(to);
      const area = get().focusArea;
      if (area.status === 'focusing') set({ focusArea: { ...area, status: 'locked' } });
    }
    return distance;
  }

  private commitFocus(distance: number) {
    this.writingFocus = true;
    try {
      useViewer.setState((s) => ({ settings: { ...s.settings, focusDistance: Number(distance.toPrecision(5)) } }));
    } finally {
      this.writingFocus = false;
    }
  }

  // ---------------------------------------------------------------- picking

  private onPointerDown = (event: PointerEvent) => {
    this.pointerDown = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  };

  private onPointerUp = (event: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.activeCamera());
    if (get().pickingFocus) {
      set({ pickingFocus: false });
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      this.pickFocus(x, y);
      return;
    }
    const hit = raycaster.intersectObject(this.modelGroup, true).find((h) => isVisible(h.object));
    if (!hit) return this.select(null);
    const materials = toArray((hit.object as THREE.Mesh).material);
    const material = materials[hit.face?.materialIndex ?? 0] ?? materials[0];
    this.select(hit.object.uuid, material?.uuid ?? null);
  };

  select(objectId: string | null, materialId?: string | null) {
    const object = objectId ? this.modelGroup.getObjectByProperty('uuid', objectId) : null;
    if (objectId && !object) return;
    if (materialId === undefined && object && (object as THREE.Mesh).isMesh) {
      materialId = toArray((object as THREE.Mesh).material)[0]?.uuid ?? null;
    }
    set({ selection: { objectId, materialId: materialId ?? null } });
    this.publishMaterial(materialId ?? null, object?.name);
    if (materialId && window.matchMedia('(max-width: 768px)').matches === false) {
      useViewer.setState((s) => ({ ui: { ...s.ui, tab: 'material' } }));
    }
  }

  selectMaterial(materialId: string, objectId: string) {
    this.select(objectId, materialId);
  }

  private publishMaterial(materialId: string | null, meshName?: string) {
    const description = materialId ? this.materials.describe(materialId) : null;
    set({ material: materialId && description ? { id: materialId, meshName: meshName ?? '', ...description } : null });
  }

  /**
   * Edits a material; each call is an undo step. Calls with the same
   * `mergeKey` in quick succession (a slider drag) collapse into one step.
   */
  setMaterialValues(materialId: string, values: MaterialValues, label = 'Edit material', mergeKey?: string) {
    this.materials.setValues(materialId, values, label, mergeKey);
  }

  /** Replaces the texture in a slot with an image file, or removes it with `null`. */
  async setMaterialTexture(materialId: string, slot: TextureKey, file: Blob | null, label: string) {
    try {
      await this.materials.setTexture(materialId, slot, file, label);
    } catch (error) {
      showToast(`Could not read the image: ${(error as Error).message}`, 'error');
    }
  }

  resetMaterial(materialId: string) {
    this.materials.reset(materialId);
  }

  private flushMaterials = () => this.materials.flush();

  setVisible(objectId: string, visible: boolean) {
    const object = this.modelGroup.getObjectByProperty('uuid', objectId);
    if (!object) return;
    object.visible = visible;
    const update = (nodes: TreeNode[]): TreeNode[] => nodes.map((node) =>
      node.id === objectId ? { ...node, visible } : { ...node, children: update(node.children) });
    set({ tree: update(get().tree) });
  }

  private buildTree(object: THREE.Object3D, name?: string): TreeNode {
    const mesh = object as THREE.Mesh;
    const kind: TreeNode['kind'] = mesh.isMesh ? 'mesh' : (object as THREE.Light).isLight ? 'light'
      : (object as THREE.Camera).isCamera ? 'camera' : 'group';
    return {
      id: object.uuid,
      name: name ?? (object.name || defaultName(kind)),
      kind,
      visible: object.visible,
      triangles: mesh.isMesh ? triangleCount(mesh) : 0,
      materials: mesh.isMesh ? toArray(mesh.material).map((m) => ({
        id: m.uuid,
        name: m.name || 'Material',
        color: (m as THREE.MeshStandardMaterial).color ? '#' + (m as THREE.MeshStandardMaterial).color.getHexString() : '#888'
      })) : [],
      children: object.children.map((child) => this.buildTree(child))
    };
  }

  private updateSelectionRect() {
    const id = get().selection.objectId;
    const object = id ? this.modelGroup.getObjectByProperty('uuid', id) : null;
    if (!object || !isVisible(object)) {
      if (get().selectionRect) set({ selectionRect: null });
      return;
    }
    const box = new THREE.Box3().setFromObject(object);
    const camera = this.activeCamera();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      corner.project(camera);
      if (corner.z > 1) {
        if (get().selectionRect) set({ selectionRect: null });
        return;
      }
      minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
      minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const rect = {
      x: Math.round(((minX + 1) / 2) * w), y: Math.round(((1 - maxY) / 2) * h),
      w: Math.round(((maxX - minX) / 2) * w), h: Math.round(((maxY - minY) / 2) * h),
      label: object.name || 'Object'
    };
    const prev = get().selectionRect;
    if (!prev || prev.x !== rect.x || prev.y !== rect.y || prev.w !== rect.w || prev.h !== rect.h) set({ selectionRect: rect });
  }

  // -------------------------------------------------------------- animation

  selectClip(index: number) {
    if (!this.mixer || !this.model) return;
    this.mixer.stopAllAction();
    const clip = this.model.animations[index];
    this.action = this.mixer.clipAction(clip);
    this.action.reset().play();
    this.action.paused = false;
    this.mixer.setTime(0);
    const loop = get().animation?.loop ?? true;
    this.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    this.action.clampWhenFinished = true;
    set({
      animation: {
        clips: this.model.animations.map((c, i) => c.name || `Clip ${i + 1}`),
        clip: index, playing: false, time: 0, duration: clip.duration,
        speed: get().animation?.speed ?? 1, loop
      }
    });
  }

  setAnimation(patch: Partial<{ playing: boolean; time: number; speed: number; loop: boolean }>) {
    const anim = get().animation;
    if (!anim || !this.action || !this.mixer) return;
    if (patch.time !== undefined) {
      this.action.time = Math.min(Math.max(patch.time, 0), anim.duration);
      this.mixer.update(0);
    }
    if (patch.loop !== undefined) this.action.setLoop(patch.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    if (patch.playing && !anim.loop && this.action.time >= anim.duration - 1e-3) {
      this.action.reset().play();
    }
    set({ animation: { ...anim, ...patch, time: this.action.time } });
  }

  // ----------------------------------------------------------------- export

  /** Downloads the displayed viewport at its current size without restarting accumulation. */
  async downloadViewportImage() {
    if (this.exporting) return;
    try {
      const samples = this.renderer.samples;
      if (samples === 0) throw new Error('The viewport has not rendered an image yet');
      const blob = await this.captureImage();
      this.downloadImage(blob, samples, 'viewport');
    } catch (error) {
      showToast(`Export failed: ${(error as Error).message}`, 'error');
    }
  }

  async exportImage(options: ExportOptions) {
    if (this.exporting) return;
    try {
      const blob = await this.renderImage(options);
      this.downloadImage(blob, options.samples);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') showToast(`Export failed: ${(error as Error).message}`, 'error');
    }
  }

  private downloadImage(blob: Blob, samples: number, suffix?: string) {
    const link = document.createElement('a');
    const base = (get().model?.name ?? 'mutracer').replace(/\.[^.]+$/, '');
    link.download = `mutracer-${base}${suffix ? `-${suffix}` : ''}-${samples}spp.png`;
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    showToast(`Saved ${link.download}`);
  }

  private async captureImage(type = 'image/png', quality?: number): Promise<Blob> {
    this.renderer.prepareForExport();
    const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, type, quality));
    if (!blob) throw new Error('The canvas could not be encoded');
    return blob;
  }

  /** Renders the current view offline at the given size and encodes the canvas. */
  async renderImage(options: ExportOptions, type = 'image/png', quality?: number): Promise<Blob> {
    if (this.exporting) throw new Error('A render is already running');
    this.exporting = true;
    this.exportAbort = new AbortController();
    const previous = this.renderer.getSize();
    const background = this.settings.background;
    const camera = this.activeCamera().clone();
    setAspect(camera, options.width / options.height);
    set({ export: { stage: 'final', samples: 0, target: options.samples } });
    try {
      if (options.transparent && background !== 'transparent') {
        this.settings = { ...this.settings, background: 'transparent' };
        this.applyBackground();
      }
      this.sync.update();
      this.renderer.setSize(options.width, options.height);
      const clayCamera = this.lensCamera(camera, this.pull?.to ?? this.settings.focusDistance);
      await this.renderer.renderOfflineFrame(this.sync.scene, clayCamera, {
        samples: options.samples,
        signal: this.exportAbort.signal,
        previewIntervalMs: 250,
        onProgress: ({ stage, samples, targetSamples }) => set({ export: { stage, samples, target: targetSamples } })
      });
      return await this.captureImage(type, quality);
    } finally {
      this.settings = get().settings;
      this.applyBackground();
      this.renderer.setSize(previous.width, previous.height);
      this.exporting = false;
      this.exportAbort = null;
      set({ export: null });
    }
  }

  cancelExport() {
    this.exportAbort?.abort();
  }

  // ------------------------------------------------------------ render loop

  private resize() {
    this.needsResize = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.settings.resolutionScale;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    const size = this.renderer.getSize();
    if (size.width !== width || size.height !== height) this.renderer.setSize(width, height);
    setAspect(this.activeCamera(), this.viewAspect());
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min((now - (this.lastTime || now)) / 1000, 0.1);
    this.lastTime = now;
    if (this.exporting) return;
    if (this.needsResize) this.resize();

    const anim = get().animation;
    if (anim?.playing && this.mixer && this.action) {
      this.mixer.update(dt * anim.speed);
      const finished = !anim.loop && this.action.time >= anim.duration - 1e-3;
      if (now - this.lastPublish > 100 || finished) {
        set({ animation: { ...anim, time: this.action.time, playing: !finished } });
      }
    }
    if (this.settings.cameraIndex < 0) this.updateControls(dt);

    if (get().paused) {
      this.publishStats('paused', now, true);
      this.updateSelectionRect();
      return;
    }
    this.sync.update();
    const camera = this.lensCamera(this.activeCamera(), this.advanceFocus(now));
    this.publishLens(camera);
    const status = this.renderer.render(this.sync.scene, camera);
    // Query only after the renderer uploads the current animation pose and
    // camera. Readback runs alongside subsequent frames.
    if (status !== RENDER_STATUS_PREPARING && status !== RENDER_STATUS_COMPILING_SHADER && status !== RENDER_STATUS_ERROR) {
      this.updateAutofocus(now);
    }
    const phase = phaseOf(status);
    this.publishStats(phase, now, false);
    this.updateSelectionRect();
  };

  /**
   * Damping eases the camera out for a second or more after release. The
   * renderer restarts whenever the accumulated motion crosses its threshold,
   * so the tail would flick between preview and full quality several times.
   * End it once a frame moves less than 0.05% of the view distance.
   */
  private updateControls(dt: number) {
    this.lastCameraPosition.copy(this.camera.position);
    this.lastCameraZoom = this.camera.zoom;
    if (!this.controls.update(dt) || this.dragging || this.settings.autoRotate) return;
    const step = this.lastCameraPosition.distanceTo(this.camera.position);
    // An orthographic camera zooms without moving.
    const zoomStep = Math.abs(Math.log(this.camera.zoom / this.lastCameraZoom));
    if (step < 5e-4 * this.camera.position.distanceTo(this.controls.target) && zoomStep < 5e-4) {
      this.controls.enableDamping = false;
      this.controls.update(0);
      this.controls.enableDamping = true;
    }
  }

  private publishStats(phase: RenderPhase, now: number, force: boolean) {
    const samples = this.renderer.samples;
    // Restarted accumulation (an edit, a camera move or an animation frame).
    if (samples < this.lastSamples || samples <= 1) this.sampleStart = now;
    // Time stops at the last added sample, so it freezes once rendering finishes.
    if (samples !== this.lastSamples) this.lastSampleTime = now;
    this.lastSamples = samples;
    if (this.awaitingFirstSample) {
      const loading = get().loading;
      // Preparation keeps the previous scene's accumulation alive. Only a
      // rendering phase can confirm that the newly loaded model has a sample.
      const hasNewSample = samples > 0 &&
        (phase === 'rendering' || phase === 'denoising' || phase === 'finished');
      if (hasNewSample || phase === 'error') {
        this.awaitingFirstSample = false;
        set({ loading: null });
      } else if (loading) {
        const stage = phase === 'compiling' ? 'shaders'
          : phase === 'preparing' ? 'bvh' : loading.stage;
        if (loading.stage !== stage) set({ loading: { ...loading, stage } });
      }
    }
    const prev = get().stats;
    if (!force && phase === prev.phase && now - this.lastPublish < 120) return;
    this.lastPublish = now;
    const elapsed = samples > 1 ? Math.max(0, this.lastSampleTime - this.sampleStart) / 1000 : 0;
    const size = this.renderer.getSize();
    if (prev.phase === phase && prev.samples === samples && prev.elapsed === elapsed &&
      prev.width === size.width && prev.height === size.height) return;
    set({
      stats: {
        phase, samples, elapsed,
        msPerSample: samples > 1 ? (elapsed * 1000) / (samples - 1) : 0,
        width: size.width, height: size.height
      }
    });
  }

}

function phaseOf(status: RenderStatus): RenderPhase {
  switch (status) {
    case RENDER_STATUS_PREPARING: return 'preparing';
    case RENDER_STATUS_COMPILING_SHADER: return 'compiling';
    case RENDER_STATUS_DENOISING: return 'denoising';
    case RENDER_STATUS_FINISHED: return 'finished';
    case RENDER_STATUS_ERROR: return 'error';
    default: return 'rendering';
  }
}

const toArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

function isVisible(object: THREE.Object3D) {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

function triangleCount(mesh: THREE.Mesh) {
  const geometry = mesh.geometry;
  return Math.floor((geometry.index ? geometry.index.count : geometry.getAttribute('position')?.count ?? 0) / 3);
}

/** "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, …)" -> "Apple M3 Max". */
function shortAdapterName(name: string) {
  const renderer = /Renderer: ([^,)]+)/.exec(name)?.[1];
  const angle = /^ANGLE \(([^,]+), ([^,(]+)/.exec(name);
  return (renderer ?? angle?.[2] ?? name).trim();
}

function defaultName(kind: TreeNode['kind']) {
  return kind === 'mesh' ? 'Mesh' : kind === 'light' ? 'Light' : kind === 'camera' ? 'Camera' : 'Group';
}

let current: ViewerEngine | null = null;
/** The engine of the mounted viewport, for UI actions. */
export const getEngine = () => current;
export const setEngine = (engine: ViewerEngine | null) => { current = engine; };

/** Sets the frame aspect, keeping an orthographic camera's height and center. */
function setAspect(camera: ViewCamera, aspect: number) {
  if (isOrthographic(camera)) {
    const halfWidth = ((camera.top - camera.bottom) / 2) * aspect;
    const centerX = (camera.left + camera.right) / 2;
    camera.left = centerX - halfWidth;
    camera.right = centerX + halfWidth;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}
