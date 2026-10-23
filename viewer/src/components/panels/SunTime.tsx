import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { DEFAULT_SKY_TIME, SKY_TIME_RANGE, sunPosition } from '../../engine/sky';

const [MIN, MAX] = SKY_TIME_RANGE;
const W = 280, H = 104, HORIZON = 76, TOP = 14;
const PEAK = sunPosition(12).elevation;
const STEP = 5 / 60;

const x = (hours: number) => ((hours - MIN) / (MAX - MIN)) * W;
const y = (elevation: number) => HORIZON - (elevation / PEAK) * (HORIZON - TOP);

export const formatSkyTime = (hours: number) => {
  const minutes = Math.round(hours * 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
};

type RGB = [number, number, number];
// Zenith and horizon colors by sun elevation, from twilight to midday.
const SKY: [number, RGB, RGB][] = [
  [-6, [14, 22, 48], [52, 50, 82]],
  [-1, [34, 52, 96], [196, 116, 98]],
  [3, [52, 86, 148], [238, 160, 104]],
  [10, [58, 104, 178], [236, 200, 160]],
  [25, [56, 108, 194], [176, 204, 232]],
  [90, [44, 98, 192], [168, 198, 232]]
];

function skyColors(elevation: number): [string, string] {
  let i = 0;
  while (i < SKY.length - 2 && elevation > SKY[i + 1][0]) i++;
  const [e0, z0, h0] = SKY[i], [e1, z1, h1] = SKY[i + 1];
  const t = Math.min(Math.max((elevation - e0) / (e1 - e0), 0), 1);
  const mix = (a: RGB, b: RGB) => `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * t)).join(' ')})`;
  return [mix(z0, z1), mix(h0, h1)];
}

/** Time-of-day dial: the sun's path over the horizon, dragged along the day. */
export function SunTime({ value, onChange }: { value: number; onChange: (hours: number) => void }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const path = useMemo(() => {
    const points: string[] = [];
    for (let i = 0; i <= 64; i++) {
      const hours = MIN + ((MAX - MIN) * i) / 64;
      points.push(`${x(hours).toFixed(1)} ${y(sunPosition(hours).elevation).toFixed(1)}`);
    }
    return `M${points.join(' L')}`;
  }, []);
  const { elevation } = sunPosition(value);
  const [zenith, horizon] = skyColors(elevation);
  const warm = Math.min(Math.max(1 - elevation / 18, 0), 1);
  const sunX = x(value), sunY = y(elevation);

  const set = (hours: number) => {
    const next = Math.min(Math.max(Math.round(hours / STEP) * STEP, MIN), MAX);
    if (Math.abs(next - value) > 1e-6) onChange(Number(next.toFixed(4)));
  };
  const fromPointer = (event: PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    set(MIN + ((event.clientX - rect.left) / rect.width) * (MAX - MIN));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    if (event.key === 'Home') set(MIN);
    else if (event.key === 'End') set(MAX);
    else if (keys[event.key]) set(value + keys[event.key] * (event.shiftKey ? 1 : 0.25));
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={ref}
      className="sun-time"
      role="slider"
      tabIndex={0}
      aria-label="Time of day"
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      aria-valuenow={value}
      aria-valuetext={formatSkyTime(value)}
      data-dragging={dragging || undefined}
      title="Drag to set the time of day; double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        fromPointer(e);
      }}
      onPointerMove={(e) => dragging && fromPointer(e)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={() => set(DEFAULT_SKY_TIME)}
      onKeyDown={onKeyDown}
    >
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2={HORIZON} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={zenith} />
            <stop offset="1" stopColor={horizon} />
          </linearGradient>
          <linearGradient id={`${id}-ground`} x1="0" y1={HORIZON} x2="0" y2={H} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#4a4038" />
            <stop offset="1" stopColor="#1f1c1a" />
          </linearGradient>
          <radialGradient id={`${id}-glow`}>
            <stop offset="0" stopColor={warm > 0.5 ? '#ffc58a' : '#fff4dc'} stopOpacity="0.85" />
            <stop offset="0.35" stopColor={warm > 0.5 ? '#ff9a5c' : '#ffe9c0'} stopOpacity="0.35" />
            <stop offset="1" stopColor="#ffe0b0" stopOpacity="0" />
          </radialGradient>
          <clipPath id={`${id}-above`}><rect width={W} height={HORIZON} /></clipPath>
        </defs>
        <rect width={W} height={HORIZON} fill={`url(#${id}-sky)`} />
        <g clipPath={`url(#${id}-above)`}>
          <path d={path} className="sun-time__path" />
          <circle cx={sunX} cy={sunY} r={30 + 14 * warm} fill={`url(#${id}-glow)`} />
          <circle cx={sunX} cy={sunY} r="6.5" className="sun-time__sun" style={{ fill: warm > 0.5 ? '#ffe2b8' : '#fffaf0' }} />
        </g>
        <rect y={HORIZON} width={W} height={H - HORIZON} fill={`url(#${id}-ground)`} />
        <line x1="0" x2={W} y1={HORIZON} y2={HORIZON} className="sun-time__horizon" />
        {[6, 12, 18].map((hours) => (
          <g key={hours} className="sun-time__tick">
            <line x1={x(hours)} x2={x(hours)} y1={HORIZON} y2={HORIZON + 4} />
            <text x={x(hours)} y={H - 9} textAnchor={hours === 6 ? 'start' : hours === 18 ? 'end' : 'middle'}
              dx={hours === 6 ? -4 : hours === 18 ? 4 : 0}>{hours}:00</text>
          </g>
        ))}
        <line x1={sunX} x2={sunX} y1={HORIZON} y2={H} className="sun-time__cursor" />
      </svg>
      <span className="sun-time__value mono">{formatSkyTime(value)}</span>
    </div>
  );
}
