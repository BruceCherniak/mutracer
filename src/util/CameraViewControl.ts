import type { Vec2, Vec3 } from '../types.js';
import { mat3, mat4, quat, vec2, vec3 } from '../math.js';
import type Mesh from '../scene/Mesh.js';
import Camera from '../scene/Camera.js';
import { computeMeshesBoundingBox } from './mesh.js';

const MOUSE_BUTTON_KEY_MAP = {
  left: 0,
  middle: 1,
  right: 2
};

function convertToArray(val: number | number[]): number[] {
  if (!Array.isArray(val)) {
    val = [val, val];
  }
  return val;
}

interface OrbitControlOpts {
  camera: Camera;
  domElement: HTMLElement;

  /**
   * States of orbit
   */
  distance: number;
  orthographicSize: number;
  alpha: number;
  beta: number;
  center: Vec3;

  /**
   * Minimum distance to the center
   * @type {number}
   * @default 0.5
   */
  minDistance: number;

  /**
   * Maximum distance to the center
   * @type {number}
   * @default 2
   */
  maxDistance: number;

  /**
   * Only available when camera is orthographic
   */
  maxOrthographicSize: number;

  /**
   * Only available when camera is orthographic
   */
  minOrthographicSize: number;

  /**
   * Aspect of camera
   */
  aspect: number;

  /**
   * Minimum alpha rotation
   */
  minAlpha: number;

  /**
   * Maximum alpha rotation
   */
  maxAlpha: number;

  /**
   * Minimum beta rotation
   */
  minBeta: number;
  /**
   * Maximum beta rotation
   */
  maxBeta: number;

  /**
   * Start auto rotating after still for the given time
   */
  autoRotateAfterStill: number;

  /**
   * Direction of autoRotate. cw or ccw when looking top down.
   */
  autoRotateDirection: 'cw' | 'ccw';

  /**
   * Degree per second
   */
  autoRotateSpeed: number;

  panMouseButton: 'middle' | 'left' | 'right';
  rotateMouseButton: 'left' | 'middle' | 'right';

  damping: number;

  rotateSensitivity: number;

  zoomSensitivity: number;

  /**
   * Invert zoom direction?
   */
  invertZoomDirection: false;

  panSensitivity: number;

  autoRotate: boolean;
}

interface CameraViewControl
  extends Omit<
    OrbitControlOpts,
    | 'autoRotate'
    | 'camera'
    | 'distance'
    | 'orthographicSize'
    | 'alpha'
    | 'beta'
    | 'center'
  > {}

/**
 * Orbit camera controller: drag to rotate, middle-drag to pan, wheel to zoom.
 * Call `update()` every frame before `renderer.render()`.
 *
 * ```ts
 * const controls = new CameraViewControl({ camera, domElement: canvas });
 * controls.fitToMeshes(scene.meshes);
 * ```
 */
class CameraViewControl {
  private _autoRotate: boolean = false;
  private _camera?: Camera;
  private _center = vec3.create();

  private _orthoSize?: number;

  private _mode?: 'rotate' | 'pan' = 'rotate';

  private _needsUpdate = false;

  private _rotating = false;

  // Rotation around yAxis
  private _phi = 0;
  // Rotation around xAxis
  private _theta = 0;

  private _mouseX = 0;
  private _mouseY = 0;

  private _rotateVelocity = vec2.create();

  private _panVelocity = vec2.create();

  private _distance = 20;

  private _zoomSpeed = 0;

  private _stillTimeout = 0;

  private _innerZoomScale = 1;

  private _pos = vec3.create();
  private _rot = quat.create();

