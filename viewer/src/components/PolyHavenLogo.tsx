// The Poly Haven mark as a solid silhouette, from the official logo kit at
// polyhaven.com/logo. Its guidelines allow the mark for crediting Poly Haven
// assets, recolored only as a solid silhouette and with the shape unchanged.
export function PolyHavenLogo({ size = 14 }: { size?: number }) {
  return (
    <svg className="ph-logo" width={(size * 220) / 300} height={size} viewBox="40 0 220 300" fill="currentColor" aria-hidden="true">
      <path d="M50.407,63.621l99.593,-57.5l99.593,57.5l0,115l-99.593,57.5c-0,-0 -49.796,-28.75 -49.796,-28.75l-0,57.5l-49.797,28.75l-0,-115l49.797,-28.75l49.796,28.75l0,0l49.797,-28.75l-0.001,0l0,-57.5l-49.796,-28.75l-49.796,28.75l-49.797,-28.75Z" />
    </svg>
  );
}
