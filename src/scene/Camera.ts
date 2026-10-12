import type { Mat4 } from '../types.js';
import { mat4 } from '../math.js';
import SceneNode from './SceneNode.js';

export type Projection = 'perspective' | 'orthographic';

/**
 * Perspective or orthographic camera. Position and orient it with
 * `transform` (camera-to-world), via `position` and `lookAt()`.
 *
 * ```ts
 * const camera = new Camera({ projection: 'perspective', fov: 45, near: 0.1, far: 100 });
 * camera.position = [0, 1, 5]; camera.lookAt([0, 0, 0]);
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
  /** Width / height (perspective). Default undefined uses the renderer canvas aspect. */
  aspect: number | undefined = undefined;

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

  /** Creates a camera; projection is required and other options use the documented defaults. */
  constructor(params:
    | {
        /** Perspective projection. Required. */ projection: 'perspective';
        /** Vertical field of view, in degrees. Default 45. */ fov?: number;
        /** Width / height. Default undefined uses the renderer canvas aspect. */ aspect?: number;
        /** Near clip distance. Default 0.1. */ near?: number;
        /** Far clip distance. Default 2000. */ far?: number;
      }
    | {
        /** Orthographic projection. Required. */ projection: 'orthographic';
        /** Left bound. Default -1. */ left?: number;
        /** Right bound. Default 1. */ right?: number;
        /** Bottom bound. Default -1. */ bottom?: number;
        /** Top bound. Default 1. */ top?: number;
        /** Near clip distance. Default 0.1. */ near?: number;
        /** Far clip distance. Default 2000. */ far?: number;
      }
  ) {
    super();
    this.projection = params.projection;
    this.near = params.near ?? .1;
    this.far = params.far ?? 2000;
    if(params.projection === 'perspective') {
      this.fov = params.fov ?? 45;
      this.aspect = params.aspect;
    } else {
      this.left = params.left ?? -1; this.right = params.right ?? 1;
      this.bottom = params.bottom ?? -1; this.top = params.top ?? 1;
    }
  }

  /** Copies camera parameters and world matrix from source into target. */
  copy(source: Camera): this {
    const target = this;
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
    return this;
  }

  /** Creates an independent camera with copied settings and transform. */
  clone(): Camera {
    return new Camera({ projection: this.projection }).copy(this);
  }

  /** Returns a new column-major projection matrix including zoom. Default targetAspect 1, used only when aspect is undefined. */
  getProjectionMatrix(targetAspect = 1): Mat4 {
    const camera = this;
    if (camera.projection === 'perspective') {
      const fov = (camera.fov * Math.PI) / 180;
      const effectiveFov =
        2 * Math.atan(Math.tan(fov / 2) / Math.max(camera.zoom, Number.EPSILON));
      return mat4.perspective(
        [] as any as Mat4,
        effectiveFov,
        camera.aspect ?? targetAspect,
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