  constructor(
    opts: Omit<Partial<OrbitControlOpts>, 'domElement'> & {
      domElement: HTMLElement;
    }
  ) {
    this.domElement = opts.domElement;

    this.setOption(
      Object.assign(
        {
          autoRotate: false,
          autoRotateAfterStill: 0,
          autoRotateDirection: 'cw',
          autoRotateSpeed: 60,
          damping: 0,
          minDistance: 0.1,
          maxDistance: 1000,
          maxOrthographicSize: 300,
          minOrthographicSize: 1,
          aspect: 1,
          minAlpha: -90,
          maxAlpha: 90,
          minBeta: -Infinity,
          maxBeta: Infinity,
          panMouseButton: 'middle',
          rotateMouseButton: 'left',
          invertZoomDirection: false,
          rotateSensitivity: 1,
          zoomSensitivity: 1,
          panSensitivity: 1
        },
        opts
      )
    );
    // Set target after option updated.
    this.camera = opts.camera;

    // Each OrbitControl has it's own handler
    this._mouseDownHandler = this._mouseDownHandler.bind(this);
    this._mouseWheelHandler = this._mouseWheelHandler.bind(this);
    this._mouseMoveHandler = this._mouseMoveHandler.bind(this);
    this._mouseUpHandler = this._mouseUpHandler.bind(this);

    this.init();
  }

  /**
   * If auto rotate the target
   */
  get autoRotate() {
    return this._autoRotate;
  }

  set autoRotate(val: boolean) {
    this._autoRotate = val;
    this._rotating = val;
  }

  get camera(): Camera | undefined {
    return this._camera;
  }

  set camera(val: Camera | undefined) {
    this._camera = val;
    this.aspect = val?.aspect ?? this.aspect;
    this.decomposeTransform();
  }

  /**
   * Initialize.
   * Mouse event binding
   */
  private init() {
    const dom = this.domElement;

    dom.addEventListener('pointerdown', this._mouseDownHandler);
    dom.addEventListener('wheel', this._mouseWheelHandler);

    if (this.camera) {
      this.decomposeTransform();
    }
  }

  /**
   * Dispose.
   * Mouse event unbinding
   */
  dispose() {
    const dom = this.domElement;

    dom.removeEventListener('pointerdown', this._mouseDownHandler);
    dom.removeEventListener('pointermove', this._mouseMoveHandler);
    dom.removeEventListener('pointerup', this._mouseUpHandler);
    dom.removeEventListener('wheel', this._mouseWheelHandler);
    dom.removeEventListener('pointerout', this._mouseUpHandler);
  }

  /**
   * Get distance
   * @return {number}
   */
  getDistance() {
    return this._distance;
  }

  /**
   * Set distance
   * @param {number} distance
   */
  setDistance(distance: number) {
    this._distance = distance;
    this._needsUpdate = true;
  }

  /**
   * Get size of orthographic viewing volume
   * @return {number}
   */
  getOrthographicSize() {
    return this._orthoSize;
  }

  /**
   * Set size of orthographic viewing volume
   * @param {number} size
   */
  setOrthographicSize(size: number) {
    this._orthoSize = size;
    this._needsUpdate = true;
  }

  /**
   * Get alpha rotation
   * Alpha angle for top-down rotation. Positive to rotate to top.
   *
   * Which means camera rotation around x axis.
   */
  getAlpha() {
    return (this._theta / Math.PI) * 180;
  }

  /**
   * Get beta rotation
   * Beta angle for left-right rotation. Positive to rotate to right.
   *
   * Which means camera rotation around y axis.
   */
  getBeta() {
    return (-this._phi / Math.PI) * 180;
  }

  /**
   * Get control center
   * @return {Array.<number>}
   */
  getCenter(): Vec3 {
    return this._center.slice();
  }

  /**
   * Set alpha rotation angle
   * @param {number} alpha
   */
  setAlpha(alpha: number) {
    alpha = Math.max(Math.min(this.maxAlpha, alpha), this.minAlpha);

    this._theta = (alpha / 180) * Math.PI;
    this._needsUpdate = true;
  }

  /**
   * Set beta rotation angle
   * @param {number} beta
   */
  setBeta(beta: number) {
    beta = Math.max(Math.min(this.maxBeta, beta), this.minBeta);

    this._phi = (-beta / 180) * Math.PI;
    this._needsUpdate = true;
  }

