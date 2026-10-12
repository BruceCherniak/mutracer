import type { Mat4, Vec3 } from '../types.js';
import { mat4, vec3 } from '../math.js';
import SceneNode from './SceneNode.js';

export type Projection = 'perspective' | 'orthographic';

/**
 * Perspective or orthographic camera. Position and orient it with
 * `transform` (camera-to-world), e.g. via `Camera.lookAt()`.
 *
 * ```ts
 * const camera = new Camera('perspective', 45, width / height, 0.1, 100);
 * Camera.lookAt(camera, [0, 1, 5], [0, 0, 0]);
 * ```
 */
export default class Camera extends SceneNode {
  /** Camera projection mode. Default `perspective`. */
  projection: Projection = 'perspective';

  /**
   * Lens f-number (focal length / aperture diameter) for depth of field.
   * Smaller values blur more. `0` disables depth of field (pinhole camera).
   * Orthographic cameras ignore it. Default `0`.
   */
  fStop = 0;
  /**
   * Distance from the lens to the plane in focus, measured along the view
   * direction, in scene units. Default `10`.
   */
  focusDistance = 10;
  /**
   * Sensor height in millimetres. With `fov` and `zoom` it defines the focal
   * length, and so the aperture size for a given `fStop`. Default `24`
   * (full-frame 35 mm).
   */
  sensorHeight = 24;
  /**
   * Length of one scene unit in metres, used to convert the lens size in
   * millimetres to scene units. glTF scenes are in metres. Default `1`.
   */
  metersPerUnit = 1;

  /** Vertical field of view in degrees (perspective). Default `45`. */
  fov = 45;
  /** Near clip distance. Default `0.1`. */
  near;
  /** Far clip distance. Default `2000`. */
  far;
  /** Width / height (perspective). Default `1`. */
  aspect = 1;

  /** Left orthographic frustum bound in scene units. Default `-1`. */
  left = -1;
  /** Right orthographic frustum bound in scene units. Default `1`. */
  right = 1;
  /** Top orthographic frustum bound in scene units. Default `1`. */
  top = 1;
  /** Bottom orthographic frustum bound in scene units. Default `-1`. */
  bottom = -1;

  /** Zoom factor applied to the field of view or orthographic bounds. Default `1`. */
  zoom = 1;

  constructor(
    projection: 'orthographic',
    left?: number,
    right?: number,
    bottom?: number,
    top?: number,
    near?: number,
    far?: number
  );
  constructor(
    projection: 'perspective',
    fov?: number,
    aspect?: number,
    near?: number,
    far?: number
  );
  constructor(
    projection: Projection,
    a?: number,
    b?: number,
    c?: number,
    d?: number,
    e?: number,
    f?: number
  ) {
    super();
    this.projection = projection ?? 'perspective';
    if (projection === 'orthographic') {
      this.left = a ?? -1;
      this.right = b ?? 1;
      this.bottom = c ?? -1;
      this.top = d ?? 1;
      this.near = e ?? 0.1;
      this.far = f ?? 2000;
    } else {
      this.fov = a ?? 45;
      this.aspect = b ?? 1;
      this.near = c ?? 0.1;
      this.far = d ?? 2000;
    }
  }

  /** Places the camera at `eye` looking at `center`. */
  static lookAt(
    camera: Camera,
    eye: Vec3,
    center: Vec3,
    up?: Vec3
  ) {
    mat4.invert(
      camera.transform,
      mat4.lookAt(
        camera.transform,
        eye,
        center,
        up || vec3.fromValues(0, 1, 0)
      )
    );
  }

  /** Copies camera parameters and world matrix from source into target. */
  static copy(source: Camera, target: Camera) {
    target.projection = source.projection;
    target.fov = source.fov;
    target.near = source.near;
    target.far = source.far;
    target.aspect = source.aspect;
    target.zoom = source.zoom;
    target.fStop = source.fStop;
    target.focusDistance = source.focusDistance;
    target.sensorHeight = source.sensorHeight;
    target.metersPerUnit = source.metersPerUnit;
    target.left = source.left;
    target.right = source.right;
    target.top = source.top;
    target.bottom = source.bottom;

    mat4.copy(target.transform, source.transform);
  }

  /**
   * Focal length in millimetres of a perspective camera, from `sensorHeight`,
   * `fov` and `zoom`. Returns `0` for an orthographic camera.
   */
  static getFocalLength(camera: Camera) {
    if (camera.projection !== 'perspective') return 0;
    const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
    return (
      (0.5 * camera.sensorHeight * Math.max(camera.zoom, Number.EPSILON)) /
      tanHalfFov
    );
  }

  /**
   * Lens (aperture) radius in scene units used for depth of field:
   * `focalLength / (2 * fStop)` converted with `metersPerUnit`. Returns `0`
   * when depth of field is off, for orthographic cameras and for invalid
   * parameters.
   */
  static getApertureRadius(camera: Camera) {
    const { fStop, metersPerUnit } = camera;
    if (!(fStop > 0) || !(metersPerUnit > 0)) return 0;
    const radius =
      Camera.getFocalLength(camera) / (2 * fStop) / 1000 / metersPerUnit;
    return Number.isFinite(radius) && radius > 0 ? radius : 0;
  }

  /** Returns a new column-major projection matrix including zoom. */
  static getProjectionMatrix(camera: Camera): Mat4 {
    if (camera.projection === 'perspective') {
      const fov = (camera.fov * Math.PI) / 180;
      const effectiveFov =
        2 * Math.atan(Math.tan(fov / 2) / Math.max(camera.zoom, Number.EPSILON));
      return mat4.perspective(
        [] as any as Mat4,
        effectiveFov,
        camera.aspect,
        camera.near,
        camera.far
      );
    }
    return mat4.ortho(
      [] as any as Mat4,
      (camera.left + camera.right) / 2 -
        (camera.right - camera.left) / (2 * camera.zoom),
      (camera.left + camera.right) / 2 +
        (camera.right - camera.left) / (2 * camera.zoom),
      (camera.bottom + camera.top) / 2 -
        (camera.top - camera.bottom) / (2 * camera.zoom),
      (camera.bottom + camera.top) / 2 +
        (camera.top - camera.bottom) / (2 * camera.zoom),
      camera.near,
      camera.far
    );
  }
}
