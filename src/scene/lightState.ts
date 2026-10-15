import type AmbientLight from './AmbientLight.js';
import type DirectionalLight from './DirectionalLight.js';
import type EnvironmentLightState from './EnvironmentLightState.js';
import type RectLightState from './RectLightState.js';
import type SphereLight from './SphereLight.js';
import type SpotLight from './SpotLight.js';
export type AnalyticLightState = RectLightState | SphereLight | SpotLight | DirectionalLight;
export type SceneLightState = AmbientLight | EnvironmentLightState | AnalyticLightState;
