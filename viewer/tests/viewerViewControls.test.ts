import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => vi.stubGlobal('location', { search: '', hash: '' }));
vi.mock('../src/engine/ViewerEngine', () => ({ getEngine: () => null }));

import { CameraControls } from '../src/components/ViewControls';
import { DEFAULT_SETTINGS, useViewer } from '../src/store';

const initialState = { ...useViewer.getInitialState() };
afterEach(() => Object.assign(useViewer.getInitialState(), initialState));

describe('viewport camera controls', () => {
  it.each([[], ['Front'], ['Front', 'Side']])('keeps fit available with cameras %j', (...cameras) => {
    Object.assign(useViewer.getInitialState(), {
      settings: { ...DEFAULT_SETTINGS, cameraIndex: -1 },
      cameras
    });
    const markup = renderToStaticMarkup(createElement(CameraControls));
    expect(markup).toContain('aria-label="Fit to model"');
    expect(markup).toContain('title="Fit to model (F)"');
    expect(markup.includes('aria-label="Camera"')).toBe(cameras.length > 0);
  });
});
