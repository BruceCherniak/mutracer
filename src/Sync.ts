import type Engine from './Engine.js';

/** Integration point for external scene, camera and interaction sources. */
export default abstract class Sync {
  private _active = false;
  private _activeUntil = -Infinity;
  /** Binds this sync without modifying the engine. */
  constructor(readonly engine: Engine) {}
  /** Writes the latest external state to the engine before its commit. */
  abstract update(): void;
  /** Whether this source expects further changes. Default false. */
  get active(): boolean { return this._active || performance.now() < this._activeUntil; }
  /** Marks an ongoing interaction. Default false. */
  protected setActive(active: boolean): void { this._active = active; }
  /** Extends activity for the given milliseconds. */
  protected activateFor(ms: number): void { this._activeUntil = Math.max(this._activeUntil, performance.now() + Math.max(0, ms)); }
  /** Releases external subscriptions. Base implementation clears activity. */
  dispose(): void { this._active = false; this._activeUntil = -Infinity; }
}
