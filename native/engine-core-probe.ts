/// <reference path="./browser-types.d.ts" />

// Direct imports distinguish renderer blockers from the optional Three.js
// conversion exports in the main barrel. This still uses the real renderer.
import Engine from '../src/Engine.js';
import Render from '../src/Render.js';

export function probeEngine(): void {
  const engine = new Engine();
  const render = new Render(engine);
  void engine.init();
  render.dispose();
  engine.dispose();
}