  /**
   * Set control center
   * @param {Array.<number>} center
   */
  setCenter(centerArr: Vec3) {
    vec3.copy(this._center, centerArr);
  }

  setOption(opts?: Partial<OrbitControlOpts>) {
    opts = opts || {};

    (
      [
        'autoRotate',
        'autoRotateAfterStill',
        'autoRotateDirection',
        'autoRotateSpeed',
        'damping',
        'minDistance',
        'maxDistance',
        'minOrthographicSize',
        'maxOrthographicSize',
        'aspect',
        'minAlpha',
        'maxAlpha',
        'minBeta',
        'maxBeta',
        'panMouseButton',
        'rotateMouseButton',
        'invertZoomDirection',
        'rotateSensitivity',
        'zoomSensitivity',
        'panSensitivity'
      ] as const
    ).forEach((key) => {
      if (opts![key] != null) {
        (this as any)[key] = opts![key];
      }
    });

    if (opts.distance != null) {
      this.setDistance(opts.distance);
    }
    if (opts.orthographicSize != null) {
      this.setOrthographicSize(opts.orthographicSize);
    }

    if (opts.alpha != null) {
      this.setAlpha(opts.alpha);
    }
    if (opts.beta != null) {
      this.setBeta(opts.beta);
    }

    if (opts.center) {
      this.setCenter(opts.center);
    }

    this._updateTransform();

    if (this.camera) {
      mat4.fromRotationTranslation(
        this.camera.transform,
        this._rot,
        this._pos
      );
    }
  }

  /**
   * Call update each frame
   * @param  {number} deltaTime Frame time
   */
  update(deltaTime?: number) {
    deltaTime = deltaTime || 16;

    if (this._rotating) {
      const radian =
        (((this.autoRotateDirection === 'cw' ? 1 : -1) * this.autoRotateSpeed) /
          180) *
        Math.PI;
      this._phi -= (radian * deltaTime) / 1000;
      this._needsUpdate = true;
    } else if (vec2.len(this._rotateVelocity) > 0) {
      this._needsUpdate = true;
    }

    if (Math.abs(this._zoomSpeed) > 0.01 || vec2.len(this._panVelocity) > 0) {
      this._needsUpdate = true;
    }

    if (!this._needsUpdate) {
      return;
    }

    // Fixed deltaTime
    if (this._camera && this._camera.aspect !== undefined) this._camera.aspect = this.aspect;

    this._updateDistanceOrSize(Math.min(deltaTime, 50));
    this._updatePan();

    this._updateRotate(Math.min(deltaTime, 50));

    this._updateTransform();

    if (this.camera) {
      mat4.fromRotationTranslation(
        this.camera.transform,
        this._rot,
        this._pos
      );
    }

    this._needsUpdate = false;
  }

  fitToMeshes(meshes: Mesh[]) {
    this.fitToBoundingBox(computeMeshesBoundingBox(meshes));
  }

  fitToBoundingBox(bbox: { min: Vec3; max: Vec3 }) {
    const camera = this.camera;
    if (!camera) {
      return;
    }
    const width = bbox.max[0] - bbox.min[0];
    const height = bbox.max[1] - bbox.min[1];
    const depth = bbox.max[2] - bbox.min[2];

    const maxSize = Math.max(width, height, depth);
    if (camera) {
      camera.far = maxSize * 20;
      camera.near = camera.far / 1000;
    }
    this._innerZoomScale = Math.sqrt(maxSize) / 5;

    const center = vec3.lerp(
      [] as any as Vec3,
      bbox.min,
      bbox.max,
      0.5
    );
    const fitSize = height * 1.2;

    this.setCenter(center);
    this.setDistance(
      fitSize / 2 / Math.tan((Math.PI * camera.fov) / 360) + depth / 2
    );
    this.setOrthographicSize(fitSize);
  }

  private _updateRotate(deltaTime: number) {
    const velocity = this._rotateVelocity;
    this._phi = (velocity[1] * deltaTime) / 20 + this._phi;
    this._theta = (velocity[0] * deltaTime) / 20 + this._theta;

    this.setAlpha(this.getAlpha());
    this.setBeta(this.getBeta());

    this._vectorDamping(velocity, this.damping);
  }

