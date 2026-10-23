/** Apparent sun radius in degrees; larger than the real 0.27° so the disk reads at map resolution. */
export const SUN_RADIUS = 0.4;
/** Aerosol density relative to a very clean atmosphere (optical depth about 0.005). */
export const TURBIDITY = 5;
export const GROUND_ALBEDO = [0.2, 0.18, 0.15];
/** Sun plus sky irradiance on a horizontal plane with the sun at 33°. */
export const ILLUMINANCE = Math.PI;
/** Horizontal illuminance of this atmosphere for unit solar irradiance and a 33° sun. */
export const REFERENCE_ILLUMINANCE = 0.488;

