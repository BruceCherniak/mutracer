import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  Renderer,
  THREESceneSync,
  fromTHREECamera,
  RENDER_STATUS_COMPILING_SHADER,
  RENDER_STATUS_DENOISING,
  RENDER_STATUS_ERROR,
  RENDER_STATUS_FINISHED,
  RENDER_STATUS_PREPARING,
  type OpenPBRMaterial,
  type RenderStatus
} from 'mutracer';
import { useViewer, showToast, writeHash, type RenderPhase, type Settings, type TreeNode } from '../store';
import { Environment, createSky, loadHDR, parseHDR } from './environment';
import { ENVIRONMENT_PRESETS, MODEL_PRESETS, environmentUrl } from './presets';
import {
  createMaterialSpheres, isHDRFile, loadModelFromFiles, loadModelFromURL,
  type LoadedModel, type PathedFile
} from './loadModel';
import { readMaterial, textureSlots, writeMaterial, type MaterialValues } from './materialParams';

interface MaterialEntry {
  name: string;
  converted: Set<OpenPBRMaterial>;
  meshes: Set<string>;
  initial?: MaterialValues;
}

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

/**
 * Owns the MuTracer renderer, the Three.js source scene and the render loop.
 * Reads settings from the store and publishes stats, tree and selection to it;
 * it does not depend on React.
 */
export class ViewerEngine {
  readonly renderer: Renderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly ground: THREE.Mesh;
  private readonly modelGroup = new THREE.Group();
  private readonly environment = new Environment(createSky());
  private sync: THREESceneSync;
  private model: LoadedModel | null = null;
  private modelCameras: THREE.PerspectiveCamera[] = [];
  private materials = new Map<string, MaterialEntry>();
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
  private envToken = 0;
  private modelRadius = 1;
  private dragging = false;
  private readonly lastCameraPosition = new THREE.Vector3();
  private awaitingFirstSample = false;
  private exporting = false;
  private exportAbort: AbortController | null = null;
  private denoiserKey = '';
  private backendKnown = false;
  private pointerDown: { x: number; y: number } | null = null;
  private readonly unsubscribe: () => void;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.settings = get().settings;
    this.renderer = new Renderer({ canvas, preferWebGPU: !new URLSearchParams(location.search).has('webgl') });

    this.scene.add(this.modelGroup);
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
    this.camera.position.set(3, 2, 5);

    this.sync = this.createSync();
    this.applySettings(this.settings, null);
    this.unsubscribe = useViewer.subscribe((state, prev) => {
      if (state.settings !== prev.settings) {
        const before = this.settings;
        this.settings = state.settings;
        this.applySettings(state.settings, before);
      }
    });

