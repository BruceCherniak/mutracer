import { mat4, vec3 } from '../math';
import SceneNode from './SceneNode';

export type Projection = 'perspective' | 'orthographic';

/**
 * Perspective or orthographic camera. Position and orient it with
 * `matrixWorld` (camera-to-world), e.g. via `Camera.lookAt()`.
 *
 * ```ts
 * const camera = new Camera('perspective', 45, width / height, 0.1, 100);
 * Camera.lookAt(camera, [0, 1, 5], [0, 0, 0]);
 * ```
 */
export default class Camera extends SceneNode {
  projection: Projection = 'perspective';

  /** Distance to the plane in focus when `aperture > 0`. Default `10`. */
  focusDistance = 10;
  /** Lens radius for depth of field. `0` disables depth of field. Default `0`. */
  aperture = 0;

  /** Vertical field of view in degrees (perspective). Default `45`. */
  fov = 45;
  /** Near clip distance. Default `0.1`. */
  near;
  /** Far clip distance. Default `2000`. */
  far;
  /** Width / height (perspective). Default `1`. */
  aspect = 1;

  /** Orthographic frustum bounds. */
  left = -1;
  right = 1;
  top = 1;
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
    eye: vec3.Vec3Array,
    center: vec3.Vec3Array,
    up?: vec3.Vec3Array
  ) {
    mat4.invert(
      camera.matrixWorld,
      mat4.lookAt(
        camera.matrixWorld,
        eye,
        center,
        up || vec3.fromValues(0, 1, 0)
      )
    );
  }

  static copy(source: Camera, target: Camera) {
    target.projection = source.projection;
    target.fov = source.fov;
    target.near = source.near;
    target.far = source.far;
    target.aspect = source.aspect;
    target.zoom = source.zoom;
    target.focusDistance = source.focusDistance;
    target.aperture = source.aperture;
    target.left = source.left;
    target.right = source.right;
    target.top = source.top;
    target.bottom = source.bottom;

    mat4.copy(target.matrixWorld, source.matrixWorld);
  }

  static getProjectionMatrix(camera: Camera) {
    if (camera.projection === 'perspective') {
      const fov = (camera.fov * Math.PI) / 180;
      const effectiveFov =
        2 * Math.atan(Math.tan(fov / 2) / Math.max(camera.zoom, Number.EPSILON));
      return mat4.perspective(
        [] as any as mat4.Mat4Array,
        effectiveFov,
        camera.aspect,
        camera.near,
        camera.far
      );
    }
    return mat4.ortho(
      [] as any as mat4.Mat4Array,
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
