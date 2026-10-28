// Shared studio placement and ambient gradient, independent of Three.js.
export function studioPanel(cx: number, cy: number, cz: number, radius: number,
  azimuthDegrees: number, elevationDegrees: number, panelDistance: number,
  panelWidth: number, panelHeight: number, power: number, intensity: number,
  rotation: number, size: number, ground: number): [number, number, number,
  number, number, number, number, number, number, number, number, number, number, number, number] {
  const r = Math.max(radius, 1e-3);
  const azimuth = (azimuthDegrees + rotation) * (Math.PI / 180);
  const width = panelWidth * size * r;
  const height = panelHeight * size * r;
  const distance = panelDistance * r;
  const xx = Math.cos(azimuth);
  const xz = -Math.sin(azimuth);
  let elevation = elevationDegrees * (Math.PI / 180);
  let zx = Math.sin(azimuth) * Math.cos(elevation);
  let zy = Math.sin(elevation);
  let zz = Math.cos(azimuth) * Math.cos(elevation);
  let yy = zz * xx - zx * xz;
  let py = cy + zy * distance;
  for (let i = 0; i < 16; i++) {
    if (py - Math.abs(yy) * height / 2 >= ground + 0.02 * r) { break; }
    elevation += 2 * (Math.PI / 180);
    zx = Math.sin(azimuth) * Math.cos(elevation);
    zy = Math.sin(elevation);
    zz = Math.cos(azimuth) * Math.cos(elevation);
    yy = zz * xx - zx * xz;
    py = cy + zy * distance;
  }
  const radiance = (Math.PI * 2 * intensity * power * panelDistance ** 2)
    / (panelWidth * panelHeight * size * size);
  return [width, height, radiance, xx, 0, xz, zy * xz, yy, -zy * xx,
    zx, zy, zz, cx + zx * distance, py, cz + zz * distance];
}
export function studioAmbientValue(row: number, height: number): number {
  const y = Math.cos(((row + 0.5) / height) * Math.PI);
  return y >= 0 ? 0.6 + 0.4 * y : 0.6 + 0.35 * y;
}
