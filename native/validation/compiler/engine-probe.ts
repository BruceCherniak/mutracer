/// <reference path="../../src/browser-types.d.ts" />

import { Engine, Render } from '../../../src/main.js';

// Force the real Engine/Render path into a library build, including async GPU
// initialization. A successful version-only archive would not test that path.
export function probeEngine(): void {
  const engine = new Engine();
  const render = new Render(engine);
  void engine.init();
  render.dispose();
  engine.dispose();
}