  private _updateDistanceOrSize(deltaTime: number) {
    this._setDistance(this._distance + (this._zoomSpeed * deltaTime) / 50);
    this._setOrthoSize(this._orthoSize! + (this._zoomSpeed * deltaTime) / 50);

    this._zoomSpeed *= Math.pow(this.damping, deltaTime / 16);
  }

  private _setDistance(distance: number) {
    this._distance = Math.max(
      Math.min(distance, this.maxDistance),
      this.minDistance
    );
  }

  private _setOrthoSize(size: number) {
    this._orthoSize = Math.max(
      Math.min(size, this.maxOrthographicSize),
      this.minOrthographicSize
    );
    const camera = this.camera!;
    const cameraHeight = this._orthoSize;
    const cameraWidth = cameraHeight * this.aspect;
    camera.left = -cameraWidth / 2;
    camera.right = cameraWidth / 2;
    camera.top = cameraHeight / 2;
    camera.bottom = -cameraHeight / 2;
  }

  private _updatePan() {
    const velocity = this._panVelocity;
    const len = this._distance;

    const target = this._camera;
    if (!target) {
      return;
    }
    const matrixWorld = target.transform;
    const yAxis = [
      matrixWorld[4],
      matrixWorld[5],
      matrixWorld[6]
    ] as Vec3;
    const xAxis = [
      matrixWorld[0],
      matrixWorld[1],
      matrixWorld[2]
    ] as Vec3;
    const center = this._center;
    // PENDING
    vec3.scaleAndAdd(center, center, xAxis, (-velocity[0] * len) / 200);
    vec3.scaleAndAdd(center, center, yAxis, (-velocity[1] * len) / 200);

    this._vectorDamping(velocity, 0);

    velocity[0] = velocity[1] = 0;
  }

  private _updateTransform() {
    const camera = this.camera;
    if (!camera) {
      return;
    }

    const theta = this._theta + Math.PI / 2;
    const phi = this._phi + Math.PI / 2;
    const r = Math.sin(theta);
    const dir = vec3.fromValues(
      r * Math.cos(phi),
      -Math.cos(theta),
      r * Math.sin(phi)
    );
    const rot = this._rot;

    vec3.scaleAndAdd(this._pos, this._center, dir, this._distance);
    quat.identity(rot);
    quat.rotateY(rot, rot, -this._phi);
    quat.rotateX(rot, rot, -this._theta);
  }

  private _startCountingStill() {
    clearTimeout(this._stillTimeout);

    const time = this.autoRotateAfterStill;
    const self = this;
    if (!isNaN(time) && time > 0) {
      this._stillTimeout = setTimeout(function () {
        self._rotating = true;
      }, time * 1000) as any;
    }
  }

  private _vectorDamping(v: Vec2, damping: number) {
    let speed = vec2.len(v);
    speed = speed * damping;
    if (speed < 1e-4) {
      speed = 0;
    }
    vec2.normalize(v, v);
    vec2.scale(v, v, speed);
  }

  decomposeTransform() {
    if (!this.camera) {
      return;
    }

    const m4 = this.camera.transform;
    const m3 = mat3.create();
    mat3.fromMat4(m3, m4);
    quat.fromMat3(this._rot, m3);
    vec3.set(this._pos, m4[12], m4[13], m4[14]);

    const forward = [m4[8], m4[9], m4[10]];
    const alpha = Math.asin(forward[1]);
    const beta = Math.atan2(forward[0], forward[2]);

    this._theta = alpha;
    this._phi = -beta;

    this.setBeta(this.getBeta());
    this.setAlpha(this.getAlpha());

    this._setDistance(vec3.dist(this._pos, this._center));
    if (this.camera.projection === 'orthographic') {
      this._setOrthoSize(this.camera.top - this.camera.bottom);
    }
  }

