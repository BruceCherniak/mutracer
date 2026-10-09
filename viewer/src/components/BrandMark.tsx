export function BrandMark() {
  return (
    <svg className="brand__mark" viewBox="0 0 30 30" aria-hidden>
      <defs>
        <radialGradient id="brand-clay" cx="38%" cy="32%" r="70%">
          <stop offset="0" stopColor="#ffd9c6" />
          <stop offset=".45" stopColor="#ec9673" />
          <stop offset="1" stopColor="#7e2f17" />
        </radialGradient>
      </defs>
      <rect width="30" height="30" rx="9" fill="#202227" />
      <ellipse cx="15" cy="22.5" rx="8" ry="2" fill="#000" opacity=".45" />
      <circle cx="15" cy="14" r="7.5" fill="url(#brand-clay)" />
    </svg>
  );
}
