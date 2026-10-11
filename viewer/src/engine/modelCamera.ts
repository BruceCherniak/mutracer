/** Camera stored by the asset pipeline, after the viewer grounds the model. */
export interface ModelCamera {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  space: 'grounded';
}

export function readModelCamera(value: unknown): ModelCamera | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ModelCamera>;
  const vector = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (candidate.space !== 'grounded' || !vector(candidate.position) || !vector(candidate.target) ||
    typeof candidate.fov !== 'number' || !Number.isFinite(candidate.fov) || candidate.fov <= 0 || candidate.fov >= 180 ||
    candidate.position.every((v, i) => v === candidate.target![i])) return null;
  return candidate as ModelCamera;
}