  private _mouseDownHandler(e: MouseEvent | TouchEvent) {
    let x = (e as MouseEvent).clientX;
    let y = (e as MouseEvent).clientY;
    // Touch
    if ((e as TouchEvent).targetTouches) {
      const touch = (e as TouchEvent).targetTouches[0];
      x = touch.clientX;
      y = touch.clientY;

      this._mode = 'rotate';
    } else {
      if (
        (e as MouseEvent).button ===
        MOUSE_BUTTON_KEY_MAP[this.rotateMouseButton]
      ) {
        this._mode = 'rotate';
      } else if (
        (e as MouseEvent).button === MOUSE_BUTTON_KEY_MAP[this.panMouseButton]
      ) {
        this._mode = 'pan';

        /**
         * Vendors like Mozilla provide a mouse-driven panning feature
         * that is activated when the middle mouse button is pressed.
         *
         * @see https://w3c.github.io/uievents/#event-type-mousedown
         */
        e.preventDefault();
      } else {
        this._mode = undefined;
      }
    }

    const dom = this.domElement;
    dom.addEventListener('pointermove', this._mouseMoveHandler);
    dom.addEventListener('pointerup', this._mouseUpHandler);
    dom.addEventListener('pointerout', this._mouseUpHandler);

    // Reset rotate velocity
    vec2.set(this._rotateVelocity, 0, 0);
    this._rotating = false;
    if (this.autoRotate) {
      this._startCountingStill();
    }

    this._mouseX = x;
    this._mouseY = y;
  }

  private _mouseMoveHandler(e: MouseEvent | TouchEvent) {
    let x = (e as MouseEvent).clientX;
    let y = (e as MouseEvent).clientY;

    let haveGesture;
    // Touch
    if ((e as TouchEvent).targetTouches) {
      const touch = (e as TouchEvent).targetTouches[0];
      x = touch.clientX;
      y = touch.clientY;
    }

    const panSensitivity = convertToArray(this.panSensitivity);
    const rotateSensitivity = convertToArray(this.rotateSensitivity);

    if (!haveGesture) {
      if (this._mode === 'rotate') {
        this._rotateVelocity[1] +=
          ((x - this._mouseX) / this.domElement.clientWidth) *
          2 *
          rotateSensitivity[0];
        this._rotateVelocity[0] +=
          ((y - this._mouseY) / this.domElement.clientHeight) *
          2 *
          rotateSensitivity[1];
      } else if (this._mode === 'pan') {
        this._panVelocity[0] +=
          ((x - this._mouseX) / this.domElement.clientWidth) *
          panSensitivity[0] *
          400;
        this._panVelocity[1] +=
          ((-y + this._mouseY) / this.domElement.clientHeight) *
          panSensitivity[1] *
          400;
      }
    }

    this._mouseX = x;
    this._mouseY = y;

    e.preventDefault && e.preventDefault();
  }

  private _mouseWheelHandler(e: WheelEvent) {
    const delta = e.deltaY;
    if (delta === 0) {
      return;
    }

    if (this.invertZoomDirection) {
      this._zoomHandler(e, delta > 0 ? -1 : 1);
    } else {
      this._zoomHandler(e, delta > 0 ? 1 : -1);
    }
  }

  private _zoomHandler(e: WheelEvent, delta: number) {
    const speed = Math.max(
      Math.max(
        Math.min(
          this._distance - this.minDistance,
          this.maxDistance - this._distance
        )
      ) / 20,
      0.5
    );

    this._zoomSpeed =
      (delta > 0 ? -1 : 1) *
      speed *
      this.zoomSensitivity *
      this._innerZoomScale;

    this._rotating = false;

    if (this.autoRotate && this._mode === 'rotate') {
      this._startCountingStill();
    }

    e.preventDefault && e.preventDefault();
  }

  private _mouseUpHandler() {
    const dom = this.domElement;
    dom.removeEventListener('pointermove', this._mouseMoveHandler);
    dom.removeEventListener('pointerup', this._mouseUpHandler);
    dom.removeEventListener('pointerout', this._mouseUpHandler);
  }
}

export default CameraViewControl;