    this.resizeObserver = new ResizeObserver(() => { this.needsResize = true; });
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);

    this.raf = requestAnimationFrame(this.frame);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.unsubscribe();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    this.clearModel();
    this.sync.dispose();
    this.environment.dispose();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------- loading

  async loadPreset(id: string) {
    const preset = MODEL_PRESETS.find((p) => p.id === id) ?? MODEL_PRESETS[0];
    // CC-BY models are credited in the viewport; CC0 ones only in the Examples menu.
    const meta = { presetId: preset.id, credit: preset.license === 'CC-BY 4.0' ? preset.credit : null, sourceUrl: preset.sourceUrl };
    if (!preset.url) return this.load(preset.name, async () => createMaterialSpheres(), meta);
    return this.load(preset.name, (progress) => loadModelFromURL(preset.url!, progress), meta);
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
    meta: { presetId: string | null; credit: string | null; sourceUrl: string | null }
  ) {
    const token = ++this.loadToken;
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
      return;
    }
    if (token !== this.loadToken) {
      model.revoke();
      return;
    }
    model.name = name;
    this.setModel(model);
    set({
      model: { name, ...meta },
      loading: { name, stage: 'bvh', loaded: 0, total: 0 }
    });
    this.awaitingFirstSample = true;
    writeHash(this.settings, meta.presetId);
  }

  private setModel(model: LoadedModel) {
    this.clearModel();
    this.model = model;
    const root = model.root;
    root.updateMatrixWorld(true);
    // Stand the model on the ground at the origin; keep its units.
    const box = new THREE.Box3().setFromObject(root);
    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      root.position.x -= center.x;
      root.position.z -= center.z;
      root.position.y -= box.min.y;
    }
    this.modelGroup.add(root);
    root.updateMatrixWorld(true);

    const radius = Math.max(this.modelBounds().getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
    this.ground.scale.setScalar(radius * 12);
    this.modelRadius = radius;
    this.applyBackground();

    this.modelCameras = [];
    root.traverse((object) => {
      if ((object as THREE.PerspectiveCamera).isPerspectiveCamera) this.modelCameras.push(object as THREE.PerspectiveCamera);
    });

    if (model.animations.length) {
      this.mixer = new THREE.AnimationMixer(root);
      this.selectClip(0);
    } else {
      set({ animation: null });
    }

    this.sync.dispose();
    this.sync = this.createSync();
    this.fit();
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
    this.materials.clear();
  }

  private createSync() {
    this.materials.clear();
    return new THREESceneSync(this.scene, {
      onMeshConverted: (mesh, source, group) => {
        if (source === this.ground) return;
        const material = toArray(source.material)[group.materialIndex ?? 0];
        if (!material) return;
        let entry = this.materials.get(material.uuid);
        if (!entry) {
          entry = { name: material.name || 'Material', converted: new Set(), meshes: new Set() };
          this.materials.set(material.uuid, entry);
        }
        const converted = mesh.materials[0];
        if (converted && !entry.converted.has(converted)) {
          entry.converted.add(converted);
          entry.initial ??= readMaterial(converted);
        }
        entry.meshes.add(source.uuid);
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
    this.scene.environment = this.environment.texture;
    this.applyBackground();
    if (get().settings.envId !== id) useViewer.setState((s) => ({ settings: { ...s.settings, envId: id } }));
  }

  private applyBackground() {
    const { background, backgroundColor, groundedHeight, groundedRadius } = this.settings;
    this.scene.userData.mutracerHiddenBackground = background === 'transparent';
    // Projects the environment onto a ground disc and dome around the model.
    this.scene.userData.mutracerGroundedSkybox = background === 'grounded' ? {
      texture: this.environment.texture,
      height: groundedHeight * this.modelRadius,
      radius: groundedRadius * this.modelRadius,
      groundHeight: 0
    } : undefined;
    this.scene.background = background === 'environment' || background === 'grounded' ? this.environment.texture
      : background === 'color' ? new THREE.Color(backgroundColor) : null;
  }

  // ---------------------------------------------------------------- settings

  private applySettings(s: Settings, prev: Settings | null) {
    const changed = (key: keyof Settings) => !prev || prev[key] !== s[key];
    const r = this.renderer;
    r.maxSamples = s.maxSamples;
    r.bounces = s.bounces;
    r.samplingPattern = s.samplingPattern;
    r.clamping = s.clamping;
    r.toneMapping = s.toneMapping;
    r.toneMappingExposure = s.exposure;
    r.autoExposure = s.autoExposure;
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
    if (changed('background') || changed('backgroundColor') || changed('groundedHeight') || changed('groundedRadius')) this.applyBackground();
    if (changed('resolutionScale') || changed('cameraIndex')) this.needsResize = true;
    if (changed('fov')) {
      this.camera.fov = s.fov;
      this.camera.updateProjectionMatrix();
    }
    if (changed('denoise') || changed('denoiseModel') || changed('denoiseWhileConverging')) void this.updateDenoiser();
    if (prev && (changed('envId') || changed('envResolution') || changed('envIntensity') || changed('envRotation') || changed('exposure') ||
      changed('toneMapping') || changed('background'))) {
      writeHash(s, get().model?.presetId ?? null);
    }
  }

  private async updateDenoiser() {
    if (!this.backendKnown) return;
    const s = this.settings;
    const enabled = s.denoise && this.renderer.isUsingWebGPU();
    const key = enabled ? `${s.denoiseModel}:${s.denoiseWhileConverging}` : 'off';
    if (key === this.denoiserKey) return;
    this.denoiserKey = key;
    try {
      await this.renderer.setDenoiser(enabled ? { model: s.denoiseModel, whileConverging: s.denoiseWhileConverging, weightsBaseUrl: OIDN_WEIGHTS } : false);
    } catch (error) {
      this.denoiserKey = '';
      showToast(`Denoiser unavailable: ${(error as Error).message}`, 'error');
    }
  }

  // ----------------------------------------------------------------- camera

  private activeCamera(): THREE.PerspectiveCamera {
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
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * margin;
    const tanH = tanV * (aspect ?? (this.camera.aspect || 1));
    // Closest distance at which every box corner projects inside the frame.
    let distance = 0;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      const depth = corner.dot(direction);
      distance = Math.max(distance, depth + Math.abs(corner.dot(right)) / tanH, depth + Math.abs(corner.dot(up)) / tanV);
    }
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max((distance - radius) / 20, distance / 1000, 1e-4);
    this.camera.far = (distance + radius) * 100;
    this.camera.updateProjectionMatrix();
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
    const hit = raycaster.intersectObject(this.modelGroup, true).find((h) => isVisible(h.object));
    if (get().pickingFocus) {
      set({ pickingFocus: false });
      if (hit) {
        const aperture = this.settings.aperture || Number((hit.distance * 0.01).toFixed(4));
        useViewer.setState((s) => ({ settings: { ...s.settings, focusDistance: Number(hit.distance.toFixed(3)), aperture } }));
      }
      return;
    }
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
    const entry = materialId ? this.materials.get(materialId) : undefined;
    const material = entry?.converted.values().next().value as OpenPBRMaterial | undefined;
    if (!materialId || !entry || !material) {
      set({ material: null });
      return;
    }
    set({
      material: {
        id: materialId,
        name: entry.name,
        meshName: meshName ?? '',
        users: entry.meshes.size,
        values: readMaterial(material),
        textures: [...textureSlots(material)]
      }
    });
  }

  setMaterialValues(materialId: string, values: MaterialValues) {
    const entry = this.materials.get(materialId);
    if (!entry) return;
    for (const material of entry.converted) writeMaterial(material, values);
    const current = get().material;
    if (current?.id === materialId) set({ material: { ...current, values: { ...current.values, ...values } } });
  }

  resetMaterial(materialId: string) {
    const initial = this.materials.get(materialId)?.initial;
    if (initial) this.setMaterialValues(materialId, initial);
  }

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

  async exportImage(options: ExportOptions) {
    if (this.exporting) return;
    try {
      const blob = await this.renderImage(options);
      const link = document.createElement('a');
      const base = (get().model?.name ?? 'mutracer').replace(/\.[^.]+$/, '');
      link.download = `mutracer-${base}-${options.samples}spp.png`;
      link.href = URL.createObjectURL(blob);
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      showToast(`Saved ${link.download}`);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') showToast(`Export failed: ${(error as Error).message}`, 'error');
    }
  }

  /** Renders the current view offline at the given size and encodes the canvas. */
  async renderImage(options: ExportOptions, type = 'image/png', quality?: number): Promise<Blob> {
    if (this.exporting) throw new Error('A render is already running');
    this.exporting = true;
    this.exportAbort = new AbortController();
    const previous = this.renderer.getSize();
    const background = this.settings.background;
    const camera = this.activeCamera().clone();
    camera.aspect = options.width / options.height;
    camera.updateProjectionMatrix();
    set({ export: { stage: 'final', samples: 0, target: options.samples } });
    try {
      if (options.transparent && background !== 'transparent') {
        this.settings = { ...this.settings, background: 'transparent' };
        this.applyBackground();
      }
      this.sync.update();
      this.renderer.setSize(options.width, options.height);
      const clayCamera = fromTHREECamera(camera);
      clayCamera.aperture = this.settings.aperture;
      clayCamera.focusDistance = this.settings.focusDistance;
      await this.renderer.renderOfflineFrame(this.sync.scene, clayCamera, {
        samples: options.samples,
        signal: this.exportAbort.signal,
        previewIntervalMs: 250,
        onProgress: ({ stage, samples, targetSamples }) => set({ export: { stage, samples, target: targetSamples } })
      });
      this.renderer.prepareForExport();
      const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, type, quality));
      if (!blob) throw new Error('The canvas could not be encoded');
      return blob;
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
    const camera = this.activeCamera();
    camera.aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    camera.updateProjectionMatrix();
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
    const camera = fromTHREECamera(this.activeCamera());
    camera.aperture = this.settings.aperture;
    camera.focusDistance = this.settings.focusDistance;
    let status: RenderStatus;
    try {
      status = this.renderer.render(this.sync.scene, camera);
    } catch (error) {
      console.error(error);
      status = RENDER_STATUS_ERROR;
    }
    if (!this.backendKnown && status !== RENDER_STATUS_PREPARING) this.detectBackend();
    let phase = phaseOf(status);
    // While-converging OIDN denoises every few samples; report those as rendering so
    // the status does not flicker. Only the final denoise is shown.
    if (phase === 'denoising' && this.settings.denoiseWhileConverging &&
      (this.renderer.getTotalSamplesRendered() ?? 0) < this.settings.maxSamples) {
      phase = 'rendering';
    }
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
    if (!this.controls.update(dt) || this.dragging || this.settings.autoRotate) return;
    const step = this.lastCameraPosition.distanceTo(this.camera.position);
    if (step < 5e-4 * this.camera.position.distanceTo(this.controls.target)) {
      this.controls.enableDamping = false;
      this.controls.update(0);
      this.controls.enableDamping = true;
    }
  }

  private detectBackend() {
    const diagnostics = this.renderer.getDiagnostics();
    if (!diagnostics) return;
    this.backendKnown = true;
    set({ backend: { name: diagnostics.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2', adapter: shortAdapterName(diagnostics.adapterName) } });
    void this.updateDenoiser();
  }

  private publishStats(phase: RenderPhase, now: number, force: boolean) {
    const samples = this.renderer.getTotalSamplesRendered() ?? 0;
    // Restarted accumulation (an edit, a camera move or an animation frame).
    if (samples < this.lastSamples || samples <= 1) this.sampleStart = now;
    // Time stops at the last added sample, so it freezes once rendering finishes.
    if (samples !== this.lastSamples) this.lastSampleTime = now;
    this.lastSamples = samples;
    if (this.awaitingFirstSample) {
      const loading = get().loading;
      if (samples > 0 || phase === 'error') {
        this.awaitingFirstSample = false;
        set({ loading: null });
      } else if (loading) {
        const stage = phase === 'compiling' ? 'shaders' : 'bvh';
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
